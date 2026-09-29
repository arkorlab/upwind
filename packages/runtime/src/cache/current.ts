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

/** An entry's record as the pack it holds; `null` for none, or for bytes that are not one. */
async function readRecordPack(
  runtime: CacheRuntime,
  entryId: string,
): Promise<DecodedGenerationPack | null> {
  const bytes = await runtime.host.readRecord(entryId);
  if (bytes === undefined) {
    return null;
  }
  const decoded = decodeGenerationPack(bytes);
  return decoded.kind === 'ok' && (await verifyGenerationPack(decoded.pack)) ? decoded.pack : null;
}

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
  }
}

/** How many reads of records may be in flight at once, as many as their memory keeps records. */
const MAX_RECORD_READS = 256;

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
  const read: RecordRead = { startedAt: now, pack: readRecordPack(runtime, entryId) };
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
 * The entry's current generation and how it stands at `now`; unavailable when the host is, or when
 * it is slower than the deadline. `waitUntil` is the request's, and keeps a read it begins going.
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
  if (pack === null) {
    return { kind: 'none', entryId };
  }
  const { header } = pack;
  const { validity: recorded } = evaluateFreshness({
    policy: header.policy,
    cacheTimestamp: header.cacheTimestamp,
    invalidation: header.invalidation,
    now,
  });
  // What this isolate knows of the generation's tags counts as well: its own invalidation is in
  // force here at once (`applyLocal`), and the record — read through the host, and kept for a
  // hold — may say nothing of it yet. Judged on the record alone, a page revalidated by this
  // Function went on being answered as it was until the hold ran out.
  //
  // Read, not synced: `syncLocal` here would be a round trip on the path a Function answers a
  // document from. What this isolate did itself is kept for it whatever else it is told
  // (`MAX_APPLIED_MARKS`); another isolate's invalidation reaches the record, which is what the
  // rest of this function is judging, within the lag its own read already has.
  const tagged = runtime.tags.validityOf(
    header.tags.map((tag) => tag.value),
    header.cacheTimestamp ?? header.producedAt ?? 0,
    now,
  );
  return { kind: 'generation', current: { entryId, pack, validity: worse(recorded, tagged) } };
}
