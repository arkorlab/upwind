import { sha256Hex } from '@stayingupwind/core/artifact';
import { artifactIdFor } from '@stayingupwind/core/cache';
import {
  ByteLru,
  isDeadlineError,
  readBoundedBody,
  releaseStream,
  withDeadline,
} from '@stayingupwind/core/util';

/**
 * The artifacts a deployment's Worker has read, kept where its next read of one finds them without
 * crossing to the authority.
 *
 * An artifact is what a regenerated generation keeps beside its record — its RSC payload, each
 * prefetch segment, a Pages Router page's data — or a data value too large to travel inline, and
 * only the authority's storage has one: the read gateway answers from KV, where none of them is. So
 * a read of one goes to the authority's gateway, which a host may place beside its storage, and on
 * to the scope's Durable Object and to R2, from wherever the visitor is — every time, once the
 * runtime's own memory of it has lapsed, five seconds after the read.
 *
 * An artifact never changes under its id, which is derived from the scope and the SHA-256 of its
 * bytes (`artifactIdFor`): a read of one is good for as long as anything keeps it. Two layers keep
 * it, neither on a clock — this isolate's memory, and its data center's Cache API — and neither takes
 * in bytes that do not hash to the id they are asked by. These are the bytes a visitor is answered
 * with, and the copies sit in a cache the application's own code can open as well, so a copy is
 * hashed again when it is read: native SHA-256, paid once per isolate for what the isolate then holds.
 * The authority's bytes are hashed too, but behind the response: they are served whether or not they
 * hash, and the hash decides only whether they are kept.
 *
 * An artifact over a quarter of the isolate's budget — 2 MiB, only ever a data value — is never
 * held, so each read of it is answered by the copy, hashed again in full, or by the authority where
 * the copy is missing or slower than its budget. A copy that turns up after it was given up on is
 * not written over, so a slow one costs its reads the authority's round trip but not a rewrite.
 *
 * Retirement needs nothing of either. A deployment's scope is retired once its Workers have been
 * taken down, and what an isolate holds goes with the isolate. The copies are keyed under the
 * scope, which the next deployment's Worker never reads under, so it never finds them; what is left
 * in a data center ages out there.
 */

/**
 * What a host names the copies by (`ArtifactCopies`): the Cache API namespace they are kept in —
 * only artifacts enter it; the application's own caches are named by the application — and the
 * origin they are keyed on, a host nothing resolves. Both key what each data center holds, and stay
 * what they were for as long as copies under them are to be found.
 */
export interface FunctionCacheNaming {
  readonly copyCache: string;
  readonly copyKeyOrigin: string;
}
/**
 * How long a read asks the copy alone. A copy in the data center normally answers, kept or missing,
 * well within this, and one that answers first costs the authority nothing: no read of its storage,
 * and none metered. Past it the Cache API is having a slow moment, and the authority is asked beside
 * it rather than after it, so a slow copy holds a read up by no more than this. Asking both at once
 * from the start would have the authority read every artifact the copies hold.
 */
const COPY_HEAD_START_MS = 10;
/** Longest a read waits on the copy at all, as the edge's reads of its own copies do. */
const COPY_READ_BUDGET_MS = 100;
/**
 * How much longer a read waits for a copy past its budget once the authority has answered with no
 * bytes — refused, failed, or holding none. Bytes of the id are the artifact whoever holds them,
 * and what follows a read with none is an error or a render, either of which costs more than this.
 */
const LATE_COPY_GRACE_MS = 1000;
/**
 * How long a data center keeps a copy. The bytes never go stale; this bounds how long a copy sits
 * where nothing asks for it, and an artifact still asked for is read from the authority again once
 * a day in each data center that serves it.
 */
const COPY_MAX_AGE_SECONDS = 86_400;
const COPY_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/octet-stream',
  'cache-control': `max-age=${COPY_MAX_AGE_SECONDS}`,
};
const KIB = 1024;
const MIB = KIB * KIB;
/**
 * What one isolate holds, in MiB. A Function has 128 MB, and the runtime's own memories hold up to
 * 20 MiB of it — 8 of data values, 8 of records, 4 of artifacts. The bytes held here are the very
 * objects its artifact and data memories hold while they hold them, so this adds no more than its own
 * size beside them, and that is the size of the runtime's two larger memories.
 */
const HELD_MIB = 8;
const HELD_BYTES = HELD_MIB * MIB;
/**
 * One artifact may take a quarter of it at most, so a large data value does not empty the rest; one
 * larger is read from the copy, or the authority, every time.
 */
const HELD_ENTRY_SHARE = 4;
const HELD_ENTRY_BYTES = HELD_BYTES / HELD_ENTRY_SHARE;
const UTF16_BYTES = 2;
/**
 * The largest artifact the authority keeps (`MAX_ARTIFACT_BYTES`, 25 MiB): no copy of one runs
 * longer. A copy's body is read whole before it is held to its id, and the application's own code
 * can write into the copies' cache — a body read whatever its size could run past the isolate's
 * memory. One that runs longer is not the artifact, and is read no further than this. Nor is one
 * kept: an authority configured to keep larger artifacts has them read from it every time.
 */
const MAX_COPY_MIB = 25;
const MAX_COPY_BYTES = MAX_COPY_MIB * MIB;
/**
 * How long a copy is read for at the most — the Cache API's open and lookup, and the body after
 * them, without a chunk arriving as well. Past its budget a read goes on behind the response
 * (`#arrived`), and this is what bounds it there: a third of what the runtime gives work behind a
 * response (`waitUntil`, 30 seconds), so that the authority's bytes are still written in place of a
 * copy that stalled (`keepCopy`, `missed`), wherever it stalled, rather than the copy spending all
 * of it and the next read finding it stalled again.
 */
const COPY_READ_LIMIT_MS = 10_000;
/**
 * How many lookups of copies one request has out at once. A request has six calls waiting for an
 * answer at the most, shared with every Worker it reaches through a binding, and the Cache API's
 * `match` is one until it answers; a seventh waits for one of the six. A read gives up on a copy
 * that stalls but cannot call its lookup off, so lookups that stall together could hold all six,
 * and the authority's reads — the very ones asked beside a slow copy — would wait behind them for
 * as long as the Cache API took. Two leave the rest to those reads and to whatever else the request
 * asks; past them a lookup waits its turn, inside its read's head start as a slow copy is, and one
 * still waiting once the read's limit is past is never asked at all.
 */
const COPY_LOOKUPS_AT_ONCE = 2;
/**
 * And how many copies it writes at once: one. A write is behind the response, where nothing waits
 * for it, but runs beside the rest of the request's render, whose own calls a burst of writes would
 * otherwise queue behind — or, stalled, hold up for good.
 */
const COPY_WRITES_AT_ONCE = 1;
/**
 * How much of a copy is handed to the Cache API at a time. A copy's body is the bytes the read
 * answered with, read in slices of them (`sliced`): `new Response` given the bytes themselves
 * takes a copy of them, and a render that misses several large data values at once would hold each
 * of them twice while their copies are written — three of 25 MiB is past a Function's 128 MB.
 */
const COPY_SLICE_KIB = 64;
const COPY_SLICE_BYTES = COPY_SLICE_KIB * KIB;

/** The bytes as a body read from them, a slice at a time, rather than from a copy of them. */
function sliced(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + COPY_SLICE_BYTES, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

/** Where the runtime puts each request's context for libraries written for Vercel to find. */
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/** The authority's answer for one artifact: its bytes, or `undefined` for none. A refusal rejects. */
type AuthorityRead = (artifactId: string, signal?: AbortSignal) => Promise<Uint8Array | undefined>;

/**
 * What one read came to: the bytes, none, the refusal the authority answered with, or — the copy's
 * alone — none yet, since the copy was given up on, and its bytes if they turn up after all as the
 * artifact they are kept under.
 */
type Outcome =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'none' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'late'; readonly arrived: Promise<Uint8Array | undefined> };

const NONE: Outcome = { kind: 'none' };

/** The data center's Cache API, and the namespace the copies are kept in there. */
interface Copies {
  readonly storage: CacheStorage;
  readonly name: string;
}

/** Where the authority's bytes are copied, once the copy's own read is known to have missed. */
interface CopyTarget {
  readonly copies: Copies;
  readonly key: string;
  readonly missed: Promise<boolean>;
}

/** The request context the runtime publishes, as far as this reads it. */
interface RequestContext {
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/** Where the runtime publishes it (`@vercel/request-context`). */
interface RequestContextAccessor {
  readonly get?: () => RequestContext | undefined;
}

function warn(message: string, fields: Record<string, string>): void {
  // The Function's own log, as the runtime writes its own: nothing else sees what its cache did.
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: 'warn', msg: `cache-host: ${message}`, ...fields }));
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The Cache API, where the Worker has one. A Worker on Cloudflare does — `caches.open`, that is,
 * since `caches.default` is disabled for a Worker that runs untrusted — and Node.js, where the
 * suites run the runtime, does not.
 */
export function cacheStorage(): CacheStorage | undefined {
  const scope: { readonly caches?: CacheStorage } = globalThis;
  return scope.caches;
}

/** The key a copy is kept under: the scope, then the artifact. */
function copyUrl(naming: FunctionCacheNaming, scopeId: string, artifactId: string): string {
  return `${naming.copyKeyOrigin}/${encodeURIComponent(scopeId)}/${encodeURIComponent(artifactId)}`;
}

/**
 * The Cache API's answer for the key, asked in one of the request's turns (`COPY_LOOKUPS_AT_ONCE`),
 * which is given back once it has answered: its body is read past the six. None where no turn came
 * within the read's limit.
 */
async function lookUpCopy(copies: Copies, key: string): Promise<Response | undefined> {
  const turns = turnsOfRequest()?.lookups;
  if (turns !== undefined && !(await turns.take(COPY_READ_LIMIT_MS))) {
    return undefined;
  }
  try {
    const cache = await copies.storage.open(copies.name);
    return await cache.match(key);
  } finally {
    turns?.give();
  }
}

/** What the copies' cache holds under the key: its bytes, none, or more than any artifact runs. */
async function matchCopy(
  copies: Copies,
  key: string,
): Promise<Uint8Array | 'oversized' | undefined> {
  const hit = await lookUpCopy(copies, key);
  if (hit === undefined) {
    return undefined;
  }
  // Said up front where it was stored with a length, and counted where it was not.
  if (Number(hit.headers.get('content-length')) > MAX_COPY_BYTES) {
    releaseStream(hit.body, 'a copy longer than any artifact');
    return 'oversized';
  }
  const body = await readBoundedBody(hit.body, {
    limit: MAX_COPY_BYTES,
    stallMs: COPY_READ_LIMIT_MS,
    budgetMs: COPY_READ_LIMIT_MS,
  });
  if (body.kind === 'over-limit') {
    releaseStream(body.body, 'a copy longer than any artifact');
    return 'oversized';
  }
  return body.bytes;
}

/**
 * Keep the authority's bytes as the data center's copy, unless the copy's own read found one. Only
 * ever behind the response, and a failure is only logged: the authority answers without it. Bytes
 * longer than a copy is read for are not kept (`MAX_COPY_BYTES`): no read would find them, and
 * every read the authority answers would write them again.
 */
async function keepCopy(target: CopyTarget, bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_COPY_BYTES) {
    return;
  }
  try {
    if (!(await target.missed)) {
      return;
    }
    // In the request's turn (`COPY_WRITES_AT_ONCE`); one that does not come within as long as a
    // copy is read for leaves the copy to the next read that misses it.
    const turns = turnsOfRequest()?.writes;
    if (turns !== undefined && !(await turns.take(COPY_READ_LIMIT_MS))) {
      return;
    }
    try {
      const cache = await target.copies.storage.open(target.copies.name);
      await cache.put(target.key, new Response(sliced(bytes), { headers: COPY_HEADERS }));
    } finally {
      turns?.give();
    }
  } catch (error) {
    warn('artifact copy write failed', { detail: errorDetail(error) });
  }
}

/**
 * Keep work going past the response, on the `waitUntil` of the request it was started for.
 *
 * Nothing in the host interface carries the execution context, which is the runtime's; but the
 * runtime publishes every request's `waitUntil` where libraries written for Vercel look for it
 * (`@vercel/request-context`), and this is such a library. With no request in context — a suite, a
 * harness — the work is started all the same with nothing to keep it alive: it never rejects, and
 * work the runtime cuts short is an artifact not held, or a copy the data center does not have,
 * which the next read that misses it keeps again.
 */
export function behindResponse(work: Promise<void>): void {
  try {
    const context = requestContext();
    if (context?.waitUntil !== undefined) {
      context.waitUntil(work);
      return;
    }
  } catch {
    // A context that cannot take the work leaves it as it is when there is none.
  }
  void work.catch(() => {
    /* What is kept behind the response logs its own failures and never rejects. */
  });
}

/**
 * The context of the request under way, as the runtime publishes it. One it cannot give is none.
 */
function requestContext(): RequestContext | undefined {
  try {
    const accessor = Reflect.get(globalThis, REQUEST_CONTEXT) as RequestContextAccessor | undefined;
    return accessor?.get?.();
  } catch {
    return undefined;
  }
}

/**
 * Turns at the copies' cache for one request's calls of one kind: no more than `limit` out at
 * once, and the rest waiting in the order they asked.
 */
class Turns {
  readonly #limit: number;
  #out = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  /**
   * A turn once one is free, or `false` once `ms` have gone by without one — and the place in line
   * given up, so that a turn given back later goes to whoever waits next.
   */
  async take(ms: number): Promise<boolean> {
    if (this.#out < this.#limit) {
      this.#out += 1;
      return true;
    }
    const granted = Promise.withResolvers<true>();
    const place = (): void => {
      granted.resolve(true);
    };
    this.#waiting.push(place);
    if ((await within(granted.promise, ms)) === true) {
      return true;
    }
    const at = this.#waiting.indexOf(place);
    if (at === -1) {
      // Given the turn just as the time ran out: handed on, unused.
      this.give();
    } else {
      this.#waiting.splice(at, 1);
    }
    return false;
  }

  /** A turn given back: to whoever waits next, or free. */
  give(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#out -= 1;
      return;
    }
    next();
  }
}

/** The turns of one request: lookups and writes, each kept to its own number. */
interface CopyTurns {
  readonly lookups: Turns;
  readonly writes: Turns;
}

/** Each request's turns, by its context, and gone with it. */
const turnsByRequest = new WeakMap<RequestContext, CopyTurns>();

/**
 * The turns of the request under way. A request's six are its own, so the turns are too: two
 * requests an isolate serves at once each have theirs. With no request in context — a suite, a
 * harness — there are none to keep within, and every call goes as it comes.
 */
export function turnsOfRequest(): CopyTurns | undefined {
  const context = requestContext();
  if (context === undefined) {
    return undefined;
  }
  let turns = turnsByRequest.get(context);
  if (turns === undefined) {
    turns = { lookups: new Turns(COPY_LOOKUPS_AT_ONCE), writes: new Turns(COPY_WRITES_AT_ONCE) };
    turnsByRequest.set(context, turns);
  }
  return turns;
}

/**
 * Whether the copy's read came to nothing: then what the authority answers is worth keeping. A copy
 * given up on for being slow is waited for here, behind the response, and one that turns up as the
 * artifact it is kept under is not written over: a large copy can take longer than its budget to
 * arrive every time it is read, and would otherwise be written again by every read of it. One that
 * turns up as anything else is written over, as a copy read in time that does not hash is.
 */
async function missed(copy: Promise<Outcome>): Promise<boolean> {
  const outcome = await copy;
  switch (outcome.kind) {
    case 'bytes': {
      return false;
    }
    case 'late': {
      return (await outcome.arrived) === undefined;
    }
    case 'none':
    case 'failed': {
      return true;
    }
  }
}

/** What the data center's copy turned out to be: the artifact's bytes, none, or something else. */
type CopyCheck =
  | { readonly kind: 'named'; readonly bytes: Uint8Array }
  | { readonly kind: 'missing' }
  | { readonly kind: 'other' };

/**
 * The copy read and held to its id together, so that the budget a read gives the copy covers both:
 * a large copy can take tens of milliseconds to hash once its body is in. Held to its id, as the
 * application's own code can write into the same cache, and a copy that does not hash would
 * otherwise stand in the way of the authority's bytes until it aged out. Rejects where the Cache
 * API does.
 */
async function checkedCopy(
  match: Promise<Uint8Array | 'oversized' | undefined>,
  names: (bytes: Uint8Array) => Promise<boolean>,
): Promise<CopyCheck> {
  const bytes = await match;
  if (bytes === undefined) {
    return { kind: 'missing' };
  }
  if (bytes === 'oversized') {
    return { kind: 'other' };
  }
  return (await names(bytes)) ? { kind: 'named', bytes } : { kind: 'other' };
}

/** Once `promise` has settled, whichever way: what work kept behind a response is handed as. */
async function settled(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch {
    // What is kept behind the response logs its own failures.
  }
}

/** What `promise` came to within `ms`, or `undefined` once they have gone by. */
export async function within<T>(
  promise: Promise<T | undefined>,
  ms: number,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gone = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
  try {
    return await Promise.race([promise, gone]);
  } finally {
    // Not `clearTimeout(timer)` alone: only one of the runtimes this runs on accepts `undefined`.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** The copy's answer if it came within its head start; `'out'` while it is still out. */
async function withinHeadStart(copy: Promise<Outcome>): Promise<Outcome | 'out'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const headStart = new Promise<'out'>((resolve) => {
    timer = setTimeout(() => {
      resolve('out');
    }, COPY_HEAD_START_MS);
  });
  try {
    return await Promise.race([copy, headStart]);
  } finally {
    // Not `clearTimeout(timer)` alone: only one of the runtimes this runs on accepts `undefined`.
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * The first of the two reads to bring bytes; otherwise the authority's word. A copy still out may
 * yet hold what the authority no longer answers with — bytes of the id it was asked by all the
 * same, as a held one is — and a refusal loses to it too: one past its budget races the authority
 * while the authority is out, and is waited for a moment more once it has answered with none.
 *
 * Where the copy answers first, the authority's read is called off (`#throughCopy`), and is not
 * handed to `waitUntil`: the copy's bytes are held already, and the data center has the copy, so
 * the authority's bytes would be held and copied only over the same.
 */
async function firstWithBytes(
  copy: Promise<Outcome>,
  authority: Promise<Outcome>,
): Promise<Outcome> {
  const first = await Promise.race([copy, authority]);
  if (first.kind === 'bytes') {
    return first;
  }
  const fromCopy = await copy;
  if (fromCopy.kind !== 'late') {
    return fromCopy.kind === 'bytes' ? fromCopy : authority;
  }
  // A copy past its budget, beside an authority that may still be out: whichever brings bytes
  // first, so that a copy that turns up while the authority stalls is not kept waiting on it.
  const turnedUp = turnedUpAsOutcome(fromCopy.arrived);
  const raced = await Promise.race([authority, turnedUp]);
  if (raced === undefined) {
    return authority;
  }
  if (raced.kind === 'bytes') {
    return raced;
  }
  // The authority has answered with no bytes. The copy is waited for a moment more
  // (`LATE_COPY_GRACE_MS`), rather than an error or a miss answered in its place.
  const late = await within(fromCopy.arrived, LATE_COPY_GRACE_MS);
  return late === undefined ? raced : { kind: 'bytes', bytes: late };
}

/** A late copy as an outcome once it turns up: its bytes, or `undefined` if it came to nothing. */
async function turnedUpAsOutcome(
  arrived: Promise<Uint8Array | undefined>,
): Promise<Outcome | undefined> {
  const bytes = await arrived;
  return bytes === undefined ? undefined : { kind: 'bytes', bytes };
}

function answerOf(outcome: Outcome): Uint8Array | undefined {
  switch (outcome.kind) {
    case 'bytes': {
      return outcome.bytes;
    }
    case 'none':
    case 'late': {
      return undefined;
    }
    case 'failed': {
      throw outcome.error;
    }
  }
}

/**
 * The artifacts one isolate has read, and its data center's copies of them, in front of the
 * authority. One per isolate, as the runtime holds one host per isolate.
 */
export class ArtifactCopies {
  readonly #scopeId: string;
  readonly #fromAuthority: AuthorityRead;
  readonly #naming: FunctionCacheNaming;
  /** Least recently read first to go, and nothing else: no bytes held here ever go stale. */
  readonly #held = new ByteLru<string, Uint8Array>(HELD_BYTES);
  /** This isolate's copies (`#copiesIn`): the same `caches` every read, under the host's name. */
  #copies: Copies | undefined;

  constructor(scopeId: string, fromAuthority: AuthorityRead, naming: FunctionCacheNaming) {
    this.#scopeId = scopeId;
    this.#fromAuthority = fromAuthority;
    this.#naming = naming;
  }

  #copiesIn(storage: CacheStorage): Copies {
    this.#copies ??= { storage, name: this.#naming.copyCache };
    return this.#copies;
  }

  async #throughCopy(copies: Copies, artifactId: string): Promise<Outcome> {
    const key = copyUrl(this.#naming, this.#scopeId, artifactId);
    const copy = this.#copyOf(copies, key, artifactId);
    const early = await withinHeadStart(copy);
    if (early === 'out') {
      const asked = new AbortController();
      const authority = this.#fromAuthorityKept(
        artifactId,
        { copies, key, missed: missed(copy) },
        asked.signal,
      );
      const outcome = await firstWithBytes(copy, authority);
      // The answer is in. An authority still out is reading the bytes the copy brought, for
      // nothing: they would be neither held nor copied over the copy (`firstWithBytes`), and its
      // body would sit in memory beside the copy's until it ended. Done, it is not touched.
      if (outcome.kind === 'bytes') {
        asked.abort();
      }
      return outcome;
    }
    return early.kind === 'bytes'
      ? early
      : this.#fromAuthorityKept(artifactId, { copies, key, missed: Promise.resolve(true) });
  }

  /**
   * This data center's copy, held to its id. Never rejects, and a copy that is slow is none.
   *
   * Only a Cache API that fails is warned about. One that is slow is the ordinary miss the hedge is
   * there for — a slow moment, or a large copy whose body takes longer than the budget — and this
   * log is the application's own runtime log, where a warning its owner can do nothing about on
   * every such read would be noise.
   */
  async #copyOf(copies: Copies, key: string, artifactId: string): Promise<Outcome> {
    const checked = checkedCopy(
      withDeadline(matchCopy(copies, key), COPY_READ_LIMIT_MS, 'artifact copy read'),
      async (bytes) => this.#names(artifactId, bytes),
    );
    try {
      const copy = await withDeadline(checked, COPY_READ_BUDGET_MS, 'artifact copy read');
      if (copy.kind === 'missing') {
        return NONE;
      }
      if (copy.kind === 'other') {
        warn('artifact copy does not hash to its id', { artifactId });
        return NONE;
      }
      this.#hold(artifactId, copy.bytes);
      return { kind: 'bytes', bytes: copy.bytes };
    } catch (error) {
      if (isDeadlineError(error)) {
        const arrived = this.#arrived(checked, artifactId);
        // Behind the response too: a copy that turns up once the read has its answer — the
        // authority's bytes, or its refusal past the grace — is still worth holding for the next.
        behindResponse(settled(arrived));
        return { kind: 'late', arrived };
      }
      warn('artifact copy read failed', { artifactId, detail: errorDetail(error) });
      return NONE;
    }
  }

  /**
   * The authority's answer, served as it comes, and held here and copied behind the response once
   * its bytes hash to their id. Bytes that do not are still the authority's answer, as they were
   * before anything kept one: served, and neither held nor copied. A refusal is the outcome, thrown
   * unless a copy answers.
   *
   * The hash decides only what is kept, never what is served, so it is taken behind the response
   * rather than ahead of its first byte: a data value can be tens of MiB, and hashing it is tens of
   * milliseconds the visitor would wait on for nothing. A copy is hashed before it is served, since
   * that is what makes it safe to serve.
   */
  async #fromAuthorityKept(
    artifactId: string,
    copy: CopyTarget | undefined,
    signal?: AbortSignal,
  ): Promise<Outcome> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.#fromAuthority(artifactId, signal);
    } catch (error) {
      return { kind: 'failed', error };
    }
    if (bytes === undefined) {
      return NONE;
    }
    behindResponse(this.#keep(artifactId, bytes, copy));
    return { kind: 'bytes', bytes };
  }

  /** Hold the authority's bytes, and copy them, once they hash to their id. Never rejects. */
  async #keep(artifactId: string, bytes: Uint8Array, copy: CopyTarget | undefined): Promise<void> {
    try {
      if (!(await this.#names(artifactId, bytes))) {
        warn('artifact does not hash to its id: served, not kept', { artifactId });
        return;
      }
    } catch (error) {
      warn('artifact hash failed: served, not kept', { artifactId, detail: errorDetail(error) });
      return;
    }
    this.#hold(artifactId, bytes);
    if (copy !== undefined) {
      await keepCopy(copy, bytes);
    }
  }

  /** Whether these are the bytes the id names: the id is the scope's digest of their SHA-256. */
  async #names(artifactId: string, bytes: Uint8Array): Promise<boolean> {
    return (await artifactIdFor(this.#scopeId, await sha256Hex(bytes))) === artifactId;
  }

  /**
   * A late copy's bytes if they turn up as the artifact, held as a copy read in time is. What it
   * comes to otherwise is said as a copy read in time says it (`#copyOf`): a Cache API that fails
   * only once it is slow too still fails every read that misses it.
   */
  async #arrived(checked: Promise<CopyCheck>, artifactId: string): Promise<Uint8Array | undefined> {
    let copy: CopyCheck;
    try {
      copy = await checked;
    } catch (error) {
      warn('artifact copy read failed', { artifactId, detail: errorDetail(error) });
      return undefined;
    }
    if (copy.kind === 'other') {
      warn('artifact copy does not hash to its id', { artifactId });
    }
    if (copy.kind !== 'named') {
      return undefined;
    }
    this.#hold(artifactId, copy.bytes);
    return copy.bytes;
  }

  #hold(artifactId: string, bytes: Uint8Array): void {
    const size = bytes.buffer.byteLength + artifactId.length * UTF16_BYTES;
    if (size <= HELD_ENTRY_BYTES) {
      this.#held.set(artifactId, bytes, size);
    }
  }

  /**
   * An artifact's bytes: held, copied, or the authority's. The copy is asked first, alone for its
   * head start; past that the authority is asked beside it, and whichever brings the bytes first
   * answers. A copy that is missing, slow, failing or wrong is a miss and never an error; the
   * authority's refusal is the error it always was, and neither it nor a miss is kept anywhere.
   *
   * Two reads of one artifact at once each read for themselves. A read under way is I/O of the
   * request that started it, which the Workers runtime cancels with that request, and another
   * request waiting on it would wait on something it cannot see through to the end.
   *
   * The bytes answered are the ones held, shared with every later read in the isolate and never let
   * go on a clock: a caller copies them and must neither change nor transfer them, or every read
   * after it is answered with what it left.
   */
  async read(artifactId: string): Promise<Uint8Array | undefined> {
    const held = this.#held.get(artifactId);
    if (held !== undefined) {
      return held;
    }
    const storage = cacheStorage();
    const outcome =
      storage === undefined
        ? await this.#fromAuthorityKept(artifactId, undefined)
        : await this.#throughCopy(this.#copiesIn(storage), artifactId);
    return answerOf(outcome);
  }
}
