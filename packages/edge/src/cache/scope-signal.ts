import { tagKindOf } from '@stayingupwind/core/cache';
import { SCOPE_REVISION_HEADER, scopeRevisionValue } from '@stayingupwind/core/paas';
import { readBoundedBody, releaseStream } from '@stayingupwind/core/util';
import type { ScopeSignals } from '@stayingupwind/host/cache';

import type { EdgeHost, ScopeSignalSource } from '../edge-host.ts';
import type { EdgeRuntime } from '../edge-runtime.ts';
import type { TagBound } from '../memory/invalidations.ts';
import { logWarn } from '../observability/logger.ts';
import { letGoOfInvalidated } from './condemned.ts';

/**
 * Where a scope stands, as every isolate of the edge comes to know it within a moment of an
 * invalidation, and what the Functions it hands a request to are told of it
 * (`SCOPE_REVISION_HEADER`).
 *
 * What an isolate reads of a scope — a record held, a data center's copy of one, KV's answer — can
 * be from before an invalidation for half a minute and more, and the at-once headers on a Function's
 * response reach only the isolate it passed through. So the authority is asked what moved
 * (`ScopeSignalSource`): where the scope stands and its recent invalidations (`ScopeSignals`), which
 * the isolate takes into what condemns a record (`memory/invalidations.ts`). The answer is kept as
 * the data center's copy in the Cache API, for its other isolates to take in without asking, and
 * each isolate looks at the copy at most once every `HOLD_MS`. The isolate that asks claims the
 * question for its data center first (`claimQuestion`): the others that find the copy gone or old
 * before the answer is kept leave the question to it, rather than each asking the same — though the
 * Cache API has no compare-and-set, so isolates that claim it in the same moment both ask.
 *
 * No request waits for a look. One begins as the request is routed, beside its reads, and what it
 * brings is in force as soon as it lands: for the request itself where it lands before a record is
 * judged or the request handed on, and for the requests after it otherwise — the trade a record
 * held past its hold makes, staleness bounded in requests rather than a wait before the first byte.
 *
 * How long a copy answers is what the host says (`ScopeSignals.announced`):
 *
 * - Where it purges the copies whenever the scope moves, a copy answers for an hour, and one that
 *   is gone is the purge: the authority is asked again. A copy is kept only from an answer that
 *   came within `KEEP_WITHIN_MS`, and taken away again where its write ended past it, so that a
 *   second purge — which a host that purges should make a couple of seconds after the first —
 *   takes away one that crossed the first. One older than `ANNOUNCED_FRESH_MS` still answers and
 *   is asked again too: a purge that did not get through, or a host that has stopped purging,
 *   whose copies still say it does, is made up for within that minute rather than the copy's hour.
 * - Where nothing purges them, which asks nothing of the account it runs on, a copy older than
 *   `POLLED_FRESH_MS` still answers and is asked again, by whichever isolate first finds it so: an
 *   invalidation is acted on within that moment and a round trip.
 */

/** How often an isolate looks at its data center's copy at most. */
const HOLD_MS = 250;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR;
/** How long a copy the host purges answers. */
const ANNOUNCED_KEEP_SECONDS = SECONDS_PER_HOUR;
/** How old a copy the host purges may be before it is asked again, behind the request. */
const ANNOUNCED_FRESH_MS = 60_000;
/** How long a copy nothing purges is kept at all: past `POLLED_FRESH_MS` it is asked again. */
const POLLED_KEEP_SECONDS = SECONDS_PER_MINUTE;
const POLLED_FRESH_MS = 2000;
/**
 * How long after its question went an answer is kept as the data center's copy: one that comes
 * later is taken in and not kept, and a copy whose write ends later is taken away again. Past it
 * the question's claim has lapsed (`CLAIM_MS`), and another isolate may have asked and kept a later
 * answer that this one's write would land over; and a copy from before an invalidation, written
 * after a host's second purge of it — a couple of seconds after the first — would answer with
 * what the purges took away for as long as a copy is kept.
 */
const KEEP_WITHIN_MS = 1000;
/** How long a look at the copy waits on the Cache API, its body included. */
const READ_MS = 50;
const KIB = 1024;
const MAX_COPY_KIB = 64;
/** The largest copy read: 64 invalidations and where the scope stands, with room to spare. */
const MAX_COPY_BYTES = MAX_COPY_KIB * KIB;
/** A question to the authority out longer than this is taken for lost, and another asked. */
const ASK_LIFETIME_MS = 10_000;
/**
 * How long an isolate that asks the authority has the question to itself in its data center
 * (`claimQuestion`): as long as an answer is kept from (`KEEP_WITHIN_MS`). Past it, one not answered
 * is asked again, by whichever isolate next finds the copy gone or old.
 */
export const CLAIM_MS = KEEP_WITHIN_MS;
/** How long the Cache API keeps a claim at all: past `CLAIM_MS`, in its whole seconds. */
const CLAIM_KEEP_SECONDS = 2;
/** When an isolate claimed the question, in its own clock. */
const CLAIMED_AT_HEADER = 'x-arkor-claimed-at';
/** What a claim this isolate made comes to: the question is its own to ask. */
const MINE = Symbol('the question is this isolate’s');
const KEPT_AT_HEADER = 'x-arkor-kept-at';
/** Where the scope stands as a copy says, read without its body. */
const REVISION_HEADER = 'x-arkor-revision';

/** What a look at the scope needs: the isolate's memory and clock, the host, and `waitUntil`. */
export interface ScopeLook {
  readonly runtime: EdgeRuntime;
  readonly host: EdgeHost;
  readonly waitUntil: (promise: Promise<void>) => void;
}

/** A question to the authority that is out: when it went, what it comes to, and which it is. */
interface Asking {
  readonly since: number;
  readonly answer: Promise<void>;
  readonly mark: symbol;
}

/** The questions each isolate has out, by scope: one at a time per scope. */
const asking = new WeakMap<EdgeRuntime, Map<string, Asking>>();

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signalKey(host: EdgeHost, scopeId: string): string {
  return `https://${host.names.cacheKeyHost}/scope-signals/${encodeURIComponent(scopeId)}`;
}

function claimKey(host: EdgeHost, scopeId: string): string {
  return `${signalKey(host, scopeId)}/claim`;
}

/**
 * Each of the application's tags among `tags` bound to its invalidation's revision: at once where
 * its window has ended by `now`, and with a window otherwise.
 */
function boundsOf(
  tags: ScopeSignals['tags'],
  now: number,
): { readonly atOnce: TagBound[]; readonly windowed: TagBound[] } {
  const atOnce: TagBound[] = [];
  const windowed: TagBound[] = [];
  for (const entry of tags) {
    // The application's own tags: a platform-delivery tag may carry the same value as one.
    if (entry.kind !== tagKindOf(entry.value)) {
      continue;
    }
    const bound = { tag: entry.value, revision: entry.revision };
    if (entry.hardExpireAt !== null && entry.hardExpireAt <= now) {
      atOnce.push(bound);
    } else {
      windowed.push(bound);
    }
  }
  return { atOnce, windowed };
}

/**
 * Take in what the authority says of the scope: each recent invalidation bound to its revision —
 * at once, or with a window — every tagged record before the scope's revision where more were made
 * than the answer holds, and where the scope stands. A record this isolate holds that is condemned
 * now is let go of, as one a response condemned is (`takeInvalidation`).
 */
function takeIn(runtime: EdgeRuntime, scopeId: string, signals: ScopeSignals): void {
  const now = runtime.now();
  const { memory } = runtime;
  const known = memory.scopes.get(scopeId);
  const { atOnce, windowed } = boundsOf(signals.tags, now);
  if (known !== undefined && signals.revision <= known.revision) {
    // Nothing new, but a window this isolate holds may have ended since it was taken in, which
    // nothing new comes to say: from its end on, what it reached is condemned at once — memory
    // keeps a window's revision, not its end (`InvalidationMemory`).
    const held = memory.invalidations.of(scopeId)?.tags;
    const ended = atOnce.filter(({ tag, revision }) => (held?.get(tag) ?? 0) < revision);
    if (ended.length > 0) {
      memory.invalidations.takeEach(scopeId, { atOnce: ended, windowed: [] });
      letGoOfInvalidated(memory, scopeId);
    }
    memory.scopes.set(scopeId, { ...known, checkedAt: now });
    return;
  }
  // Only what was invalidated is taken in: a scope taken in at all holds its members' absences off
  // for a while (`absencesHeldFrom`), which an answer that nothing moved must not do.
  if (atOnce.length > 0 || windowed.length > 0) {
    memory.invalidations.takeEach(scopeId, { atOnce, windowed });
  }
  if (signals.truncated) {
    memory.invalidations.take(scopeId, undefined, signals.revision);
  }
  if (atOnce.length > 0 || windowed.length > 0 || signals.truncated) {
    letGoOfInvalidated(memory, scopeId);
  }
  memory.scopes.set(scopeId, {
    revision: signals.revision,
    invalidatedAt: signals.invalidatedAt,
    checkedAt: now,
  });
}

/** The copies' cache's answer for `key`. */
async function lookUp(look: ScopeLook, key: string): Promise<Response | undefined> {
  const cache = await caches.open(look.host.names.signalCache);
  return cache.match(key);
}

/** Let go of what a lookup given up on answers with, once it does. */
async function releaseLate(lookup: Promise<Response | undefined>): Promise<void> {
  const late = await lookup;
  releaseStream(late?.body, 'a scope signal that came too late');
}

/**
 * What `lookup` answers within `ms`, or `undefined`: the Cache API can stall, and a look that does
 * not end holds the request's `waitUntil`. One that answers later is let go of unread.
 */
async function lookedUpWithin(
  lookup: Promise<Response | undefined>,
  ms: number,
): Promise<Response | undefined> {
  const late = Symbol('late');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      lookup,
      new Promise<typeof late>((resolve) => {
        timer = setTimeout(() => {
          resolve(late);
        }, ms);
      }),
    ]);
    if (answer !== late) {
      return answer;
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  void releaseLate(lookup).catch(() => {
    // A lookup that fails once the look has gone on without it is no longer the look's to report.
  });
  return undefined;
}

/** The data center's copy of the scope's signals, and when it was kept; none, or none in time. */
async function readCopy(
  look: ScopeLook,
  scopeId: string,
): Promise<{ readonly signals: ScopeSignals; readonly keptAt: number } | undefined> {
  const startedAt = Date.now();
  const hit = await lookedUpWithin(lookUp(look, signalKey(look.host, scopeId)), READ_MS);
  if (hit === undefined) {
    return undefined;
  }
  const keptAt = Number(hit.headers.get(KEPT_AT_HEADER));
  const left = READ_MS - (Date.now() - startedAt);
  if (!Number.isSafeInteger(keptAt) || keptAt <= 0 || left <= 0) {
    releaseStream(hit.body, 'a scope signal without its stamp, or too late to read');
    return undefined;
  }
  const body = await readBoundedBody(hit.body, {
    limit: MAX_COPY_BYTES,
    stallMs: left,
    budgetMs: left,
  });
  if (body.kind === 'over-limit') {
    releaseStream(body.body, 'a scope signal longer than any kept');
    return undefined;
  }
  return { signals: JSON.parse(new TextDecoder().decode(body.bytes)) as ScopeSignals, keptAt };
}

/**
 * Keep `signals` as the data center's copy, asked for at `since`, unless the copy there says the
 * scope stands later already — an answer that took long can come back after a later one was kept —
 * or `KEEP_WITHIN_MS` has gone by; and take it away again where the write ends past that. The Cache
 * API has no compare-and-set, so two writes in the same moment can still cross.
 */
async function keepCopy(
  look: ScopeLook,
  source: ScopeSignalSource,
  answer: { readonly scopeId: string; readonly signals: ScopeSignals; readonly since: number },
): Promise<void> {
  const { scopeId, signals, since } = answer;
  const cache = await caches.open(look.host.names.signalCache);
  const keepSeconds = signals.announced ? ANNOUNCED_KEEP_SECONDS : POLLED_KEEP_SECONDS;
  const copy = Response.json(signals, {
    headers: {
      'cache-control': `max-age=${String(keepSeconds)}`,
      'cache-tag': source.cacheTagOf(scopeId),
      [KEPT_AT_HEADER]: String(Date.now()),
      [REVISION_HEADER]: String(signals.revision),
    },
  });
  const key = signalKey(look.host, scopeId);
  const standing = await cache.match(key);
  releaseStream(standing?.body, 'a scope signal looked at for its revision');
  const later = Number(standing?.headers.get(REVISION_HEADER));
  if (
    (Number.isSafeInteger(later) && later > signals.revision) ||
    performance.now() - since > KEEP_WITHIN_MS
  ) {
    return;
  }
  await cache.put(key, copy);
  if (performance.now() - since > KEEP_WITHIN_MS) {
    await cache.delete(key);
  }
}

/**
 * Claim the scope's question for this isolate where no isolate of the data center claimed it within
 * `CLAIM_MS`: `MINE`, or when the claim that stands lapses. The claim is a marker beside the copy,
 * and carries the scope's purge tag as a copy does, so that a purge — the scope moved again — lets
 * the next isolate that looks ask at once.
 */
async function claimQuestion(
  look: ScopeLook,
  source: ScopeSignalSource,
  scopeId: string,
): Promise<number | typeof MINE> {
  const cache = await caches.open(look.host.names.signalCache);
  const key = claimKey(look.host, scopeId);
  const standing = await cache.match(key);
  releaseStream(standing?.body, 'a scope signal claim looked at');
  const now = Date.now();
  const claimedAt = Number(standing?.headers.get(CLAIMED_AT_HEADER));
  if (Number.isSafeInteger(claimedAt) && claimedAt > 0 && now - claimedAt < CLAIM_MS) {
    return claimedAt + CLAIM_MS;
  }
  const claim = new Response('', {
    headers: {
      'cache-control': `max-age=${String(CLAIM_KEEP_SECONDS)}`,
      'cache-tag': source.cacheTagOf(scopeId),
      [CLAIMED_AT_HEADER]: String(now),
    },
  });
  await cache.put(key, claim);
  return MINE;
}

/**
 * `claimQuestion`, or `MINE` where it could not be read or made within `READ_MS`: a claim only
 * spares the authority questions, and one that cannot be made is no reason to ask none. Never
 * rejects.
 */
async function claimed(
  look: ScopeLook,
  source: ScopeSignalSource,
  scopeId: string,
): Promise<number | typeof MINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      claimQuestion(look, source, scopeId),
      new Promise<typeof MINE>((resolve) => {
        timer = setTimeout(() => {
          resolve(MINE);
        }, READ_MS);
      }),
    ]);
  } catch (error) {
    logWarn('scope signal claim not made', { scopeId, detail: errorDetail(error) });
    return MINE;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Ask the authority what moved in the scope, take the answer in, and keep it as the data center's
 * copy where it came within `KEEP_WITHIN_MS`. Never rejects: what it could not do, it logs.
 */
async function ask(
  look: ScopeLook,
  source: ScopeSignalSource,
  scopeId: string,
  since: number,
): Promise<void> {
  try {
    const signals = await source.scopeSignals(scopeId, null);
    takeIn(look.runtime, scopeId, signals);
    if (performance.now() - since <= KEEP_WITHIN_MS) {
      await keepCopy(look, source, { scopeId, signals, since });
    }
  } catch (error) {
    logWarn('scope signals not read', { scopeId, detail: errorDetail(error) });
  }
}

/**
 * `ask`, one question at a time per scope in an isolate, joined while it is out and younger than
 * `ASK_LIFETIME_MS` — and none where another isolate of the data center has claimed the question
 * (`claimQuestion`), until its claim lapses. Never rejects.
 */
function askAuthority(look: ScopeLook, source: ScopeSignalSource, scopeId: string): Promise<void> {
  const { claimedElsewhere } = look.runtime.memory;
  const lapses = claimedElsewhere.get(scopeId);
  if (lapses !== undefined && Date.now() < lapses) {
    return Promise.resolve();
  }
  const out = asking.get(look.runtime) ?? new Map<string, Asking>();
  asking.set(look.runtime, out);
  const joined = out.get(scopeId);
  const since = performance.now();
  if (joined !== undefined && since - joined.since < ASK_LIFETIME_MS) {
    return joined.answer;
  }
  const mark = Symbol('asking');
  // Its place is given up once it has settled, which is after it has been taken: `ask` is awaited.
  const answer = (async (): Promise<void> => {
    try {
      const claim = await claimed(look, source, scopeId);
      if (claim === MINE) {
        await ask(look, source, scopeId, since);
      } else {
        // Another isolate's question: its answer is the copy this one takes in once it is kept.
        claimedElsewhere.set(scopeId, claim);
      }
    } finally {
      if (out.get(scopeId)?.mark === mark) {
        out.delete(scopeId);
      }
    }
  })();
  out.set(scopeId, { since, answer, mark });
  look.waitUntil(answer);
  return answer;
}

/** Ask behind the request: `askAuthority` hands its question to `waitUntil` itself. */
function askBehind(look: ScopeLook, source: ScopeSignalSource, scopeId: string): void {
  void askAuthority(look, source, scopeId).catch(() => {
    // It never rejects: what it could not do it logged.
  });
}

/**
 * Bring this isolate's knowledge of the scope up to its data center's copy, and ask the authority
 * behind where the copy is gone, or a moment old — a minute, where the host purges it. Nothing
 * waits for it, and nothing where the host keeps no signals (`EdgeHost.scopeSignals`). Never
 * rejects.
 */
export async function lookAtScope(look: ScopeLook, scopeId: string): Promise<void> {
  const source = look.host.scopeSignals;
  if (source === undefined) {
    return;
  }
  const { runtime } = look;
  const known = runtime.memory.scopes.get(scopeId);
  if (known !== undefined && runtime.now() - known.checkedAt < HOLD_MS) {
    return;
  }
  try {
    const copy = await readCopy(look, scopeId);
    if (copy === undefined) {
      askBehind(look, source, scopeId);
      return;
    }
    takeIn(runtime, scopeId, copy.signals);
    const freshFor = copy.signals.announced ? ANNOUNCED_FRESH_MS : POLLED_FRESH_MS;
    if (Date.now() - copy.keptAt >= freshFor) {
      askBehind(look, source, scopeId);
    }
  } catch (error) {
    // What the isolate knew stands: the request is judged as it would have been without signals.
    logWarn('scope signals not looked at', { scopeId, detail: errorDetail(error) });
  }
}

/**
 * `request` as it goes to the scope's Functions, told where the scope stands as this isolate last
 * found it (`SCOPE_REVISION_HEADER`); as it is where the isolate knows nothing of the scope.
 */
export function withScopeRevision(
  runtime: EdgeRuntime,
  scopeId: string,
  request: Request,
): Request {
  const known = runtime.memory.scopes.get(scopeId);
  if (known === undefined) {
    return request;
  }
  const headers = new Headers(request.headers);
  headers.set(SCOPE_REVISION_HEADER, scopeRevisionValue(known));
  return new Request(request, { headers });
}
