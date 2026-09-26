import { NEXT_ONE_YEAR_SECONDS } from '@stayingupwind/core/cache';

import { readWithin } from './body.ts';
import { nowMs } from './clock.ts';
import { isRegeneration, requestContext } from './context.ts';
import { readData, writeData } from './data.ts';
import type { CacheRuntime, DataMemo } from './runtime.ts';
import { recordValidity } from './tags.ts';

/**
 * The cache handlers Next.js runs its data caches through, installed on the global symbol Next.js
 * reads them from (`@next/cache-handlers`): the fetch cache, and the `use cache` handlers for the
 * `default` and `remote` kinds. Each keeps its entries in the deployment's scope through the
 * host, judges them against the tags this isolate has synced, and remembers what it read for
 * one hold so a render that reads the same key twice asks once.
 *
 * The handlers are module singletons because Next.js instantiates them once per process; what
 * they reach is configured per request (`configureCacheHandlers`), since the bindings arrive
 * with the request and a Function without a cache must still render.
 */

const FETCH_KIND = 'FETCH';
const USE_CACHE = 'data:use-cache';
const DATA_FETCH = 'data:fetch';
const KIB = 1024;
const MIB = KIB * KIB;
const MAX_VALUE_MIB = 25;
/** A `use cache` value is read whole before it is stored; past this it is not stored at all. */
const MAX_VALUE_BYTES = MAX_VALUE_MIB * MIB;
/** Next.js's own signal to its `use cache` wrapper that an entry must be revalidated now. */
const REVALIDATE_NOW = -1;

interface HandlerRuntime {
  readonly runtime: CacheRuntime;
}

const state: { current: HandlerRuntime | undefined } = { current: undefined };

/** Point the handlers at the runtime the request was given; none turns them into misses. */
export function configureCacheHandlers(runtime: CacheRuntime | undefined): void {
  state.current = runtime === undefined ? undefined : { runtime };
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function invalidate(
  runtime: CacheRuntime,
  tags: readonly string[],
  durations: { expire?: number } | undefined,
): Promise<void> {
  if (tags.length === 0) {
    return;
  }
  const now = nowMs();
  // `updateTag`, and `revalidateTag` without a window, take effect at once.
  const expire = durations?.expire ?? 0;
  const outcome = await runtime.host.invalidate({
    tags,
    ...(expire > 0 && { expire }),
    api: durations === undefined ? 'updateTag' : 'revalidateTag',
  });
  // In force here at once: the request that invalidated must not read what it invalidated, nor
  // may the next one in this isolate, before the delta says so.
  for (const invalidation of outcome.invalidations) {
    runtime.tags.applyLocal([invalidation.value], {
      // The request may have read cache data while the invalidation call was in flight.
      staleAt: Math.max(now, invalidation.staleAt),
      // The deadline by this isolate's clock too, whichever comes first: a host whose clock
      // runs ahead must not leave an `updateTag` servable here, as stale, until this clock catches
      // up with it.
      hardExpireAt:
        invalidation.hardExpireAt === null
          ? null
          : Math.min(
              invalidation.hardExpireAt,
              now + Math.max(0, invalidation.hardExpireAt - invalidation.staleAt),
            ),
    });
  }
}

/** Both lists as one, in order, without repeats. */
function mergeTags(first: readonly string[] | undefined, second: readonly string[] | undefined) {
  const tags = new Set(first);
  if (second !== undefined) {
    for (const tag of second) {
      tags.add(tag);
    }
  }
  return [...tags];
}

// ---- the fetch cache ------------------------------------------------------------------------

interface CachedFetchValue {
  readonly kind: typeof FETCH_KIND;
  readonly data: unknown;
  readonly tags?: string[] | undefined;
  readonly revalidate: number;
}

interface FetchGetContext {
  readonly kind: string;
  readonly tags?: string[] | undefined;
  readonly softTags?: string[] | undefined;
}

interface FetchSetContext {
  readonly fetchCache?: boolean | undefined;
  readonly tags?: string[] | undefined;
}

function isFetchValue(value: unknown): value is CachedFetchValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === FETCH_KIND &&
    typeof (value as { revalidate?: unknown }).revalidate === 'number'
  );
}

/**
 * Next.js's incremental cache handler for `fetch`: what `IncrementalCache` instantiates when the
 * global symbol names a `FetchCache`. A value is the JSON Next.js hands over, stored whole; a
 * read is answered with the moment it was made, from which Next.js judges its age, and with a
 * moment of zero when a tag made it stale, so Next.js serves it and fetches again behind.
 *
 * Except to a regeneration (`isRegeneration`), which misses a value a tag made stale. Next.js
 * hands an `unstable_cache` value it was told is stale to whatever render reads it, and computes
 * it again only behind, so the page regenerated for a `revalidateTag` was the page as it was, with
 * the value the tag was revalidated for — and a `fetch` one fared the same (`non-ascii-cache-tags`).
 * Next.js's own platform tells the render which tags were revalidated
 * (`x-next-revalidated-tags`), and `IncrementalCache` misses those tags' entries for it; a miss
 * here is that, for the tags that made this entry stale.
 */
export class PlatformFetchCache {
  // Next.js constructs it with its own context (fs, dev, revalidatedTags, …); none of it applies
  // here, and none is taken.

  async get(
    cacheKey: string,
    ctx: FetchGetContext,
  ): Promise<{ value: CachedFetchValue; lastModified: number } | null> {
    const current = state.current;
    if (current === undefined || ctx.kind !== FETCH_KIND) {
      return null;
    }
    const { runtime } = current;
    const now = nowMs();
    const context = requestContext();
    if (context !== undefined && !context.fetchStarts.has(cacheKey)) {
      context.fetchStarts.set(cacheKey, now);
    }
    let memo: DataMemo;
    try {
      memo = await readData(runtime, { key: cacheKey, kind: DATA_FETCH });
      if (memo.kind === 'found') {
        await runtime.tags.syncLocal(
          runtime.host,
          [...memo.response.entry.tags, ...(ctx.tags ?? []), ...(ctx.softTags ?? [])],
          now,
        );
      }
    } catch (error) {
      runtime.log('fetch cache read failed', { detail: detail(error) });
      return null;
    }
    if (memo.kind === 'missing') {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(memo.bytes));
    } catch {
      return null;
    }
    if (!isFetchValue(value)) {
      return null;
    }
    const { entry } = memo.response;
    const validity = recordValidity(runtime.tags, {
      tags: [...entry.tags, ...(ctx.tags ?? []), ...(ctx.softTags ?? [])],
      timestamp: entry.timestamp,
      invalidation: memo.response.invalidation,
      now,
    });
    if (validity === 'expired' || (validity === 'stale' && isRegeneration())) {
      return null;
    }
    return { value, lastModified: validity === 'stale' ? 0 : entry.timestamp };
  }

  async set(cacheKey: string, data: CachedFetchValue | null, ctx: FetchSetContext): Promise<void> {
    const current = state.current;
    if (current === undefined || data === null || ctx.fetchCache !== true) {
      return;
    }
    const { runtime } = current;
    const context = requestContext();
    // A result fetched before an invalidation must keep that age when its body finishes.
    // The host fences a write against its current tag marks by this timestamp.
    const startedAt = context?.fetchStarts.get(cacheKey) ?? context?.startedAt;
    if (startedAt === undefined) {
      return;
    }
    try {
      await writeData(runtime, {
        key: cacheKey,
        entry: {
          kind: DATA_FETCH,
          tags: mergeTags(data.tags, ctx.tags),
          stale: 0,
          timestamp: startedAt,
          expire: NEXT_ONE_YEAR_SECONDS,
          revalidate: data.revalidate,
        },
        bytes: new TextEncoder().encode(JSON.stringify(data)),
      });
    } catch (error) {
      // The render has its data; what failed is keeping it for the next one.
      runtime.log('fetch cache write failed', { detail: detail(error) });
    }
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    const current = state.current;
    if (current === undefined) {
      return;
    }
    await invalidate(current.runtime, typeof tags === 'string' ? [tags] : tags, durations);
  }

  resetRequestCache(): void {
    // The memo is time-bounded rather than request-bound; there is nothing to reset.
  }
}

// ---- the `use cache` handlers -----------------------------------------------------------------

/** Next.js's `CacheEntry` for a `use cache` handler. */
interface UseCacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

export interface UseCacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}

async function getUseCache(
  runtime: CacheRuntime,
  kind: string,
  cacheKey: string,
  softTags: string[],
): Promise<UseCacheEntry | undefined> {
  const now = nowMs();
  const memo = await readData(runtime, { key: cacheKey, kind: USE_CACHE, handler: kind });
  if (memo.kind === 'missing') {
    return undefined;
  }
  const { entry } = memo.response;
  await runtime.tags.syncLocal(runtime.host, [...entry.tags, ...softTags], now);
  const validity = recordValidity(runtime.tags, {
    tags: [...entry.tags, ...softTags],
    timestamp: entry.timestamp,
    invalidation: memo.response.invalidation,
    now,
  });
  if (validity === 'expired') {
    return undefined;
  }
  return {
    value: new Blob([memo.bytes as BlobPart]).stream(),
    tags: [...entry.tags],
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: validity === 'stale' ? REVALIDATE_NOW : entry.revalidate,
  };
}

async function setUseCache(
  runtime: CacheRuntime,
  kind: string,
  cacheKey: string,
  pendingEntry: Promise<UseCacheEntry>,
): Promise<void> {
  const entry = await pendingEntry;
  // As Next.js's own handler does: the wrapper serves one branch while the other is stored, and
  // an entry that expires at once is dynamic, never served from a store.
  const [served, stored] = entry.value.tee();
  entry.value = served;
  if (entry.expire === 0) {
    await stored.cancel();
    return;
  }
  const bytes = await readWithin(stored, MAX_VALUE_BYTES);
  if (bytes === undefined) {
    runtime.log('use cache value not stored: too large', { key: cacheKey });
    return;
  }
  await writeData(runtime, {
    key: cacheKey,
    entry: {
      kind: USE_CACHE,
      handler: kind,
      tags: [...entry.tags],
      stale: entry.stale,
      timestamp: entry.timestamp,
      expire: entry.expire,
      revalidate: entry.revalidate,
    },
    bytes,
  });
}

/** The `use cache` handler of one kind (`default`, `remote`), reading and writing the same scope. */
export function useCacheHandler(kind: string): UseCacheHandler {
  const withRuntime = async <T>(
    fallback: T,
    work: (runtime: CacheRuntime) => Promise<T>,
    what: string,
  ): Promise<T> => {
    const current = state.current;
    if (current === undefined) {
      return fallback;
    }
    try {
      return await work(current.runtime);
    } catch (error) {
      current.runtime.log(`use cache ${what} failed`, { kind, detail: detail(error) });
      return fallback;
    }
  };
  return {
    get: (cacheKey, softTags) =>
      withRuntime(undefined, (runtime) => getUseCache(runtime, kind, cacheKey, softTags), 'read'),
    set: (cacheKey, pendingEntry) => {
      const store = (runtime: CacheRuntime): Promise<void> =>
        setUseCache(runtime, kind, cacheKey, pendingEntry);
      return withRuntime(undefined, store, 'write');
    },
    // Next awaits this hook before get(). Check only the relevant tags in get/getExpiration,
    // through what the host answers a read with. Regeneration separately forces a full sync.
    refreshTags: () => Promise.resolve(),
    getExpiration: (tags) => {
      const latestStaleAt = async (runtime: CacheRuntime): Promise<number> => {
        await runtime.tags.syncLocal(runtime.host, tags, nowMs());
        return runtime.tags.staleAtOf(tags);
      };
      return withRuntime(0, latestStaleAt, 'expiration');
    },
    updateTags: async (tags, durations) => {
      const current = state.current;
      if (current === undefined) {
        return;
      }
      await invalidate(current.runtime, tags, durations);
    },
  };
}
