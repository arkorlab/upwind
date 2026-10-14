import type { AppRuntime, ProjectManifest } from '@stayingupwind/core/manifest';
import type { EdgePointer } from '@stayingupwind/host/delivery';

import type { EdgeBindings } from '../bindings.ts';
import type { EdgeRuntime } from '../edge-runtime.ts';
import { type HeldPointer, routeSuspectKey } from '../memory/caches.ts';
import { logWarn } from '../observability/logger.ts';
import { getManifest, getPolicy } from './manifest.ts';
import { type HoldRefresh, type Lookup, lookup, MISSING } from './storage.ts';

export const EDGE_MODE: EdgePointer['mode'] = 'edge';

/** A pointer read from KV as the request found it: cold, waited on before the answer. */
interface ColdPointerRead<P extends EdgePointer> {
  readonly key: string;
  /** `null` where KV held no pointer under the key, or none that parses. */
  readonly pointer: P | null;
  readonly kvMs: number;
}

/** A refresh of a pointer served past its TTL, read behind the answer, as it landed. */
interface StalePointerRead<P extends EdgePointer> {
  readonly key: string;
  readonly served: HeldPointer<P>;
  readonly fresh: P | null;
  /** How long before the request KV gave the answer it was served. */
  readonly ageMs: number;
  readonly kvMs: number;
}

/** What a host is told of the live reads of its pointers, each with what it tagged the read with. */
interface PointerReadObserver<P extends EdgePointer, T> {
  cold(tag: T, read: ColdPointerRead<P>): void;
  stale(tag: T, read: StalePointerRead<P>): Promise<void> | void;
}

/**
 * The pointer a host stores, as the edge reads it: the edge's own fields, and whatever the host
 * stamps beside them (`edgePointerSchema`). One kind per isolate — its pointers are held in one
 * memory, and the kind that read an entry is the one that reads it back.
 */
export interface PointerKind<P extends EdgePointer, T> {
  /** What KV holds, as a pointer of this kind; `undefined` for one that does not parse. */
  parse(raw: unknown): P | undefined;
  /**
   * Whether a refreshed pointer is adopted at once for a field of the host's own, beside the
   * edge's own reasons (`adoptedAtOnce`): pure, and asked only when a read lands.
   */
  adoptedAtOnce?(served: P | null, next: P): boolean;
  /** Told of each live read (`LiveRead.observer`), the cold ones before the answer. */
  readonly observer?: PointerReadObserver<P, T> | undefined;
}

/** KV edge cache for the pointer; the isolate cache in front of it lasts 10 s. */
const POINTER_KV_CACHE_TTL_SECONDS = 30;

/** What memory holds, as the kind that wrote it reads it back (`PointerKind`). */
function fromMemory<P extends EdgePointer>(held: HeldPointer): Lookup<P> {
  return held.pointer === null ? MISSING : { kind: 'found', value: held.pointer as P };
}

/**
 * Hold that nothing is published under `key`, apart from the pointers that are: a stream of made-up
 * hostnames fills the small cache of absences, never the one real projects are served from.
 */
function holdAbsent(runtime: EdgeRuntime, key: string): Lookup<never> {
  runtime.memory.pointers.delete(key);
  runtime.memory.absentPointers.set(key, true);
  return MISSING;
}

/**
 * How a live request reads: an expired pointer is served while KV is read behind the answer
 * (`holdRefresh`), and the read is reported to the kind's observer with `observer`, whatever the
 * host tags its reads with. A read without one — a host's own, waited on — waits for KV.
 */
export interface LiveRead<T> {
  readonly holdRefresh: HoldRefresh;
  readonly observer?: T | undefined;
}

/**
 * One key's read, as the functions below pass it along: whatever tags the host's reads carry, the
 * kind is told them as they came.
 */
interface KeyRead<P extends EdgePointer> {
  readonly kind: PointerKind<P, unknown>;
  readonly env: EdgeBindings;
  readonly runtime: EdgeRuntime;
  readonly key: string;
}

/** KV under `key` plus parse; a malformed pointer is `missing`. */
async function readPointer<P extends EdgePointer>({
  kind,
  env,
  key,
}: KeyRead<P>): Promise<Lookup<P>> {
  const raw = await lookup('pointer', { key }, async () => {
    const stored: unknown = await env.EDGE_STATE.get(key, {
      type: 'json',
      cacheTtl: POINTER_KV_CACHE_TTL_SECONDS,
    });
    return stored ?? undefined;
  });
  if (raw.kind !== 'found') {
    return raw;
  }
  const parsed = kind.parse(raw.value);
  if (parsed === undefined) {
    logWarn('invalid active pointer', { key });
    return MISSING;
  }
  return { kind: 'found', value: parsed };
}

/** A read of a pointer, and when KV answered it: what how old it is when served is measured from. */
interface Answered<P extends EdgePointer = EdgePointer> {
  readonly read: Lookup<P>;
  readonly readAt: number;
}

async function answeredRead<P extends EdgePointer>(at: KeyRead<P>): Promise<Answered<P>> {
  const read = await readPointer(at);
  return { read, readAt: at.runtime.now() };
}

/** One key's reads out in an isolate, and what they have come to. */
interface KeyReads {
  /** The tickets of the reads sent and not landed yet. */
  readonly out: Set<number>;
  /** The ticket of the last read adopted: no read sent before it is adopted after it. */
  adopted: number;
  /**
   * A definite read that landed while a read sent after it was still out: adopted once every such
   * read has landed without a definite answer, and dropped as soon as one of them has one.
   */
  parked: { readonly ticket: number; readonly answered: Answered } | undefined;
  /**
   * Reads that have answered and wait on their read ahead before they are adopted (`refreshPointer`),
   * by ticket: what each answered, judged against the pointer it was served. Judged again whenever
   * another read is adopted (`adoptWarmingSafety`), since the pointer held has moved since.
   */
  readonly warming: Map<number, Answered>;
}

/** The reads of pointers out in one isolate. */
interface ReadsOut {
  readonly keys: Map<string, KeyReads>;
  /** How many reads have been sent: the ticket of the latest. */
  sent: number;
}

/**
 * The reads of each pointer this isolate sent, for the keys with a read still out, by the cache
 * the reads are adopted into (one per runtime).
 *
 * A read is adopted unless a read sent after it has been, or is still out. A refresh whose read
 * ahead outlasts the hold lets the next stale request send one of its own, and either may land
 * first; the later one went out later, so what it read is at least as new, and it is the one adopted
 * whichever lands first — when it reads anything. A later read that cannot reach KV leaves the
 * earlier its say: it is adopted when it lands, or as the later fails if it landed first. The value
 * held cannot tell two reads apart: refreshes of a missing pointer all replace the same `null`, and
 * a deleted project's pointer, read by one refresh before the deletion, must not come back after a
 * later one found it gone.
 *
 * And a read is adopted only while it is out: one given up on (`MAX_READS_OUT_PER_KEY`), one
 * forgotten with the list, and one of a key whose reads were all let go of since it went — whose
 * next read begins the key's list afresh, which knows nothing of it — are let go of where they land.
 */
const readsOut = new WeakMap<EdgeRuntime['memory']['pointers'], ReadsOut>();
/**
 * More keys with a read out than an isolate ever has at once. A read that never settles — its
 * request's time ran out — leaves its key listed, so the list is emptied at this size, which only
 * lets the reads still out land without being adopted.
 */
const MAX_KEYS_WITH_A_READ_OUT = 1024;
/**
 * More reads of one key out at once than an isolate ever has: one goes out per pointer TTL, and none
 * lives past its request's time behind the response. A read that never settles — its read ahead
 * stalled until that time ran out — leaves its ticket out, one more each TTL, so past this the
 * oldest are given up on: let go of, and not adopted should they land after all.
 */
const MAX_READS_OUT_PER_KEY = 8;

/** The ticket of a read of `key` about to go out, the latest sent for it. */
function sendRead(runtime: EdgeRuntime, key: string): number {
  let out = readsOut.get(runtime.memory.pointers);
  if (out === undefined) {
    out = { keys: new Map(), sent: 0 };
    readsOut.set(runtime.memory.pointers, out);
  } else if (out.keys.size >= MAX_KEYS_WITH_A_READ_OUT) {
    out.keys.clear();
  }
  out.sent += 1;
  const reads = out.keys.get(key) ?? {
    out: new Set<number>(),
    adopted: 0,
    parked: undefined,
    warming: new Map<number, Answered>(),
  };
  // Oldest first: tickets are added as they are sent.
  for (const ticket of reads.out) {
    if (reads.out.size < MAX_READS_OUT_PER_KEY) {
      break;
    }
    reads.out.delete(ticket);
    reads.warming.delete(ticket);
  }
  reads.out.add(out.sent);
  out.keys.set(key, reads);
  return out.sent;
}

/** The reads of `key` this isolate has out, if any. */
function readsOf(runtime: EdgeRuntime, key: string): KeyReads | undefined {
  return readsOut.get(runtime.memory.pointers)?.keys.get(key);
}

/**
 * How many reads of `key` this isolate keeps: those out, and those waiting on their read ahead
 * (`refreshPointer`). Never more than `MAX_READS_OUT_PER_KEY`, however many of them never settle.
 */
export function pointerReadsOut(runtime: EdgeRuntime, key: string): number {
  const reads = readsOf(runtime, key);
  if (reads === undefined) {
    return 0;
  }
  let kept = reads.out.size;
  for (const ticket of reads.warming.keys()) {
    if (!reads.out.has(ticket)) {
      kept += 1;
    }
  }
  return kept;
}

/** Whether a read of the key sent after `ticket` is still out. */
function laterOut(reads: KeyReads, ticket: number): boolean {
  return [...reads.out].some((sent) => sent > ticket);
}

/**
 * What a definite read found, held in isolate memory: a pointer among the pointers, and an absence
 * apart from them (`holdAbsent`), so that a stream of made-up hostnames fills the small cache of
 * absences, never the one real projects are served from.
 */
function hold(runtime: EdgeRuntime, key: string, { read, readAt }: Answered): void {
  if (read.kind === 'found') {
    runtime.memory.absentPointers.delete(key);
    runtime.memory.pointers.set(key, { pointer: read.value, readAt });
  } else {
    holdAbsent(runtime, key);
  }
}

/**
 * Whether a definite read is a safety that takes effect at once, ahead of a later read still out:
 * an absence — a project deleted, a hostname given up, which is all that stops either serving — and
 * a pointer that serves from the edge no more, or that is adopted at once over the one held
 * (`adoptedAtOnce`). Parked behind a later read that stalls, the pointer held went on serving what it
 * stops. The later read still has its say when it lands: it went out later, and it is adopted over
 * this one whatever it found.
 */
function takesEffectAtOnce(at: KeyRead<EdgePointer>, read: Lookup<EdgePointer>): boolean {
  if (read.kind !== 'found') {
    return read.kind === 'missing';
  }
  const { kind, runtime, key } = at;
  const held = runtime.memory.pointers.peek(key)?.value.pointer ?? null;
  return read.value.mode !== 'edge' || adoptedAtOnce(kind, held, read.value, runtime.now());
}

/** A read that landed, or a failed one that gives a parked read its say (`readsOut`). */
function settle(
  at: KeyRead<EdgePointer>,
  reads: KeyReads,
  landed: { readonly ticket: number; readonly answered: Answered },
): void {
  const definite = landed.answered.read.kind !== 'unavailable';
  // Not over a parked read that went out after it: that one is newer, whatever this one found.
  const newest = reads.parked === undefined || reads.parked.ticket < landed.ticket;
  const atOnce = definite && newest && takesEffectAtOnce(at, landed.answered.read);
  if (definite && !atOnce && laterOut(reads, landed.ticket)) {
    if (newest) {
      reads.parked = landed;
    }
    return;
  }
  const chosen = definite ? landed : reads.parked;
  if (chosen === undefined || (!atOnce && laterOut(reads, chosen.ticket))) {
    return;
  }
  hold(at.runtime, at.key, chosen.answered);
  reads.adopted = chosen.ticket;
  reads.parked = undefined;
  adoptWarmingSafety(at, reads);
}

/**
 * A newer read waiting on its read ahead whose pointer is a safety against the one just held — the
 * protection an older refresh took off, put back — adopted now rather than once its read ahead is
 * done, which may stall: it was judged against the pointer held as it landed (`refreshPointer`), and
 * the pointer held has moved since. The newest such read wins; it is adopted as it would have been.
 */
function adoptWarmingSafety(at: KeyRead<EdgePointer>, reads: KeyReads): void {
  const newerFirst = [...reads.warming]
    .filter(([ticket]) => ticket > reads.adopted)
    .toSorted(([a], [b]) => b - a);
  for (const [ticket, answered] of newerFirst) {
    if (takesEffectAtOnce(at, answered.read)) {
      hold(at.runtime, at.key, answered);
      reads.adopted = ticket;
      reads.parked = undefined;
      return;
    }
  }
}

/**
 * Written into isolate memory on a definite result, by the read `readsOut` says is to be adopted. A
 * failed read is not cached, so the next request retries. A missing or malformed pointer is held as
 * absent (`hold`) for the memory TTL, which is shorter than KV's own `cacheTtl`.
 */
function adopt(at: KeyRead<EdgePointer>, answered: Answered, ticket: number): void {
  const { runtime, key } = at;
  const out = readsOut.get(runtime.memory.pointers);
  const reads = out?.keys.get(key);
  if (out === undefined || reads === undefined) {
    return;
  }
  // Only a read still out has its say (`readsOut`): one given up on, forgotten with the list, or
  // of a list begun afresh since it went is not among the reads out.
  const stillOut = reads.out.delete(ticket);
  reads.warming.delete(ticket);
  if (stillOut && ticket > reads.adopted) {
    settle(at, reads, { ticket, answered });
  }
  if (reads.out.size === 0 && reads.parked === undefined) {
    out.keys.delete(key);
  }
}

async function loadPointer<P extends EdgePointer>(at: KeyRead<P>): Promise<Lookup<P>> {
  const ticket = sendRead(at.runtime, at.key);
  const answered = await answeredRead(at);
  adopt(at, answered, ticket);
  return answered.read;
}

/** What a refresh behind the response reads with. */
interface PointerReads {
  readonly env: EdgeBindings;
  readonly runtime: EdgeRuntime;
  readonly holdRefresh: HoldRefresh;
}

/**
 * Read what a refreshed pointer names that this isolate does not hold yet, before the pointer is
 * adopted: a manifest another deployment brought, a policy the pointer moved to. Adopted first, the
 * pointer would send the next request to wait on those reads before its first byte, in every
 * isolate after every deployment; read here, behind a response, the next request finds them held.
 * Once, whatever it comes to: a manifest neither store has, or cannot give, is the request's to
 * find as before, so a deployment — or the rollback that undoes a broken one — is held back by one
 * read at most. What this isolate holds is not read again, so a pointer that names nothing new — a
 * demotion, say — is adopted at once; and so is one that serves from the edge no more, is another
 * project's (`changesProject`), turns a setting it carries on or off (`changesSettings`), or is one
 * its host adopts at once for a field of its own (`PointerKind.adoptedAtOnce`), whatever it names.
 */
async function readAhead(
  { env, runtime, holdRefresh }: PointerReads,
  next: EdgePointer,
): Promise<void> {
  // Only a pointer that serves from the edge answers from its manifest and its policy. One that
  // does not — a passthrough, or a site disabled (`mode`) — is a safety that takes effect at once,
  // and waits on no read of either.
  if (next.mode !== 'edge') {
    return;
  }
  // Each asked for whatever the pointer before named: what this isolate holds answers at once,
  // and the same id says nothing of whether it is still held — the manifests share one budget, and
  // the pointer may have been read for requests that never needed its manifest. An absence found
  // here is not held against the requests after it, as a live read's is: they ask again
  // (`holdAbsence`). It is a live read all the same, KV's day and the hedge included: the next
  // requests take what it read.
  const reads: Promise<unknown>[] = [getPolicy(env, runtime, next.policyId, holdRefresh)];
  if (next.manifestId !== undefined) {
    reads.push(
      getManifest(env, runtime, next.manifestId, {
        namedSince: next.updatedAt,
        keep: holdRefresh,
        holdAbsence: false,
        live: true,
      }),
    );
  }
  await Promise.all(reads);
}

/**
 * Whether a refreshed pointer is another project's than the one it replaces: a hostname given up
 * and taken by another project. Adopted at once: a read of the new project's manifest that stalls
 * must not keep the former project's site answering on the hostname. A pointer that replaces none
 * — a hostname this isolate held as missing — is read ahead as any other: what answered meanwhile
 * was nobody's.
 */
function changesProject(served: EdgePointer | null, next: EdgePointer): boolean {
  return served !== null && served.projectId !== next.projectId;
}

/**
 * Whether a refreshed pointer turns a setting it carries itself on or off: CSP nonces
 * (`cspNonce`), or the Cache API copies of records (`cacheApi`). Each is the operator's switch for
 * the application, read off the pointer and out of nothing it names, and is adopted at once: a read
 * of a manifest that stalls must not keep nonces off the documents they were turned on for, nor
 * copies in use that were turned off. A pointer that replaces none changes no setting.
 */
function changesSettings(served: EdgePointer | null, next: EdgePointer): boolean {
  return (
    served !== null &&
    (served.cspNonce !== next.cspNonce ||
      (next.cspNonce === true &&
        ((served.cspNonceMode ?? 'enforce') !== (next.cspNonceMode ?? 'enforce') ||
          (served.cspStrictDynamic === true) !== (next.cspStrictDynamic === true))) ||
      served.cacheApi !== next.cacheApi)
  );
}

/**
 * Whether a refreshed pointer demotes, now, a route of the manifest served for longer than the
 * pointer served does (`demotedRoutes`, judged against the clock as a request judges it,
 * `isDemoted`): the host has judged the route's document wrong to split, and an isolate that goes
 * on splitting it serves what was judged wrong. That includes a route the pointer served does not
 * list, one it lists but whose demotion has ended, which this isolate splits again, demoted anew
 * because it failed again, and one whose demotion the refreshed pointer extends: held back, the
 * pointer served lets the route go at the moment it names, and the isolate splits it again. A
 * pointer naming another manifest demotes routes of one not served yet, and a route that comes back
 * to the edge sooner is no such hurry.
 */
function demotesMore(served: EdgePointer | null, next: EdgePointer, now: number): boolean {
  if (served === null || served.manifestId !== next.manifestId) {
    return false;
  }
  const ahead = demotedRoutesOf(next);
  if (ahead === undefined) {
    return false;
  }
  const held = demotedRoutesOf(served);
  for (const [pathname, until] of ahead) {
    // When the pointer served lets the route back onto the edge: now, where it does not keep it off.
    const heldUntil =
      held !== undefined && isDemoted(held, pathname, now) ? (held.get(pathname) ?? now) : now;
    if (isDemoted(ahead, pathname, now) && heldUntil < until) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a refreshed pointer is adopted at once, before anything it names is read (`readAhead`):
 * one that changes whose site the key is or a setting the pointer carries, that demotes a route of
 * the manifest served, or that the host adopts at once for a field of its own (`PointerKind`).
 */
function adoptedAtOnce(
  kind: PointerKind<EdgePointer, unknown>,
  served: EdgePointer | null,
  next: EdgePointer,
  now: number,
): boolean {
  return (
    changesProject(served, next) ||
    changesSettings(served, next) ||
    demotesMore(served, next, now) ||
    kind.adoptedAtOnce?.(served, next) === true
  );
}

/** What the refresh of one expired pointer is about. */
interface Refresh {
  /** The read's ticket (`sendRead`), sent as the pointer was held again. */
  readonly ticket: number;
  /** The pointer the request was answered with, past its TTL. */
  readonly served: HeldPointer;
  /** What the host tagged the live read with (`LiveRead.observer`). */
  readonly observer: unknown;
}

/**
 * The read behind a request answered with an expired pointer: what KV names now, read ahead
 * (`readAhead`) and then adopted; and, for a live request, what it found, reported — how old the
 * pointer served was, and whether KV now names another. KV's own time is reported, not the read
 * ahead's.
 */
async function refreshPointer<P extends EdgePointer>(
  at: KeyRead<P> & PointerReads,
  refresh: Refresh,
): Promise<void> {
  const { kind, runtime, key } = at;
  const { served, observer } = refresh;
  const startedAt = runtime.now();
  const answered = await answeredRead(at);
  // Judged against the pointer held as it lands, not the one the request was served: an older
  // refresh adopted meanwhile — the protection taken off — makes the newer, which puts it back, a
  // safety too. One that lands before such an adoption is judged again by it (`adoptWarmingSafety`).
  // A read no longer out — given up on (`MAX_READS_OUT_PER_KEY`), forgotten with the list, or of a
  // list begun afresh since — is never adopted: it reads nothing ahead, and is kept nowhere.
  const reads = readsOf(runtime, key);
  if (
    reads?.out.has(refresh.ticket) === true &&
    answered.read.kind === 'found' &&
    !takesEffectAtOnce(at, answered.read)
  ) {
    reads.warming.set(refresh.ticket, answered);
    await readAhead(at, answered.read.value);
  }
  adopt(at, answered, refresh.ticket);
  if (
    observer === undefined ||
    kind.observer === undefined ||
    answered.read.kind === 'unavailable'
  ) {
    return;
  }
  await kind.observer.stale(observer, {
    key,
    served: served as HeldPointer<P>,
    fresh: answered.read.kind === 'found' ? answered.read.value : null,
    ageMs: startedAt - served.readAt,
    kvMs: answered.readAt - startedAt,
  });
}

/** An isolate holding nothing waits for KV; for a live request, what it waited is reported. */
async function loadObserved<P extends EdgePointer>(
  at: KeyRead<P>,
  observer: unknown,
): Promise<Lookup<P>> {
  const { kind, runtime, key } = at;
  const startedAt = runtime.now();
  const loaded = await loadPointer(at);
  if (observer !== undefined && kind.observer !== undefined && loaded.kind !== 'unavailable') {
    kind.observer.cold(observer, {
      key,
      pointer: loaded.kind === 'found' ? loaded.value : null,
      kvMs: runtime.now() - startedAt,
    });
  }
  return loaded;
}

/** How the edge reads one kind of pointer (`createPointerReader`). */
export interface PointerReader<P extends EdgePointer, T> {
  /**
   * Resolve the active pointer under a key: isolate cache → KV. The key is the host's, whatever its
   * requests arrive with — one read either way, and the isolate cache is keyed the same.
   *
   * The pointer is the only mutable value per project and carries the origin host, so a project that
   * has never been proved is still routable (passthrough). Shells live in isolate memory far longer
   * than this 10 s TTL; a hit after expiry is still a hit. For a live read (`live`), an expired
   * isolate entry is served immediately and KV runs in the background — otherwise the lookup waits.
   *
   * What that costs: a pointer move — a promotion, a rollback, a demotion — reaches this isolate
   * one request later than it did, which is the one background refresh. It does not cost more than
   * that: the next request finds the refreshed entry, or another stale one and refreshes again.
   * While KV cannot be read at all, the last pointer this isolate saw keeps serving; the
   * alternative was 503. One read goes out per TTL either way: a stale entry is held again before
   * its refresh is sent. The late request is dispatched to the Workers that pointer names, which a
   * host may keep for a while after they became surplus, or may remove at once: an isolate that last
   * served the project before they went dispatches to Workers now gone. The first byte is not held
   * for KV to rule that out.
   *
   * One request later is not a bound in time: it is the first request this isolate takes after the
   * move, whenever that comes — for an isolate that sat idle, long after the deployment. A
   * passthrough that finds its Workers gone is routed again from KV (`answeredAgain`), and how old
   * the pointers served past their TTL are is told to the kind's observer
   * (`PointerReadObserver.stale`), for a host to decide whether that age should be bounded, at the
   * cost of a read in front of an idle isolate's answer.
   */
  get(env: EdgeBindings, runtime: EdgeRuntime, key: string, live?: LiveRead<T>): Promise<Lookup<P>>;
  /**
   * The pointer as KV holds it now, whatever this isolate held: for a request whose Workers turned
   * out to be gone, which is what a pointer this isolate served past its TTL can name
   * (`RoutingInput.servedAgain`). What it finds replaces the isolate's copy, as any read does.
   */
  reload(env: EdgeBindings, runtime: EdgeRuntime, key: string): Promise<P | undefined>;
}

/** The reader of one kind of pointer: made once, at module scope, and shared by every request. */
export function createPointerReader<P extends EdgePointer, T>(
  kind: PointerKind<P, T>,
): PointerReader<P, T> {
  return {
    async get(env, runtime, key, live) {
      const cached = runtime.memory.pointers.peek(key);
      if (cached === undefined) {
        // An absence is held for the TTL and then asked about again before the answer: a 404 is not
        // worth serving stale, and a project published a moment ago is found by the first request
        // after.
        if (runtime.memory.absentPointers.get(key) !== undefined) {
          return MISSING;
        }
        return loadObserved({ kind, env, runtime, key }, live?.observer);
      }
      if (!cached.stale) {
        return fromMemory(cached.value);
      }
      if (live !== undefined) {
        // Held for another TTL before the read goes out, so the requests that arrive while it is
        // out — or after it failed — serve this entry rather than each sending a read of its own.
        // The read replaces it when KV answers; when KV does not, the next try is one TTL later.
        // Held as it was read, so that how old it is stays measured from KV's answer.
        runtime.memory.pointers.set(key, cached.value);
        const ticket = sendRead(runtime, key);
        live.holdRefresh(
          refreshPointer(
            { kind, env, runtime, key, holdRefresh: live.holdRefresh },
            { ticket, served: cached.value, observer: live.observer },
          ),
        );
        return fromMemory(cached.value);
      }
      return loadPointer({ kind, env, runtime, key });
    },
    async reload(env, runtime, key) {
      const loaded = await loadPointer({ kind, env, runtime, key });
      return loaded.kind === 'found' ? loaded.value : undefined;
    },
  };
}

/**
 * The deployment a manifest was built for. A manifest read under its digest skips the schema
 * (`vouchedManifest`), and one written before every manifest named its Functions names none.
 */
function builtFor(manifest: { readonly app?: AppRuntime | undefined }): string | undefined {
  return manifest.app?.deploymentId;
}

/**
 * Why the manifest a pointer names is no manifest to serve from, if it is not: one proved against
 * another origin than the pointer names (`origin-mismatch`), or another deployment's than the one
 * the pointer sends requests to — another project's, or built for other Workers
 * (`deployment-mismatch`). Served from, its shells would be resumed, and its routes and files
 * answered, for an application it is not. Judged on what was read, and nothing more.
 */
function manifestMismatch(pointer: EdgePointer, manifest: ProjectManifest): string | undefined {
  if (manifest.origin.host !== pointer.originHost) {
    return 'origin-mismatch';
  }
  if (
    manifest.projectId !== pointer.projectId ||
    (pointer.app !== undefined && builtFor(manifest) !== pointer.app.deploymentId)
  ) {
    return 'deployment-mismatch';
  }
  return undefined;
}

/**
 * A manifest is only served when it is the one the pointer's own deployment was proved with
 * (`manifestMismatch`); otherwise the shell could belong to a different deployment altogether, so
 * the request is proxied instead.
 */
export function usableManifest(
  pointer: EdgePointer,
  manifest: ProjectManifest | undefined,
): ProjectManifest | undefined {
  return manifest !== undefined && manifestMismatch(pointer, manifest) === undefined
    ? manifest
    : undefined;
}

export function pointerPassthroughReason(
  pointer: EdgePointer,
  stored: Lookup<ProjectManifest>,
  suspect: boolean,
): string {
  if (suspect) {
    return 'suspect';
  }
  if (pointer.mode !== EDGE_MODE) {
    return pointer.reason ?? pointer.mode;
  }
  switch (stored.kind) {
    case 'unavailable': {
      return 'manifest-unavailable';
    }
    case 'missing': {
      return 'no-manifest';
    }
    case 'found': {
      return manifestMismatch(pointer, stored.value) ?? pointer.reason ?? EDGE_MODE;
    }
  }
}

/** True when this isolate has condemned the route the client's pathname names. */
export function isSuspect(runtime: EdgeRuntime, pointer: EdgePointer, pathname: string): boolean {
  if (pointer.manifestId === undefined) {
    return false;
  }
  const key = routeSuspectKey(pointer.projectId, pointer.manifestId, pathname);
  return runtime.memory.suspects.get(key) === true;
}

/**
 * When each route a pointer demotes comes back to the edge (epoch ms), by the pathname the
 * manifest names it by (`EdgePointer.demotedRoutes`).
 */
export type DemotedRoutes = ReadonlyMap<string, number>;

/**
 * Built once per pointer object. The isolate keeps the pointer it parsed for its TTL and hands the
 * same object to every request in between, so they share one map, and the next refresh — a new
 * object — gets a map of its own while this one is collected with the pointer it was made from.
 */
const demotedByPointer = new WeakMap<EdgePointer, DemotedRoutes>();

/**
 * The routes a pointer demotes, or `undefined` for a pointer that demotes none — which is every
 * pointer but a few, and all such a request pays: one test, no read.
 */
export function demotedRoutesOf(pointer: EdgePointer): DemotedRoutes | undefined {
  const listed = pointer.demotedRoutes;
  if (listed === undefined || listed.length === 0) {
    return undefined;
  }
  const known = demotedByPointer.get(pointer);
  if (known !== undefined) {
    return known;
  }
  const demoted: DemotedRoutes = new Map(listed.map((route) => [route.pathname, endOf(route)]));
  demotedByPointer.set(pointer, demoted);
  return demoted;
}

/** When a route the pointer demotes comes back, in epoch ms. */
function endOf(route: NonNullable<EdgePointer['demotedRoutes']>[number]): number {
  // eslint-disable-next-line unicorn/prefer-temporal -- Temporal is not available in the Workers runtime.
  return Date.parse(route.until);
}

/**
 * Whether a route is demoted now: judged against the clock rather than left to the next pointer, so
 * a demotion ends at the moment it names even before a pointer is published without it.
 */
export function isDemoted(demoted: DemotedRoutes, pathname: string, now: number): boolean {
  const until = demoted.get(pathname);
  return until !== undefined && until > now;
}
