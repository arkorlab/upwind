import { type InvalidationState, NEXT_ONE_YEAR_SECONDS } from '@stayingupwind/core/cache';

import { readWithin } from './body.ts';
import { nowMs } from './clock.ts';
import { isRegeneration, requestContext } from './context.ts';
import { nextWriteOrder, readData, type WriteOrder, writeData } from './data.ts';
import type { DataEntryMetadata } from './host.ts';
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

/** Invalidate `tags` at once, as `updateTag` does: in force for the next read anywhere, and here. */
export function invalidateNow(runtime: CacheRuntime, tags: readonly string[]): Promise<void> {
  return invalidate(runtime, tags, undefined);
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
 * A fetch cache value as a read judges it: the entry's metadata, the bytes, and what an
 * invalidation made of the entry, where the host said.
 */
interface HeldFetch {
  readonly entry: DataEntryMetadata;
  readonly bytes: Uint8Array;
  readonly invalidation?: InvalidationState | undefined;
}

/**
 * How long a write waits for the write of its key that was out when it was handed over. Past this
 * the earlier one is taken for lost — its request may have ended under it, and what a request that
 * has ended left out never settles in another — and the write goes regardless, so it may land
 * first. Should the earlier one land after it all the same, the host keeps the later of the two,
 * which this isolate sent after it (`DataWriteRequest.order`, `DataWritten.superseded`).
 */
const FETCH_WRITE_PATIENCE_MS = 5000;

/**
 * How long a write is taken to be out at the most: the time a request may go on for once it has
 * answered (`waitUntil`). A write whose request ended under it never settles here, and would
 * otherwise answer reads of its key, and hold its key's later writes back, for as long as the
 * isolate lives.
 */
const FETCH_WRITE_LIFETIME_MS = 30_000;

/**
 * How many keys' writes the isolate keeps track of at once. A host that answers no write, under
 * keys that are each fetched once, would otherwise have the table hold a write per key for as long
 * as the lifetime lets it — and past it, for a key nothing asks for again. Past this the oldest go:
 * their writes go on, and only their place in the order, and the reads they answer, are given up.
 * One that lands after a later write of its key is then not kept: the host keeps the write this
 * isolate sent later (`DataWritten.superseded`), as for a write that waited its patience out.
 */
const MAX_FETCH_WRITES = 512;

/**
 * How many bytes of the values writes carry the table keeps, as the data memo keeps what it read
 * within a budget of its own: a value may be tens of MiB, and the table's keys alone bound none of
 * that. Past it, the writes that have gone out let go of what they keep for reads, oldest first —
 * their requests hold it while they are in flight, and no longer — and a read of their keys asks
 * the host meanwhile. Then the writes still waiting to go are dropped, oldest first: a value of
 * their keys not kept, as when the host fails a write, rather than an isolate's memory spent on
 * what a stalled host holds back.
 */
const FETCH_WRITE_MIB = 8;
const FETCH_WRITE_BYTES = FETCH_WRITE_MIB * MIB;

/**
 * A write the fetch cache handed over: what it writes, when, where it stands among the writes this
 * isolate handed over (`nextWriteOrder`), the write of its key it goes after, whether it has gone
 * out, and a promise that settles as it is answered, has failed, or will not go. It lets its bytes
 * go once a newer write of its key takes its place before it went out, once the table lets go of
 * it — one that had yet to go then never goes — or once its bytes are past the budget.
 */
interface FetchWrite {
  readonly entry: DataEntryMetadata;
  bytes: Uint8Array | undefined;
  readonly handedAt: number;
  readonly order: WriteOrder;
  readonly after: Promise<void> | undefined;
  sent: boolean;
  settled: Promise<void> | undefined;
}

/**
 * The fetch cache's writes still out in this isolate: for each key, the last one handed over, which
 * is what a read of the key is answered with meanwhile (`get`), oldest first, and how many bytes of
 * their values the table keeps (`FETCH_WRITE_BYTES`). An entry leaves as its write settles, or once
 * it is older than a write can be out (`FETCH_WRITE_LIFETIME_MS`) — swept as any write is handed
 * over, whatever its key — or once `MAX_FETCH_WRITES` newer ones are kept.
 */
interface FetchWrites {
  readonly byKey: Map<string, FetchWrite>;
  held: number;
}

const fetchWrites = new WeakMap<CacheRuntime, FetchWrites>();

/**
 * A write's value no longer kept: what it keeps for reads, or, where it has yet to go, what it goes
 * with — it then never goes. Whether it was one that had yet to go.
 */
function letGo(writes: FetchWrites, write: FetchWrite): boolean {
  if (write.bytes === undefined) {
    return false;
  }
  writes.held -= write.bytes.byteLength;
  write.bytes = undefined;
  return !write.sent;
}

/**
 * Take a write out of the table, if it is still the key's, and let go of its value. One that had yet
 * to go never goes: a later write of the key, with nothing before it in the table, may be sent
 * first, and this one would land after it. Whether it was one.
 */
function forget(writes: FetchWrites, key: string, write: FetchWrite): boolean {
  if (writes.byKey.get(key) !== write) {
    return false;
  }
  writes.byKey.delete(key);
  return letGo(writes, write);
}

/** The key's write still out, if there is one: none handed over longer ago than a write can be. */
function writeOut(writes: FetchWrites, key: string): FetchWrite | undefined {
  const write = writes.byKey.get(key);
  if (write !== undefined && performance.now() - write.handedAt >= FETCH_WRITE_LIFETIME_MS) {
    forget(writes, key, write);
    return undefined;
  }
  return write;
}

/**
 * Let go of the writes handed over longer ago than a write can be out, and of the oldest beyond the
 * budget, before another is kept: a write that never settles never leaves on its own, and its key
 * may never be asked for again.
 */
function sweepWrites(runtime: CacheRuntime, writes: FetchWrites): void {
  const now = performance.now();
  for (const [key, write] of writes.byKey) {
    const lost = now - write.handedAt >= FETCH_WRITE_LIFETIME_MS;
    if (!lost && writes.byKey.size < MAX_FETCH_WRITES) {
      return;
    }
    // One past the lifetime was cut off with its request: nothing of it was going to go.
    const dropped = forget(writes, key, write);
    if (!lost && dropped) {
      runtime.log('fetch cache write dropped', { detail: 'waiting past the keys kept' });
    }
  }
}

/**
 * Keep no more of the values writes carry than the budget (`FETCH_WRITE_BYTES`): what the writes
 * gone out keep for reads first, and then the writes still waiting to go, which then never go.
 */
function trimWrites(runtime: CacheRuntime, writes: FetchWrites): void {
  for (const write of writes.byKey.values()) {
    if (writes.held <= FETCH_WRITE_BYTES) {
      return;
    }
    if (write.sent) {
      letGo(writes, write);
    }
  }
  for (const write of writes.byKey.values()) {
    if (writes.held <= FETCH_WRITE_BYTES) {
      return;
    }
    if (letGo(writes, write)) {
      runtime.log('fetch cache write dropped', { detail: 'waiting past the byte budget' });
    }
  }
}

/** What the key's write still out in this isolate carries, if there is one. */
function heldOut(runtime: CacheRuntime, key: string): HeldFetch | undefined {
  const writes = fetchWrites.get(runtime);
  const write = writes === undefined ? undefined : writeOut(writes, key);
  return write?.bytes === undefined ? undefined : { entry: write.entry, bytes: write.bytes };
}

function heldIn(memo: DataMemo): HeldFetch | undefined {
  return memo.kind === 'found'
    ? { entry: memo.response.entry, bytes: memo.bytes, invalidation: memo.response.invalidation }
    : undefined;
}

/** `promise` settled, or `ms` gone by, whichever is first. */
async function patiently(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Send a write once the one it goes after has settled, unless a newer one took its place. */
async function send(
  runtime: CacheRuntime,
  writes: FetchWrites,
  key: string,
  write: FetchWrite,
): Promise<void> {
  try {
    // Never rejects: a write that failed is logged below, and the next one goes on. With none
    // before it, the write takes the key's state before this first waits (`writeData`).
    if (write.after !== undefined) {
      await patiently(write.after, FETCH_WRITE_PATIENCE_MS);
    }
    const { bytes } = write;
    if (bytes === undefined) {
      return;
    }
    write.sent = true;
    trimWrites(runtime, writes);
    await writeData(runtime, { key, entry: write.entry, bytes, order: write.order });
  } catch (error) {
    // The render has its data; what failed is keeping it for the next one.
    runtime.log('fetch cache write failed', { detail: detail(error) });
  } finally {
    // A later write of the key, handed over meanwhile, keeps its place.
    forget(writes, key, write);
  }
}

/**
 * Write what a `fetch` answered, under the key and the entry its render gave it, once the write of
 * the key that is out has been answered.
 *
 * Next.js ordered a key's writes itself while it waited on them: a render's writes of one key ran
 * one after another (`cache-set-<key>`, in `createCachedDynamicResponse`), and its lock on the key
 * held a second render's until the first had landed. Both now let go as `set()` answers, which is
 * before the write lands; two writes of a key out at once would reach the host in whichever order
 * the network gave them. So a write goes out only once the one before it has been answered, and the
 * render waits on none of them. Where they cross all the same — one waited its patience out, or the
 * table let go of the one before it — the host keeps the one this isolate sent later, not the one
 * that landed last (`DataWritten.superseded`).
 *
 * At most one waits: a write handed over while another of its key is still waiting takes that one's
 * place, and the one it replaces never goes out. The host would keep the newer anyway, and a key
 * the host is slow to answer for, fetched again by every render that misses it meanwhile, would
 * otherwise hold every value those renders fetched until it did. Nor does one wait for long
 * (`FETCH_WRITE_PATIENCE_MS`), or for a write handed over longer ago than a write can be out
 * (`FETCH_WRITE_LIFETIME_MS`): the request a write is kept alive by may end under it, and a write
 * waiting on that one would never go.
 */
function keepFetch(
  runtime: CacheRuntime,
  key: string,
  entry: DataEntryMetadata,
  bytes: Uint8Array,
): Promise<void> {
  const writes = fetchWrites.get(runtime) ?? { byKey: new Map<string, FetchWrite>(), held: 0 };
  fetchWrites.set(runtime, writes);
  const previous = writeOut(writes, key);
  sweepWrites(runtime, writes);
  let after = previous?.settled;
  if (previous?.sent === false) {
    // It never went out: this one takes its place, behind the write it was waiting for.
    letGo(writes, previous);
    ({ after } = previous);
  }
  const write: FetchWrite = {
    entry,
    bytes,
    handedAt: performance.now(),
    order: nextWriteOrder(),
    after,
    sent: false,
    settled: undefined,
  };
  // Taken out before it is put back, so that the writes stand in the order they were handed over,
  // and the ones the sweep lets go of first are the oldest.
  if (previous !== undefined) {
    forget(writes, key, previous);
  }
  writes.byKey.set(key, write);
  writes.held += bytes.byteLength;
  write.settled = send(runtime, writes, key, write);
  trimWrites(runtime, writes);
  return write.settled;
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
 * and the host is not asked (`fetchWrites`). Next.js held such a read behind its lock on the key
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
    let held: HeldFetch | undefined;
    try {
      held =
        (isRegeneration() ? undefined : heldOut(runtime, cacheKey)) ??
        heldIn(await readData(runtime, { key: cacheKey, kind: DATA_FETCH }));
      if (held !== undefined) {
        await runtime.tags.syncLocal(
          runtime.host,
          [...held.entry.tags, ...(ctx.tags ?? []), ...(ctx.softTags ?? [])],
          now,
        );
      }
    } catch (error) {
      runtime.log('fetch cache read failed', { detail: detail(error) });
      return null;
    }
    if (held === undefined) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(held.bytes));
    } catch {
      return null;
    }
    if (!isFetchValue(value)) {
      return null;
    }
    const { entry } = held;
    const validity = recordValidity(runtime.tags, {
      tags: [...entry.tags, ...(ctx.tags ?? []), ...(ctx.softTags ?? [])],
      timestamp: entry.timestamp,
      invalidation: held.invalidation,
      now,
    });
    if (validity === 'expired' || (validity === 'stale' && isRegeneration())) {
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
   * be answered first (`keepFetch`); and the entry carries the moment the fetch began, by which the
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
      context.waitUntil(keepFetch(current.runtime, cacheKey, entry, bytes));
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
