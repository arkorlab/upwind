import { NEXT_ONE_YEAR_SECONDS, type Validity } from '@stayingupwind/core/cache';
import {
  DEFAULT_D1_CACHE_TAG,
  type FunctionEnv,
  isPrimaryResourceRead,
  publishedD1BindingCount,
  publishedFunctionEnv,
} from '@stayingupwind/core/paas';

import { readWithin } from './body.ts';
import { nowMs } from './clock.ts';
import {
  hasResourceReceipt,
  isRegeneration,
  type RequestContext,
  requestContext,
} from './context.ts';
import { readData, writeData } from './data.ts';
import { heldIn, laterIfAny } from './held-reads.ts';
import {
  heldOut,
  type HeldValue,
  type HeldWrites,
  keepWrite,
  tableOf,
  writesIn,
} from './held-writes.ts';
import type { DataEntryMetadata } from './host.ts';
import type { CacheRuntime } from './runtime.ts';
import { recordValidity } from './tags.ts';
import { callsBehind, callsWaitedOn } from './turns.ts';

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
const MS_PER_SECOND = 1000;
/** Next.js's own signal to its `use cache` wrapper that an entry must be revalidated now. */
const REVALIDATE_NOW = -1;

interface HandlerRuntime {
  readonly runtime: CacheRuntime;
}

const state: { current: HandlerRuntime | undefined } = { current: undefined };
const resourceTagHints = new WeakMap<FunctionEnv, readonly string[]>();

function knownResourceTags(): readonly string[] {
  const env = publishedFunctionEnv();
  if (env === undefined) return [];
  const held = resourceTagHints.get(env);
  if (held !== undefined) return held;
  const tags = publishedD1BindingCount(env) === 1 ? [DEFAULT_D1_CACHE_TAG] : [];
  resourceTagHints.set(env, tags);
  return tags;
}

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
  // In force here before the host has answered: a read in this isolate while the call is out must
  // not be answered with what is being invalidated. What the host answers replaces it below.
  runtime.tags.applyLocal(tags, {
    staleAt: now,
    hardExpireAt: expire > 0 ? now + expire * MS_PER_SECOND : now,
  });
  const outcome = await runtime.host.invalidate({
    tags,
    ...(expire > 0 && { expire }),
    api: durations === undefined ? 'updateTag' : 'revalidateTag',
  });
  if (expire === 0) {
    // And on the response, to the edge: the next request may be one it answers from what it holds.
    requestContext()?.invalidated.add(tags, outcome.revision);
  }
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

/** Invalidate `tags` at once, as `updateTag` does: in force for the next read anywhere, and here. */
export function invalidateNow(runtime: CacheRuntime, tags: readonly string[]): Promise<void> {
  return invalidate(runtime, tags, undefined);
}

/**
 * The invalidations each request has out with the host, by what they invalidate.
 *
 * Next.js hands every `updateTag` and `revalidateTag` to each cache handler it has, in one turn —
 * the `default` and `remote` `use cache` handlers and the fetch cache (`revalidateTags`, in
 * `server/revalidation-utils.ts`) — and all three are this module's, over one host. Each made its
 * own call for the same invalidation: three calls to the host where one does. The first now goes,
 * and the others asked for while it is out are handed what it comes to — whether Next.js asks them
 * in the same turn, as it does, or a turn later.
 *
 * Only within a request, and only while the call is out. A request's response tells the edge what
 * that request invalidated (`RequestContext.invalidated`), which only its own call puts there; and
 * the same tags invalidated again once the call has been answered are invalidated at a later moment.
 */
const invalidationsOut = new WeakMap<RequestContext, Map<string, Promise<void>>>();

/**
 * Invalidate `tags`, as Next.js asks a handler to, once however many of the handlers it asks while
 * the call is out (`invalidationsOut`), and never as a failure of the request that asked.
 *
 * The request has already done what the invalidation is for — a Server Action has written what it
 * changed — and an invalidation the host could not record failed the action with it: an error over
 * a change that was made, which the person who made it is invited to make again. It is logged
 * instead. What it would have made stale is stale in this isolate all the same (`invalidate`), and
 * elsewhere as it was before the call: until the host records another invalidation of its tags, or
 * the entries expire.
 */
function invalidateOnce(
  runtime: CacheRuntime,
  tags: readonly string[],
  durations: { expire?: number } | undefined,
): Promise<void> {
  const context = requestContext();
  const effectiveTags =
    context !== undefined && durations?.expire === NEXT_ONE_YEAR_SECONDS
      ? tags.filter((tag) => tag !== DEFAULT_D1_CACHE_TAG || !hasResourceReceipt(context, tag))
      : tags;
  if (effectiveTags.length === 0) return Promise.resolve();
  if (context === undefined) {
    return invalidateLogged(runtime, effectiveTags, durations);
  }
  // Whether it is `updateTag`'s, and the window, beside the tags in one order whatever order they
  // were named in.
  const asked = JSON.stringify([
    durations === undefined,
    durations?.expire ?? 0,
    [...new Set(effectiveTags)].toSorted((a, b) => a.localeCompare(b)),
  ]);
  const out = invalidationsOut.get(context) ?? new Map<string, Promise<void>>();
  invalidationsOut.set(context, out);
  const pending = out.get(asked);
  if (pending !== undefined) {
    return pending;
  }
  const call = whileOut(out, asked, invalidateLogged(runtime, effectiveTags, durations));
  out.set(asked, call);
  return call;
}

/** `call`, kept under `asked` until it has been answered. */
async function whileOut(
  out: Map<string, Promise<void>>,
  asked: string,
  call: Promise<void>,
): Promise<void> {
  try {
    await call;
  } finally {
    out.delete(asked);
  }
}

async function invalidateLogged(
  runtime: CacheRuntime,
  tags: readonly string[],
  durations: { expire?: number } | undefined,
): Promise<void> {
  try {
    await invalidate(runtime, tags, durations);
  } catch (error) {
    runtime.log('tag invalidation failed', { tags: tags.join(' '), detail: detail(error) });
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

/** The store the fetch cache's writes are kept track of under (`held-writes.ts`). */
const FETCH_STORE = 'fetch';

/** The fetch cache's table of writes still out in this runtime (`keepWrite`). */
function fetchWrites(runtime: CacheRuntime): HeldWrites {
  // Behind the render, in the request's turns for the calls behind its work
  // (`CALLS_BEHIND_AT_ONCE`): a render's writes, one for each `fetch` it made, would otherwise
  // take every call a Function may have out.
  return tableOf(runtime, FETCH_STORE, 'fetch cache', callsBehind);
}

/**
 * What a read of a fetch key finds in this isolate: the write of it still out, or what the host
 * keeps. A regeneration asks the host whatever is out (`PlatformFetchCache`).
 */
async function fetchHeld(runtime: CacheRuntime, cacheKey: string): Promise<HeldValue | undefined> {
  const out =
    isRegeneration() || isPrimaryResourceRead()
      ? undefined
      : heldOut(writesIn(runtime, FETCH_STORE), cacheKey);
  return out ?? heldIn(await readData(runtime, { key: cacheKey, kind: DATA_FETCH }));
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
 *
 * A key with a write of this isolate's still out is answered with the value that write carries,
 * and the host is not asked (`keepWrite`). Next.js held such a read behind its lock on the key
 * until the write had landed, and the read then found that value; the lock lets go as `set`
 * answers now, which is before the write lands, and the host would answer with what the write
 * replaces, or with nothing. The value is judged against the tags like any other, so an
 * invalidation this isolate has made or learned of since the fetch began still makes it stale.
 *
 * Not for a regeneration, which asks the host. What the host says of the entry — an invalidation it
 * holds against the write, fenced by the moment the fetch began — reaches this isolate only with
 * the write's answer, and a regeneration renders what the host will keep.
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
    let held: HeldValue | undefined;
    try {
      // The tags the read is asked under are known before the entry is: they are brought up to
      // date while the value is read, and the entry's own once it has been (`judge`).
      [held] = await Promise.all([
        fetchHeld(runtime, cacheKey),
        runtime.tags.syncLocal(runtime.host, [...(ctx.tags ?? []), ...(ctx.softTags ?? [])], now),
      ]);
    } catch (error) {
      runtime.log('fetch cache read failed', { detail: detail(error) });
      return null;
    }
    if (held === undefined) {
      return null;
    }
    const judge = async (value: HeldValue): Promise<Validity> => {
      await runtime.tags.syncLocal(runtime.host, value.entry.tags, now);
      return recordValidity(runtime.tags, {
        tags: [...value.entry.tags, ...(ctx.tags ?? []), ...(ctx.softTags ?? [])],
        timestamp: value.entry.timestamp,
        invalidation: value.invalidation,
        now,
      });
    };
    let judged: { readonly held: HeldValue; readonly validity: Validity };
    try {
      judged = await laterIfAny(
        runtime,
        { key: cacheKey, kind: DATA_FETCH },
        { held, validity: await judge(held) },
        judge,
      );
    } catch (error) {
      runtime.log('fetch cache read failed', { detail: detail(error) });
      return null;
    }
    const { entry } = judged.held;
    const { validity } = judged;
    if (
      validity === 'expired' ||
      (validity === 'stale' && (isRegeneration() || isPrimaryResourceRead()))
    ) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(judged.held.bytes));
    } catch {
      return null;
    }
    if (!isFetchValue(value)) {
      return null;
    }
    return { value, lastModified: validity === 'stale' ? 0 : entry.timestamp };
  }

  /**
   * Start keeping what a `fetch` answered, and answer at once: the write goes on behind the render
   * that fetched it, in the request's `waitUntil`.
   *
   * Where Next.js prerenders a Cache Components page — every regeneration of one, and the render a
   * visitor waits on when its entry has expired or has none (the `prerender`, `prerender-client`,
   * `prerender-runtime` and `validation-client` work units) — it hands the render the response a
   * `fetch` got only once this has answered (`createCachedPrerenderResponse`, in
   * `server/lib/patch-fetch.ts`). A write awaited here would put a round trip to wherever the host
   * keeps its entries in front of the render, once for every value the page fetched. Any other
   * render writes behind its response already, and what Next.js registers for that write
   * (`fetch-cache-writes.ts`) settles as this answers — so the write is handed to `waitUntil` here,
   * and nothing ends the request's work under it.
   *
   * Nothing after the render needs the write to have landed. A prerender has the value in its
   * resume data cache before Next.js calls this (`IncrementalCache.set`): a later read of the key
   * in the same render is answered from there, and so is the resume of what the render postponed,
   * whose state carries that cache. A generation is committed against the tag revision its render
   * synced, not against anything here. And the write is ordered without the render waiting on it:
   * with no other write of the key out, `writeData` takes the key's state, fences the reads under
   * way and forgets what was remembered before this answers; with one out, it waits for that one to
   * be answered first (`keepWrite`); and the entry carries the moment the fetch began, by which the
   * host fences the write.
   *
   * A read of the key in this isolate while the write is out — Next.js lets one past its lock on
   * the key as this answers, where it held it until the write had landed — is answered with the
   * value the write carries (`get`), without a trip to the host. A read in any other isolate is
   * answered with what was there before, as it always was.
   */
  set(cacheKey: string, data: CachedFetchValue | null, ctx: FetchSetContext): Promise<void> {
    const current = state.current;
    const context = requestContext();
    if (
      current === undefined ||
      context === undefined ||
      data === null ||
      ctx.fetchCache !== true
    ) {
      return Promise.resolve();
    }
    try {
      const entry: DataEntryMetadata = {
        kind: DATA_FETCH,
        tags: mergeTags(data.tags, ctx.tags),
        stale: 0,
        // A result fetched before an invalidation must keep that age when its body finishes.
        // The host fences a write against its current tag marks by this timestamp.
        timestamp: context.fetchStarts.get(cacheKey) ?? context.startedAt,
        expire: NEXT_ONE_YEAR_SECONDS,
        revalidate: data.revalidate,
      };
      const bytes = new TextEncoder().encode(JSON.stringify(data));
      const write = keepWrite(current.runtime, fetchWrites(current.runtime), {
        key: cacheKey,
        entry,
        bytes,
      });
      context.waitUntil(write);
      // And the end of the response waits for it (`RequestWrites`), the first byte not — save a
      // regeneration's, made behind a response that served what was there before.
      if (!isRegeneration()) {
        context.writes.add(write);
      }
      return Promise.resolve();
    } catch (error) {
      // A promise either way, as when this was async: a host whose `waitUntil` throws once its
      // invocation has ended fails the call, not the caller's frame.
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    const current = state.current;
    if (current === undefined) {
      return;
    }
    await invalidateOnce(current.runtime, typeof tags === 'string' ? [tags] : tags, durations);
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
  // The soft tags — the route's own — are known before the entry is: they are brought up to date
  // while the value is read, and the entry's own tags once it has been.
  const [held] = await Promise.all([
    useCacheHeld(runtime, kind, cacheKey),
    runtime.tags.syncLocal(runtime.host, [...softTags, ...knownResourceTags()], now),
  ]);
  if (held === undefined) {
    return undefined;
  }
  const judge = async (value: HeldValue): Promise<Validity> => {
    await runtime.tags.syncLocal(runtime.host, value.entry.tags, now);
    return recordValidity(runtime.tags, {
      tags: [...value.entry.tags, ...softTags],
      timestamp: value.entry.timestamp,
      invalidation: value.invalidation,
      now,
    });
  };
  const judged = await laterIfAny(
    runtime,
    { key: cacheKey, kind: USE_CACHE, handler: kind },
    { held, validity: await judge(held) },
    judge,
  );
  const { entry } = judged.held;
  const { validity } = judged;
  // A regeneration must rebuild from fresh data even when Next's request store permits SWR.
  if (
    validity === 'expired' ||
    (validity === 'stale' && (isRegeneration() || isPrimaryResourceRead()))
  ) {
    return undefined;
  }
  return {
    value: new Blob([judged.held.bytes as BlobPart]).stream(),
    tags: [...entry.tags],
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: validity === 'stale' ? REVALIDATE_NOW : entry.revalidate,
  };
}

/** The store a `use cache` handler's writes are kept track of under, apart from the other's. */
function useCacheStore(kind: string): string {
  return `use cache:${kind}`;
}

/**
 * A `use cache` handler's table of writes still out in this runtime (`keepWrite`). Ahead of the
 * calls behind the render (`callsWaitedOn`): what the render fetched can wait behind it, and no
 * other isolate has the value until it has landed.
 */
function useCacheWrites(runtime: CacheRuntime, kind: string): HeldWrites {
  return tableOf(runtime, useCacheStore(kind), 'use cache', callsWaitedOn);
}

/**
 * What a read of a `use cache` key finds in this isolate: the write of it still out — handed over
 * by a render that has answered, and carrying its value — or what the host keeps. A regeneration
 * asks the host whatever is out, as the fetch cache's does (`PlatformFetchCache`).
 */
async function useCacheHeld(
  runtime: CacheRuntime,
  kind: string,
  cacheKey: string,
): Promise<HeldValue | undefined> {
  const out =
    isRegeneration() || isPrimaryResourceRead()
      ? undefined
      : heldOut(writesIn(runtime, useCacheStore(kind)), cacheKey);
  return out ?? heldIn(await readData(runtime, { key: cacheKey, kind: USE_CACHE, handler: kind }));
}

/**
 * Keep what a `use cache` function returned, and answer once the value is held here rather than
 * once the host has it.
 *
 * Next.js holds a request that joined another's invocation of the function until this answers
 * (`createCachedEntry`, in `use-cache-wrapper.ts`), and then reads the key again: a write awaited
 * here put a round trip to wherever the host keeps its entries in front of every request that
 * joined. So the value is read whole, kept in this isolate's table of writes still out — which is
 * what a read of the key here is answered with until the host has it (`useCacheHeld`) — and its
 * write handed to the request's `waitUntil`, ordered behind any write of the key still out
 * (`keepWrite`). A read in any other isolate is answered with what was there before, as it was
 * while the write was awaited — until the write has landed, which the request's response does not
 * end before unless it takes longer than the response waits (`RequestWrites`,
 * `WRITES_LAND_WITHIN_MS`): a request made once that response was read whole finds the value.
 *
 * A regeneration still waits for its write: its render commits what it made, and the request it
 * runs in waits on nobody. So does a write made outside any request, with no `waitUntil` to keep it.
 */
async function setUseCache(
  runtime: CacheRuntime,
  kind: string,
  cacheKey: string,
  pendingEntry: Promise<UseCacheEntry>,
): Promise<void> {
  const context = requestContext();
  // The end of the response waits for the write (`RequestWrites`), the first byte not — from the
  // moment Next.js hands the entry over rather than once its write starts: the value is read whole
  // first, and the response could otherwise end while it is.
  const behind =
    context === undefined || isRegeneration() || isPrimaryResourceRead()
      ? undefined
      : { context, landed: Promise.withResolvers<unknown>() };
  behind?.context.writes.add(behind.landed.promise);
  try {
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
    const metadata: DataEntryMetadata = {
      kind: USE_CACHE,
      handler: kind,
      tags: [...entry.tags],
      stale: entry.stale,
      timestamp: entry.timestamp,
      expire: entry.expire,
      revalidate: entry.revalidate,
    };
    if (behind === undefined) {
      await writeData(runtime, { key: cacheKey, entry: metadata, bytes }, callsWaitedOn());
      return;
    }
    const write = keepWrite(runtime, useCacheWrites(runtime, kind), {
      key: cacheKey,
      entry: metadata,
      bytes,
    });
    behind.context.waitUntil(write);
    behind.landed.resolve(write);
  } finally {
    // Nothing written — an entry that expires at once, one too large, or one that failed on the
    // way — is nothing to wait for. Once the write has been handed over, this changes nothing; what
    // it settles with is read by nobody.
    behind?.landed.resolve(false);
  }
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
      await invalidateOnce(current.runtime, tags, durations);
    },
  };
}
