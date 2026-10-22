import {
  type DecodedGenerationPack,
  decodeGenerationPack,
  deriveEntry,
  evaluateFreshness,
  type RouteEntryDescriptor,
  type Validity,
  verifyGenerationPack,
} from '@stayingupwind/core/cache';
import { withDeadline } from '@stayingupwind/core/util';

import { nowMs } from './clock.ts';
import type { CacheRuntime, RecordRead } from './runtime.ts';
import { servable } from './servable.ts';

/**
 * The current generation of an entry, as the Function reads it when it answers a document itself:
 * the same delivery record the edge reads, through the host, kept for one hold. What the
 * record says is judged the way the edge judges it, so the two never serve different things.
 */

export interface CurrentGeneration {
  readonly entryId: string;
  readonly pack: DecodedGenerationPack;
  readonly validity: Validity;
}

export type CurrentLookup =
  | { readonly kind: 'generation'; readonly current: CurrentGeneration }
  | { readonly kind: 'none'; readonly entryId: string }
  | {
      readonly kind: 'unavailable';
      readonly entryId: string;
      readonly pending?: PendingRecordLookup;
    };

/** The exact primary read a foreground deadline left unfinished, with its original lifetime. */
export interface PendingRecordLookup {
  readonly entryId: string;
  readonly read: RecordRead;
  readonly until: number;
}

/**
 * How long a document waits for its record before the build's own shell answers instead. The
 * Function answers a document itself only where the edge could not serve the shell; the record is
 * a bonus there, not a wait the visitor should notice.
 */
const RECORD_DEADLINE_MS = 200;

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How long a read of a record is out at the most: what the runtime gives work behind a response
 * (`waitUntil`). It is called off then (`readRecordPack`); one whose request ended first never
 * settles here, and is taken for lost.
 */
const RECORD_READ_LIFETIME_MS = 30_000;

/**
 * An entry's verified record, or `null` for confirmed absence. Invalid bytes never authorize a miss. The read
 * is called off once it has been out for as long as a read can be (`RECORD_READ_LIFETIME_MS`): the
 * request that began it may go on for longer, and a read out that long is not coming back.
 */
async function readRecordPack(
  runtime: CacheRuntime,
  entryId: string,
): Promise<DecodedGenerationPack | null> {
  const calledOff = new AbortController();
  const timer = setTimeout(() => {
    calledOff.abort(new Error('a read of a record out past its lifetime'));
  }, RECORD_READ_LIFETIME_MS);
  try {
    const bytes = await runtime.host.readRecord(entryId, calledOff.signal);
    calledOff.signal.throwIfAborted();
    if (bytes === undefined) return null;
    const decoded = decodeGenerationPack(bytes);
    if (
      decoded.kind !== 'ok' ||
      decoded.pack.header.entryId !== entryId ||
      decoded.pack.header.scopeId !== runtime.scopeId ||
      !(await verifyGenerationPack(decoded.pack))
    ) {
      throw new Error('delivery record identity or digests differ');
    }
    calledOff.signal.throwIfAborted();
    return decoded.pack;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `bytes` as a record of the entry, decoded and checked; `undefined` for bytes that are not one, or
 * that are another entry's. For records the host hands over outside `readRecord`: the one a commit
 * wrote (`CommitOutcome.record`), a copy nearer than the host's read (`readNewerRecord`).
 */
async function recordPackOf(
  bytes: Uint8Array,
  entryId: string,
): Promise<DecodedGenerationPack | undefined> {
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok' || decoded.pack.header.entryId !== entryId) {
    return undefined;
  }
  return (await verifyGenerationPack(decoded.pack)) ? decoded.pack : undefined;
}

/**
 * The record a commit handed back (`CommitOutcome.record`), as the generation it published:
 * `undefined` where it handed none back, or bytes that are not that generation's record. Never
 * throws: the generation is published whatever is made of what came back with it.
 */
export async function publishedRecordOf(
  bytes: Uint8Array | undefined,
  entryId: string,
  generationId: string,
): Promise<DecodedGenerationPack | undefined> {
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const pack = await recordPackOf(bytes, entryId);
    return pack?.header.generationId === generationId ? pack : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How long a document waits for a record later than the one its read found, past that read. The
 * read found none, or one no longer fresh: what waits on the answer otherwise is a render.
 */
const NEWER_RECORD_DEADLINE_MS = 200;

/**
 * A record of the entry later than the one at `than`, where the host keeps one nearer than its read
 * (`readNewerRecord`): `undefined` for none, none in time, or a host without any.
 */
async function newerPack(
  runtime: CacheRuntime,
  entryId: string,
  than: number,
  background?: {
    readonly deadlineMs: number;
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
): Promise<DecodedGenerationPack | undefined> {
  const { host } = runtime;
  if (host.readNewerRecord === undefined) {
    return undefined;
  }
  // The read, the decoding and the check together under the deadline: a record is hashed to be
  // checked, and a long one past a quick read would keep the document waiting all the same.
  const read = async (): Promise<DecodedGenerationPack | undefined> => {
    const bytes = await host.readNewerRecord?.(entryId, than);
    if (bytes === undefined) return undefined;
    const pack = await recordPackOf(bytes, entryId);
    if (pack?.header.scopeId !== runtime.scopeId)
      throw new Error('later delivery record identity or digests differ');
    return pack;
  };
  try {
    const operation =
      background === undefined ? read() : retainedNewerRead(runtime, read, background.waitUntil);
    const pack = await withDeadline(
      operation,
      background?.deadlineMs ?? NEWER_RECORD_DEADLINE_MS,
      'a later delivery record',
    );
    return pack !== undefined && pack !== null && pack.header.seq > than ? pack : undefined;
  } catch (error) {
    if (background !== undefined) throw error;
    // What the read found is answered as it would have been without the host's later record.
    runtime.log('later delivery record not read', { entryId, detail: detail(error) });
    return undefined;
  }
}

/**
 * The reads of records each runtime has out, joined or not, each with when it went out on the
 * isolate's own clock (`performance.now()`), not the clock a request acts at: a read the table let
 * go of (`sweepReads`) goes on until it settles, is called off (`readRecordPack`), or its request
 * ends, and it is these that `MAX_RECORD_READS` bounds.
 */
const readsOut = new WeakMap<CacheRuntime, Map<RecordRead, number>>();
/**
 * A timed-out background authority call keeps its slot until its underlying work actually settles.
 * A host that never settles can exhaust this budget until the isolate is replaced. Releasing its
 * slot on a deadline would allow unbounded uncancellable I/O instead; fresh memo hits still work.
 */
const retainedReads = new WeakSet<RecordRead>();

/**
 * Keep what a read said for the requests after it, once it has said it, and only while it is still
 * the entry's read: one a regeneration overtook (`forgetRecord`) says what the entry was. A read
 * that failed is not kept, and the next request asks again.
 */
async function land(runtime: CacheRuntime, entryId: string, read: RecordRead): Promise<void> {
  try {
    const pack = await read.pack;
    if (runtime.recordReads.get(entryId) === read) {
      runtime.recordMemo.set(entryId, pack);
    }
  } catch {
    // What went wrong is for the requests that waited on the read to say, under their deadlines.
  } finally {
    if (runtime.recordReads.get(entryId) === read) {
      runtime.recordReads.delete(entryId);
    }
    readsOut.get(runtime)?.delete(read);
    retainedReads.delete(read);
  }
}

/** How many reads of records may be in flight at once, as many as their memory keeps records. */
const MAX_RECORD_READS = 256;

/** The runtime's reads still out, once those out longer than a read can be are let go. */
function stillOut(runtime: CacheRuntime): Map<RecordRead, number> {
  let reads = readsOut.get(runtime);
  if (reads === undefined) {
    reads = new Map();
    readsOut.set(runtime, reads);
  }
  const now = performance.now();
  for (const [read, since] of reads) {
    if (!retainedReads.has(read) && now - since >= RECORD_READ_LIFETIME_MS) {
      reads.delete(read);
    }
  }
  return reads;
}

/**
 * Let go of the reads begun more than a hold ago, which no request joins any more, and of the
 * oldest beyond the budget. A read leaves on its own only once it settles (`land`), and one the
 * host never answers — or whose `waitUntil` the runtime cut short — never does: every entry a
 * visitor named while the host hung was otherwise kept for as long as the isolate lived.
 */
function sweepReads(runtime: CacheRuntime, now: number): void {
  const reads = runtime.recordReads;
  for (const [entryId, read] of reads) {
    if (reads.size < MAX_RECORD_READS && now - read.startedAt < runtime.holdMs) {
      return;
    }
    reads.delete(entryId);
  }
}

/**
 * The entry's read in flight, joined; or one begun, and handed to the runtime (`waitUntil`) so that
 * it lands in memory whenever it answers.
 *
 * Each request used to read for itself, and to throw away what came after its deadline: while the
 * host was slow to answer, every request for the entry waited the whole deadline, and none of them
 * left the next one anything. Now a read that outlives the request that began it is what the next
 * request finds, and the requests that come while it runs wait on that one read — each no longer
 * than its own deadline. A read begun more than a hold ago is not joined but begun again, so one
 * that never answers is not what every later request waits on.
 */
function sharedRead(
  runtime: CacheRuntime,
  entryId: string,
  now: number,
  waitUntil: (promise: Promise<unknown>) => void,
): RecordRead {
  const joined = runtime.recordReads.get(entryId);
  if (joined !== undefined && now - joined.startedAt < runtime.holdMs) {
    return joined;
  }
  // As many out as the budget lets, joined or not: past it the host is not answering them, and
  // another read would wait out its deadline as they do, for nothing.
  const out = stillOut(runtime);
  if (out.size >= MAX_RECORD_READS) {
    throw new Error(`${String(MAX_RECORD_READS)} reads of records are out already`);
  }
  const began = performance.now();
  const read: RecordRead = { startedAt: now, pack: readRecordPack(runtime, entryId) };
  out.set(read, began);
  // Taken out before it is put back, so that the reads stand in the order they were begun, and
  // the ones past their hold are the first to be let go.
  runtime.recordReads.delete(entryId);
  sweepReads(runtime, now);
  runtime.recordReads.set(entryId, read);
  waitUntil(land(runtime, entryId, read));
  return read;
}

/** Track background authority I/O in the existing actual-pending budget, including late calls. */
function retainedNewerRead(
  runtime: CacheRuntime,
  work: () => Promise<DecodedGenerationPack | undefined>,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<DecodedGenerationPack | null> {
  const out = stillOut(runtime);
  if (out.size >= MAX_RECORD_READS)
    throw new Error(`${String(MAX_RECORD_READS)} reads of records are out already`);
  const began = performance.now();
  const keep = async (): Promise<DecodedGenerationPack | null> => {
    const pack = await work();
    return pack ?? null;
  };
  const read: RecordRead = { startedAt: nowMs(), pack: keep() };
  out.set(read, began);
  retainedReads.add(read);
  waitUntil(releaseRetainedRead(runtime, read));
  return read.pack;
}

async function releaseRetainedRead(runtime: CacheRuntime, read: RecordRead): Promise<void> {
  try {
    await read.pack;
  } catch {
    /* The lookup reports the failure; its budget still waits for settlement. */
  } finally {
    readsOut.get(runtime)?.delete(read);
    retainedReads.delete(read);
  }
}

/**
 * Let go of what this isolate holds of an entry's record, and of a read of it still in flight,
 * which lands nowhere now: a regeneration has overtaken both, and the next request for the entry
 * asks the host again.
 */
export function forgetRecord(runtime: CacheRuntime, entryId: string): void {
  runtime.recordMemo.delete(entryId);
  runtime.recordReads.delete(entryId);
}

/**
 * `forgetRecord`, where what this isolate holds of the entry is a generation earlier than `seq`: a
 * regeneration given back to generation `seq` lets go of the one it judged, and keeps a record of
 * that generation or a later one that another request of the isolate learned meanwhile.
 */
export function forgetRecordBefore(runtime: CacheRuntime, entryId: string, seq: number): void {
  const held = runtime.recordMemo.get(entryId);
  if (held !== undefined && held !== null && held.header.seq >= seq) {
    return;
  }
  forgetRecord(runtime, entryId);
}

/** Whether a visitor may be answered with `pack` as it says (`servable`). */
function servableRecord(pack: DecodedGenerationPack): boolean {
  return servable(pack.header.status, pack.header.headers);
}

/**
 * Hold `pack` as what this isolate knows of the entry, for a hold, in place of a read still in
 * flight, which lands nowhere now — unless what it holds already is a later generation still, which
 * a commit or a read that answered first left it: the later of the two is held, and returned. A
 * later one no visitor may be answered with gives way to `pack` where a visitor may be with it, so
 * the requests after this one are answered from what this one was.
 */
export function rememberRecord(
  runtime: CacheRuntime,
  entryId: string,
  pack: DecodedGenerationPack,
): DecodedGenerationPack {
  const held = runtime.recordMemo.get(entryId);
  const later =
    held !== undefined &&
    held !== null &&
    held.header.seq > pack.header.seq &&
    (servableRecord(held) || !servableRecord(pack))
      ? held
      : pack;
  forgetRecord(runtime, entryId);
  runtime.recordMemo.set(entryId, later);
  return later;
}

/**
 * The entry's id, derived once per isolate: it is the same for the scope's every request.
 *
 * Two requests that find it missing at once each derive it. A derivation under way is work of the
 * request that began it, and the Workers runtime drops what a request left out once that request
 * has ended: a second request waiting on it could wait on something that never settles, for a
 * digest that costs less than the wait.
 */
export async function entryIdOf(
  runtime: CacheRuntime,
  descriptor: RouteEntryDescriptor,
): Promise<string> {
  const key = JSON.stringify([descriptor.kind, descriptor.route, descriptor.pathname]);
  const known = runtime.entryIds.get(key);
  if (known !== undefined) {
    return known;
  }
  const { entryId } = await deriveEntry(runtime.scopeId, descriptor);
  runtime.entryIds.set(key, entryId);
  return entryId;
}

/** How far each state keeps a generation from being answered; `unknown` is served as `fresh` is. */
const SEVERITY: Readonly<Record<Validity, number>> = { fresh: 0, unknown: 0, stale: 1, expired: 2 };

function worse(a: Validity, b: Validity): Validity {
  return SEVERITY[b] > SEVERITY[a] ? b : a;
}

/**
 * How a record stands at `now`: what it says of itself, and what this isolate knows of its tags.
 *
 * What this isolate knows of the generation's tags counts as well: its own invalidation is in force
 * here at once (`applyLocal`), and the record — read through the host, and kept for a hold — may say
 * nothing of it yet. Judged on the record alone, a page revalidated by this Function went on being
 * answered as it was until the hold ran out.
 *
 * Read, not synced: `syncLocal` here would be a round trip on the path a Function answers a document
 * from. What this isolate did itself is kept for it whatever else it is told (`MAX_APPLIED_MARKS`);
 * another isolate's invalidation reaches the record, which is what is being judged, within the lag
 * its own read already has.
 */
function judged(runtime: CacheRuntime, pack: DecodedGenerationPack, now: number): Validity {
  const { header } = pack;
  const { validity: recorded } = evaluateFreshness({
    policy: header.policy,
    cacheTimestamp: header.cacheTimestamp,
    invalidation: header.invalidation,
    now,
  });
  const tagged = runtime.tags.validityOf(
    header.tags.map((tag) => tag.value),
    header.cacheTimestamp ?? header.producedAt ?? 0,
    now,
  );
  return worse(recorded, tagged);
}

/**
 * The record a host handed back with its answer for a lease (`AttemptOutcome.record`), as the
 * generation it named current there (`carried.generationId`): held as what this isolate knows of
 * the entry (`rememberRecord`) and judged as a record read is. `undefined` where none came back,
 * where the bytes are not that generation's record, or where what this isolate knows of it keeps it
 * from being served as it stands: it may not be served, or is not fresh by then.
 */
export async function carriedGeneration(
  runtime: CacheRuntime,
  entryId: string,
  carried: { readonly record: Uint8Array | undefined; readonly generationId: string },
  now: number,
): Promise<CurrentGeneration | undefined> {
  const pack = await publishedRecordOf(carried.record, entryId, carried.generationId);
  if (pack === undefined || !servableRecord(pack)) {
    return undefined;
  }
  const held = rememberRecord(runtime, entryId, pack);
  const validity = judged(runtime, held, now);
  return SEVERITY[validity] > SEVERITY.fresh ? undefined : { entryId, pack: held, validity };
}

/**
 * The later of `newer` — what the host keeps nearer than its read — and what this isolate came to
 * hold of the entry while it was asked for, a record another request's commit or read left, where
 * either is later than generation `than` and one a visitor may be answered with (`servable`): a
 * redirect that says not where to is no generation to serve in place of one judged stale.
 */
function laterOf(
  runtime: CacheRuntime,
  entryId: string,
  newer: DecodedGenerationPack | undefined,
  than: number,
): DecodedGenerationPack | undefined {
  const held = runtime.recordMemo.get(entryId) ?? undefined;
  const later = [newer, held].filter((candidate): candidate is DecodedGenerationPack => {
    return (
      candidate !== undefined &&
      candidate.header.seq > than &&
      servable(candidate.header.status, candidate.header.headers)
    );
  });
  return later.toSorted((a, b) => b.header.seq - a.header.seq)[0];
}

/**
 * The entry's current generation and how it stands at `now`; unavailable when the host is, or when
 * it is slower than the deadline. `waitUntil` is the request's, and keeps a read it begins going.
 *
 * Where the read found no record, or one no longer fresh, a later one the host keeps nearer than
 * its read is asked for (`readNewerRecord`) and taken when it stands no worse: a host whose reads
 * are cached answers with the generation a later one replaced, or with none, for as long as its
 * cache keeps that answer — after another isolate of this Function published the later one, which
 * every request in between would otherwise render again, each its own. A fresh record is served as
 * it was read, and nothing more is asked.
 */
export async function currentGeneration(
  runtime: CacheRuntime,
  descriptor: RouteEntryDescriptor,
  now: number,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<CurrentLookup> {
  const entryId = await entryIdOf(runtime, descriptor);
  let pack: DecodedGenerationPack | null;
  let read: RecordRead | undefined;
  let until: number | undefined;
  try {
    const remembered = runtime.recordMemo.get(entryId);
    if (remembered === undefined) {
      read = sharedRead(runtime, entryId, now, waitUntil);
      const began = readsOut.get(runtime)?.get(read);
      until = began === undefined ? 0 : began + RECORD_READ_LIFETIME_MS;
      pack = await withDeadline(read.pack, RECORD_DEADLINE_MS, 'delivery record');
    } else {
      pack = remembered;
    }
  } catch (error) {
    runtime.log('delivery record not read', { entryId, detail: detail(error) });
    return {
      kind: 'unavailable',
      entryId,
      ...(read !== undefined && { pending: { entryId, read, until: until ?? 0 } }),
    };
  }
  const validity = pack === null ? undefined : judged(runtime, pack, now);
  if (validity === undefined || SEVERITY[validity] > SEVERITY.fresh) {
    return finishLookup(runtime, { entryId, pack, validity, now });
  }
  if (pack === null) return { kind: 'none', entryId };
  return { kind: 'generation', current: { entryId, pack, validity } };
}

/** A verified memo publication needs no upgrade or authority call. */
function freshMemo(
  runtime: CacheRuntime,
  entryId: string,
  pack: DecodedGenerationPack | null | undefined,
): CurrentLookup | undefined {
  if (pack === undefined || pack === null) return undefined;
  const validity = judged(runtime, pack, nowMs());
  return SEVERITY[validity] === SEVERITY.fresh
    ? { kind: 'generation', current: { entryId, pack, validity } }
    : undefined;
}

/** Join the exact primary call within its original lifetime, even if the mutable join table changed. */
async function backgroundPack(
  runtime: CacheRuntime,
  entryId: string,
  waitUntil: (promise: Promise<unknown>) => void,
  pending?: PendingRecordLookup,
): Promise<{ readonly pack: DecodedGenerationPack | null; readonly until: number }> {
  const read =
    pending?.read ??
    runtime.recordReads.get(entryId) ??
    sharedRead(runtime, entryId, nowMs(), waitUntil);
  const began = readsOut.get(runtime)?.get(read);
  const until = pending?.until ?? (began === undefined ? 0 : began + RECORD_READ_LIFETIME_MS);
  const remaining = until - performance.now();
  if (remaining <= 0) throw new Error('background delivery record lifetime exhausted');
  retainedReads.add(read);
  const pack = await withDeadline(read.pack, remaining, 'background delivery record');
  return { pack, until };
}

/**
 * The same verified lookup behind a partial response, once its first bytes are on their way
 * (`withPartialFallbackUpgrade`). Its primary read is shared with the foreground lookup, but the
 * visitor's 200ms budget no longer discards the upgrade. The shared read's original monotonic
 * lifetime bounds the complete lookup, including any newer record read; this cannot give an old
 * pending read another thirty seconds. Fresh memo hits ask nothing, and a failed, lost or late read
 * never authorizes regeneration.
 */
export async function currentGenerationAfterResponse(
  runtime: CacheRuntime,
  descriptor: RouteEntryDescriptor,
  waitUntil: (promise: Promise<unknown>) => void,
  pending?: PendingRecordLookup,
): Promise<CurrentLookup> {
  const entryId = await entryIdOf(runtime, descriptor);
  if (pending !== undefined && pending.entryId !== entryId) return { kind: 'unavailable', entryId };
  let until = pending?.until ?? performance.now() + RECORD_READ_LIFETIME_MS;
  let pack = runtime.recordMemo.get(entryId);
  try {
    // Another request's verified fresh publication needs no upgrade, even if the original read
    // was retired or ran out its lifetime before this lookup began.
    const fresh = freshMemo(runtime, entryId, pack);
    if (fresh !== undefined) return fresh;
    if (pending !== undefined || pack === undefined) {
      const read = await backgroundPack(runtime, entryId, waitUntil, pending);
      pack = read.pack;
      until = read.until;
    }
    if (performance.now() >= until) return { kind: 'unavailable', entryId };
    // A commit may have overtaken the pending read. Never decide to replace its older generation.
    pack = laterOf(runtime, entryId, undefined, pack?.header.seq ?? 0) ?? pack;
    const now = nowMs();
    const validity = pack === null ? undefined : judged(runtime, pack, now);
    if (validity === undefined || SEVERITY[validity] > SEVERITY.fresh) {
      return await finishLookup(runtime, { entryId, pack, validity, now }, { until, waitUntil });
    }
    if (pack === null) return { kind: 'none', entryId };
    return { kind: 'generation', current: { entryId, pack, validity } };
  } catch (error) {
    runtime.log('background delivery record not read', { entryId, detail: detail(error) });
    return { kind: 'unavailable', entryId };
  }
}

/** The existing optional newer-record decision, within a background lookup's remaining lifetime. */
async function finishLookup(
  runtime: CacheRuntime,
  snapshot: {
    readonly entryId: string;
    readonly pack: DecodedGenerationPack | null;
    readonly validity: Validity | undefined;
    readonly now: number;
  },
  background?: { readonly until: number; readonly waitUntil: (promise: Promise<unknown>) => void },
): Promise<CurrentLookup> {
  const { entryId, pack, validity, now } = snapshot;
  const remaining =
    background === undefined ? NEWER_RECORD_DEADLINE_MS : background.until - performance.now();
  if (remaining <= 0) return { kind: 'unavailable', entryId };
  const than = pack?.header.seq ?? 0;
  const newer = laterOf(
    runtime,
    entryId,
    await newerPack(
      runtime,
      entryId,
      than,
      background === undefined
        ? undefined
        : { deadlineMs: remaining, waitUntil: background.waitUntil },
    ),
    than,
  );
  if (background !== undefined && performance.now() >= background.until)
    return { kind: 'unavailable', entryId };
  // A background read can take seconds. Rejudge after its last wait, including local invalidations.
  const observedAt = background === undefined ? now : nowMs();
  const standing =
    background === undefined || pack === null ? validity : judged(runtime, pack, observedAt);
  const later = newer === undefined ? undefined : judged(runtime, newer, observedAt);
  if (
    newer !== undefined &&
    later !== undefined &&
    (standing === undefined || SEVERITY[later] <= SEVERITY[standing])
  ) {
    // What a commit of this isolate's left meanwhile may be later still (rememberRecord).
    const held = rememberRecord(runtime, entryId, newer);
    const state = held === newer ? later : judged(runtime, held, observedAt);
    return { kind: 'generation', current: { entryId, pack: held, validity: state } };
  }
  if (pack === null || standing === undefined) return { kind: 'none', entryId };
  return { kind: 'generation', current: { entryId, pack, validity: standing } };
}
