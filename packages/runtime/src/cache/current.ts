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

import type { CacheRuntime, RecordRead } from './runtime.ts';

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
  | { readonly kind: 'unavailable'; readonly entryId: string };

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
 * An entry's record as the pack it holds; `null` for none, or for bytes that are not one. The read
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
  let bytes: Uint8Array | undefined;
  try {
    bytes = await runtime.host.readRecord(entryId, calledOff.signal);
  } finally {
    clearTimeout(timer);
  }
  if (bytes === undefined) {
    return null;
  }
  const decoded = decodeGenerationPack(bytes);
  return decoded.kind === 'ok' && (await verifyGenerationPack(decoded.pack)) ? decoded.pack : null;
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
): Promise<DecodedGenerationPack | undefined> {
  const { host } = runtime;
  if (host.readNewerRecord === undefined) {
    return undefined;
  }
  // The read, the decoding and the check together under the deadline: a record is hashed to be
  // checked, and a long one past a quick read would keep the document waiting all the same.
  const read = async (): Promise<DecodedGenerationPack | undefined> => {
    const bytes = await host.readNewerRecord?.(entryId, than);
    return bytes === undefined ? undefined : recordPackOf(bytes, entryId);
  };
  try {
    const pack = await withDeadline(read(), NEWER_RECORD_DEADLINE_MS, 'a later delivery record');
    return pack !== undefined && pack.header.seq > than ? pack : undefined;
  } catch (error) {
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
    if (now - since >= RECORD_READ_LIFETIME_MS) {
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
): Promise<DecodedGenerationPack | null> {
  const joined = runtime.recordReads.get(entryId);
  if (joined !== undefined && now - joined.startedAt < runtime.holdMs) {
    return joined.pack;
  }
  // As many out as the budget lets, joined or not: past it the host is not answering them, and
  // another read would wait out its deadline as they do, for nothing.
  const out = stillOut(runtime);
  if (out.size >= MAX_RECORD_READS) {
    return Promise.reject(
      new Error(`${String(MAX_RECORD_READS)} reads of records are out already`),
    );
  }
  const read: RecordRead = { startedAt: now, pack: readRecordPack(runtime, entryId) };
  out.set(read, performance.now());
  // Taken out before it is put back, so that the reads stand in the order they were begun, and
  // the ones past their hold are the first to be let go.
  runtime.recordReads.delete(entryId);
  sweepReads(runtime, now);
  runtime.recordReads.set(entryId, read);
  waitUntil(land(runtime, entryId, read));
  return read.pack;
}

async function readPack(
  runtime: CacheRuntime,
  entryId: string,
  now: number,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<DecodedGenerationPack | null> {
  const remembered = runtime.recordMemo.get(entryId);
  if (remembered !== undefined) {
    return remembered;
  }
  return withDeadline(
    sharedRead(runtime, entryId, now, waitUntil),
    RECORD_DEADLINE_MS,
    'delivery record',
  );
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
 * Hold `pack` as what this isolate knows of the entry, for a hold, in place of a read still in
 * flight, which lands nowhere now — unless what it holds already is a later generation still, which
 * a commit or a read that answered first left it: the later of the two is held, and returned.
 */
export function rememberRecord(
  runtime: CacheRuntime,
  entryId: string,
  pack: DecodedGenerationPack,
): DecodedGenerationPack {
  const held = runtime.recordMemo.get(entryId);
  const later =
    held !== undefined && held !== null && held.header.seq > pack.header.seq ? held : pack;
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
async function entryIdOf(runtime: CacheRuntime, descriptor: RouteEntryDescriptor): Promise<string> {
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
  try {
    pack = await readPack(runtime, entryId, now, waitUntil);
  } catch (error) {
    runtime.log('delivery record not read', { entryId, detail: detail(error) });
    return { kind: 'unavailable', entryId };
  }
  const validity = pack === null ? undefined : judged(runtime, pack, now);
  if (validity === undefined || SEVERITY[validity] > SEVERITY.fresh) {
    const newer = await newerPack(runtime, entryId, pack?.header.seq ?? 0);
    const later = newer === undefined ? undefined : judged(runtime, newer, now);
    if (
      newer !== undefined &&
      later !== undefined &&
      (validity === undefined || SEVERITY[later] <= SEVERITY[validity])
    ) {
      // What a commit of this isolate's left meanwhile may be later still.
      const held = rememberRecord(runtime, entryId, newer);
      const standing = held === newer ? later : judged(runtime, held, now);
      return { kind: 'generation', current: { entryId, pack: held, validity: standing } };
    }
  }
  if (pack === null || validity === undefined) {
    return { kind: 'none', entryId };
  }
  return { kind: 'generation', current: { entryId, pack, validity } };
}
