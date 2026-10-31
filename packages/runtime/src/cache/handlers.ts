import { NEXT_ONE_YEAR_SECONDS, type Validity } from '@stayingupwind/core/cache';
import {
  DEFAULT_D1_CACHE_TAG,
  type FunctionEnv,
  isPrimaryResourceRead,
  publishedD1BindingCount,
  publishedFunctionEnv,
} from '@stayingupwind/core/paas';
import { releaseStream } from '@stayingupwind/core/util';

import { readWithin } from './body.ts';
import { nowMs } from './clock.ts';
import {
  hasResourceReceipt,
  isCapture,
  isRegeneration,
  type RequestContext,
  requestContext,
} from './context.ts';
import { readData, writeData } from './data.ts';
import { heldIn, laterIfAny } from './held-reads.ts';
import { judgedStaleAt, judgedValidity } from './held-tags.ts';
import {
  heldOut,
  type HeldValue,
  type HeldWrites,
  keepWrite,
  tableOf,
  writesIn,
} from './held-writes.ts';
import type { DataEntryMetadata, InvalidateOutcome, InvalidateRequest } from './host.ts';
import * as ownMarks from './own-marks.ts';
import {
  reusePublication,
  mergeTags,
  publicationReadable,
  observeFreshPublication,
} from './publication.ts';
import {
  fetchedAgainBehind,
  holdForRevalidation,
  revalidated,
  useCacheStore,
} from './revalidations.ts';
import type { CacheRuntime } from './runtime.ts';
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

/**
 * Invalidate `tags` — at once, as `updateTag` and `revalidateTag` without a window do, or within the
 * window `durations` names — in force in this isolate before the host is asked
 * (`TagState.applyLocal`), at the moment the request puts it in force at (`own-marks.ts`), which the
 * host is told (`InvalidateRequest.inForceAt`). What the host answers stands for the mark here once
 * it comes; a call it fails leaves the mark in force all the same, and fails.
 */
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
  // The moment the request puts it in force at: no earlier than what it stamped before, and before
  // what it computes from here on (`own-marks.ts`).
  const at = ownMarks.markIn(requestContext(), now);
  // In force here before the host has answered: a read in this isolate while the call is out must
  // not be answered with what is being invalidated. What the host answers stands for it below. At
  // once means by the clock, which the moment can be ahead of.
  const call = runtime.tags.applyLocal(tags, {
    staleAt: at,
    hardExpireAt: expire > 0 ? at + expire * MS_PER_SECOND : now,
  });
  const asked: InvalidateRequest = {
    tags,
    ...(expire > 0 && { expire }),
    api: durations === undefined ? 'updateTag' : 'revalidateTag',
    // When it was put in force here: a host may record it then rather than once it has the call.
    inForceAt: at,
  };
  let outcome: InvalidateOutcome;
  try {
    outcome = await ownMarks.onceClockPasses(at, now, () => runtime.host.invalidate(asked));
  } catch (error) {
    // In force here all the same, and known at no revision: the host may never have recorded it.
    runtime.tags.settleLocal(call);
    throw error;
  }
  if (expire === 0) {
    // And on the response, to the edge: the next request may be one it answers from what it holds.
    requestContext()?.invalidated.add(tags, outcome.revision);
  }
  // In force here at once: the request that invalidated must not read what it invalidated, nor
  // may the next one in this isolate, before the delta says so.
  runtime.tags.answerLocal(call, outcome, now);
}

/** Invalidate `tags` at once, as `updateTag` does: in force for the next read anywhere, and here. */
export function invalidateNow(runtime: CacheRuntime, tags: readonly string[]): Promise<void> {
  return invalidate(runtime, tags, undefined);
}

/**
 * The invalidations each request has asked for in the turn under way, by what they invalidate.
 *
 * Next.js hands every `updateTag` and `revalidateTag` to each cache handler it has, in one turn —
 * the `default` and `remote` `use cache` handlers and the fetch cache (`revalidateTags`, in
 * `server/revalidation-utils.ts`) — and all three are this module's, over one host. Each made its
 * own call for the same invalidation: three calls to the host where one does. The first of a turn
 * now goes, and the others asked for in that turn are handed what it comes to.
 *
 * Only within a request, and only within the turn. A request's response tells the edge what that
 * request invalidated (`RequestContext.invalidated`), which only its own call puts there. And the
 * same tags asked for in a later turn are invalidated at a later moment, whether or not the call
 * before is still out: the request goes on while it is (`invalidateOnce`) — a Server Action's
 * render, and what Next.js runs behind it (`after`) — and an invalidation joined to a call the host
 * may have recorded already would stand at that call's moment, before the change it was asked for.
 */
const invalidationsAsked = new WeakMap<RequestContext, Map<string, Promise<void>>>();

/**
 * Invalidate `tags`, as Next.js asks a handler to, once however many of the handlers it asks in the
 * turn (`invalidationsAsked`), and never as a failure of the request that asked.
 *
 * The request has already done what the invalidation is for — a Server Action has written what it
 * changed — and an invalidation the host could not record failed the action with it: an error over
 * a change that was made, which the person who made it is invited to make again. It is logged
 * instead. What it would have made stale is stale in this isolate all the same (`invalidate`), and
 * elsewhere as it was before the call: until the host records another invalidation of its tags, or
 * the entries expire.
 *
 * Within a request, a handler answers once the invalidation is in force in this isolate, not once
 * the host has recorded it. Next.js renders a Server Action's page only once every handler has
 * answered (`executeActionAndPrepareForRender`, in `app-render/action-handler.ts`), and a host's
 * record can take a while — the changes queued ahead of it, the records it rewrites before it
 * answers — all of which the action's response waited for before its render began. The render runs
 * in this isolate, whose reads judge what they find against the mark the call put in force at once
 * (`TagState.applyLocal`), so it misses what the invalidation made stale however far the host has
 * got; what the host says stands for the mark once it answers.
 *
 * The request's response is not answered before the host has recorded the call all the same — not
 * its first byte either, for no longer than `INVALIDATIONS_RECORDED_WITHIN_MS` (`InvalidatedTags`):
 * the render and the record go on side by side, and the response waits for the later of the two.
 * Whoever made the request moves on once its headers come: a request made then was answered — here
 * or in any other isolate — before the host had recorded the invalidation, and what it fetched
 * meanwhile was written as made before it, which the host condemned by that invalidation and the
 * next read fetched again. Next.js runs a route handler's revalidations behind its response
 * (`pendingWaitUntil`, in `app-route/module.ts`), which waits for them the same way. Recorded
 * within the bound, the invalidation is told to the edge on the response, at the revision the host
 * recorded it at (`withInvalidatedTags`); past it, the response goes without it, and the call goes
 * on in `waitUntil`.
 *
 * A regeneration's handler still answers once the host has, as no response is held for its call
 * (`answeredFor`); so does one asked outside any request, with neither a response to hold nor a
 * `waitUntil` to keep the call going.
 *
 * Nothing at all for a capture's render (`asCapture`), which keeps nothing: what it would
 * invalidate stands as it was, here and at the host.
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
  if (effectiveTags.length === 0 || isCapture()) return Promise.resolve();
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
  const turn = invalidationsAsked.get(context) ?? new Map<string, Promise<void>>();
  invalidationsAsked.set(context, turn);
  const joined = turn.get(asked);
  if (joined !== undefined) {
    return answeredFor(context, joined);
  }
  // In force here before this returns: `invalidate` applies the mark before it first waits.
  const call = invalidateLogged(runtime, effectiveTags, durations);
  turn.set(asked, call);
  // Gone with the turn: every handler Next.js asks for one invalidation is asked within it.
  queueMicrotask(() => {
    turn.delete(asked);
  });
  // Kept going past the response, as a write is (`PlatformFetchCache.set`): one the host has not
  // answered by the time the response is (`INVALIDATIONS_RECORDED_WITHIN_MS`) is still recorded.
  try {
    context.waitUntil(call);
  } catch {
    // A host whose invocation has ended takes nothing more on; the call goes on as far as it can.
  }
  return answeredFor(context, call);
}

/**
 * What a handler handed `call` answers with (`invalidateOnce`): at once, with the request's response
 * held for the call instead (`InvalidatedTags.hold`). A regeneration's is the call itself: its
 * response served what was there before, as for its writes, and is held for nothing.
 */
function answeredFor(context: RequestContext, call: Promise<void>): Promise<void> {
  if (isRegeneration()) {
    return call;
  }
  context.invalidated.hold(call);
  return Promise.resolve();
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
  /** The `fetch`'s own, or the `unstable_cache` call's: what `IncrementalCache` judges age by. */
  readonly revalidate?: number | false | undefined;
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
 * keeps. A regeneration takes only a write its own render handed over, and asks the host whatever
 * else is out (`heldOut`, `PlatformFetchCache`).
 */
async function fetchHeld(runtime: CacheRuntime, cacheKey: string): Promise<HeldValue | undefined> {
  const out = isPrimaryResourceRead()
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
 * Not for a regeneration, which asks the host — but for the writes its own render handed over
 * (`heldOut`). What the host says of the entry — an invalidation it holds against the write, fenced
 * by the moment the fetch began — reaches this isolate only with the write's answer, and a
 * regeneration renders what the host will keep; its own write is what it already rendered.
 */
export class PlatformFetchCache {
  // Next.js constructs it with its own context (fs, dev, revalidatedTags, …); none of it applies
  // here, and none is taken.

  /**
   * What a read of `cacheKey` finds, judged against the tags it is asked under and the entry's own:
   * a value to serve, fresh, or stale with a moment of zero for Next.js to fetch it again behind;
   * `null` for a miss and for what may not be served. When the read began is kept for the write that
   * may follow it (`fetchStarts`), past the request's own invalidations (`own-marks.ts`).
   */
  async get(
    cacheKey: string,
    ctx: FetchGetContext,
  ): Promise<{ value: CachedFetchValue; lastModified: number } | null> {
    if (ctx.kind !== FETCH_KIND) return null;
    // Dynamic fetches can return streaming bytes before set runs behind their cloned body.
    observeFreshPublication(mergeTags(ctx.tags, ctx.softTags), nowMs());
    const current = state.current;
    if (current === undefined) return null;
    const { runtime } = current;
    const now = nowMs();
    const context = requestContext();
    if (context !== undefined && !context.fetchStarts.has(cacheKey)) {
      // Past the request's own invalidations put in force before it (`own-marks.ts`).
      context.fetchStarts.set(cacheKey, ownMarks.stampedAfterMarks(context, now));
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
    if (!publicationReadable(runtime, held, now)) return null;
    const judge = async (value: HeldValue): Promise<Validity> => {
      await runtime.tags.syncLocal(runtime.host, value.entry.tags, now);
      return judgedValidity(runtime.tags, {
        tags: [...value.entry.tags, ...(ctx.tags ?? []), ...(ctx.softTags ?? [])],
        timestamp: value.entry.timestamp,
        invalidation: value.invalidation,
        now,
      });
    };
    let judged: { readonly held: HeldValue; readonly validity: Validity } | undefined;
    try {
      judged = await laterIfAny(
        runtime,
        { key: cacheKey, kind: DATA_FETCH },
        { held, validity: await judge(held) },
        { judge, reread: () => fetchHeld(runtime, cacheKey) },
      );
    } catch (error) {
      runtime.log('fetch cache read failed', { detail: detail(error) });
      return null;
    }
    if (judged === undefined) {
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
    // Aged as `IncrementalCache` will age it, once this has answered: after the reads above.
    if (fetchedAgainBehind(validity, nowMs() - entry.timestamp, ctx.revalidate, value.revalidate)) {
      holdForRevalidation(runtime, FETCH_STORE, cacheKey);
    }
    if (!reusePublication(entry.tags, nowMs(), runtime.host.publication)) return null;
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
   *
   * A capture's render (`asCapture`) keeps nothing, and writes nothing here: what it fetched is in
   * its resume data cache, as for any prerender, which is where its reads and its resume find it.
   */
  set(cacheKey: string, data: CachedFetchValue | null, ctx: FetchSetContext): Promise<void> {
    const current = state.current;
    const context = requestContext();
    if (context === undefined || data === null || ctx.fetchCache !== true) {
      return Promise.resolve();
    }
    try {
      const tags = mergeTags(data.tags, ctx.tags);
      observeFreshPublication(tags, nowMs());
      if (current === undefined || isCapture()) return Promise.resolve();
      const entry: DataEntryMetadata = {
        kind: DATA_FETCH,
        tags,
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
      revalidated(current.runtime, FETCH_STORE, cacheKey, write);
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

/**
 * What a read of the `use cache` handler of `kind` finds of `cacheKey`, judged against the soft tags
 * it is asked under and the entry's own: the entry as Next.js takes it, marked to be computed again
 * where it is stale, or nothing for a miss and for what may not be served. The read is noted for the
 * value it may begin (`useCacheReadBegan`).
 */
async function getUseCache(
  runtime: CacheRuntime,
  kind: string,
  cacheKey: string,
  softTags: string[],
): Promise<UseCacheEntry | undefined> {
  const now = nowMs();
  ownMarks.useCacheReadBegan(requestContext(), kind, cacheKey);
  // The soft tags — the route's own — are known before the entry is: they are brought up to date
  // while the value is read, and the entry's own tags once it has been.
  const [held] = await Promise.all([
    useCacheHeld(runtime, kind, cacheKey),
    runtime.tags.syncLocal(runtime.host, [...softTags, ...knownResourceTags()], now),
  ]);
  if (!publicationReadable(runtime, held, now)) return undefined;
  const judge = async (value: HeldValue): Promise<Validity> => {
    await runtime.tags.syncLocal(runtime.host, value.entry.tags, now);
    return judgedValidity(runtime.tags, {
      tags: [...value.entry.tags, ...softTags],
      timestamp: value.entry.timestamp,
      invalidation: value.invalidation,
      now,
    });
  };
  const request = { key: cacheKey, kind: USE_CACHE, handler: kind } as const;
  const weighing = { judge, reread: () => useCacheHeld(runtime, kind, cacheKey) };
  const judged = await laterIfAny(
    runtime,
    request,
    { held, validity: await judge(held) },
    weighing,
  );
  if (judged === undefined) return undefined;
  const { entry } = judged.held;
  const { validity } = judged;
  const ageMs = nowMs() - entry.timestamp;
  // Next's built-in default and remote handlers miss strictly after revalidate in production.
  if (
    validity === 'expired' ||
    (validity === 'stale' && (isRegeneration() || isPrimaryResourceRead())) ||
    ageMs > entry.revalidate * MS_PER_SECOND
  ) {
    return undefined;
  }
  if (validity === 'stale' && ageMs <= entry.expire * MS_PER_SECOND) {
    holdForRevalidation(runtime, useCacheStore(kind), cacheKey);
  }
  if (!reusePublication(entry.tags, nowMs(), runtime.host.publication)) return undefined;
  return {
    value: new Blob([judged.held.bytes as BlobPart]).stream(),
    tags: [...entry.tags],
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: validity === 'stale' ? REVALIDATE_NOW : entry.revalidate,
  };
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
  // What the write came to, told once it is known (`revalidated`, below): the requests held for the
  // key — those answered stale while the entry was collected among them — go once it has landed.
  const written = Promise.withResolvers<unknown>();
  try {
    const entry = await pendingEntry;
    // Next.js keeps its own render copy: this stream belongs to the handler alone. An entry that
    // expires at once is dynamic, never served from a store, and a capture's render keeps nothing
    // (`asCapture`). Its cancellation must not wait for another branch held by the wrapper to
    // finish, or requests joining this write cannot proceed.
    if (entry.expire === 0 || isCapture()) {
      releaseStream(entry.value, 'use cache value not stored');
      return;
    }
    const bytes = await readWithin(entry.value, MAX_VALUE_BYTES);
    if (bytes === undefined) {
      runtime.log('use cache value not stored: too large', { key: cacheKey });
      return;
    }
    const metadata: DataEntryMetadata = {
      kind: USE_CACHE,
      handler: kind,
      tags: [...entry.tags],
      stale: entry.stale,
      // Past the request's own invalidations put in force before its first read (`own-marks.ts`).
      timestamp: ownMarks.useCacheStamp(context, kind, cacheKey, entry.timestamp),
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
    written.resolve(write);
  } finally {
    // Nothing written — an entry that expires at once, one too large, or one that failed on the
    // way — is nothing to wait for. Once the write has been handed over, this changes nothing; what
    // it settles with is read by nobody.
    behind?.landed.resolve(false);
    written.resolve(false);
    revalidated(runtime, useCacheStore(kind), cacheKey, written.promise);
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
        return judgedStaleAt(runtime.tags, tags);
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
