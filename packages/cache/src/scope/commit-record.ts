import { routeEntryKindSchema } from '@stayingupwind/core/cache';
import type { StartAttemptResponse } from '@stayingupwind/host/cache';

import type { CommitOutcome } from './commit.ts';
import { findEntry } from './entries.ts';
import { findGeneration } from './generations.ts';
import { retain, withProjectionMemoryAtOnce } from './projection-memory.ts';
import { generationRecordBytes, packMemoryOf, type RecordDeps, recordBytesOf } from './records.ts';
import type { EntryRow, GenerationRow } from './rows.ts';
import { dropRecordBytes, type WantedRecords, type WrittenRecord } from './settle.ts';
import { isRefusal, type Refusal } from './state.ts';

const KIB = 1024;
const MAX_RETURNED_RECORD_MIB = 4;
/**
 * The largest delivery record a commit is answered with: what the Function keeps of one in its data
 * center's Cache API at the most (`function/record-copies.ts`). A larger record is read through
 * KV.
 */
const MAX_RETURNED_RECORD_BYTES = MAX_RETURNED_RECORD_MIB * KIB * KIB;

/** What a commit asks its own settle run to hand back, and how it lets go of what it was handed. */
export interface CommitRecords extends WantedRecords {
  /**
   * Give back the room in the isolate's budget the bytes it wanted are charged to (`retain`): once
   * the commit is answered, or fails, by the object that answers it.
   */
  readonly release: () => void;
}

/**
 * What a commit asks its own settle run to hand back (`WantedRecords`): its entry's record where it
 * could travel back, and no other entry's — a run that rewrites a page of records behind, after a
 * broad invalidation say, holds none of theirs past its write. The entry is named once the commit
 * has published (`entryOf`). A record it wants outlives the chunk that built it, until the commit
 * is answered with it: its bytes are charged to the isolate's room as it is wanted, while that
 * chunk still holds its own, and until the commit lets them go (`release`) — or until the run lets
 * them go before it waits for room (`letGo`), and the commit is answered without its record, as
 * one too large to travel back is (`withWrittenRecord`).
 */
export function wantedRecords(entryOf: () => string | undefined): CommitRecords {
  const kept: (() => void)[] = [];
  const records = new Map<string, WrittenRecord>();
  const release = (): void => {
    for (const letGo of kept.splice(0)) {
      letGo();
    }
  };
  return {
    wants: (entryId, bytes) => {
      if (bytes > MAX_RETURNED_RECORD_BYTES || entryId !== entryOf()) {
        return false;
      }
      kept.push(retain(bytes));
      return true;
    },
    records,
    letGo: () => {
      release();
      dropRecordBytes(records);
    },
    release,
  };
}

/** What reading the scope's state and building a record from it needs. */
type StandingDeps = RecordDeps & { readonly sql: SqlStorage };

/**
 * The entry's record revision where its record has been written and acknowledged at it — by
 * whichever settle run — and the entry is not retired; none otherwise.
 */
function writtenRevision(deps: StandingDeps, entryId: string): number | undefined {
  const entry = findEntry(deps.sql, entryId);
  return entry === undefined ||
    entry.publication === 'retired' ||
    entry.kv_revision < entry.record_revision
    ? undefined
    : entry.record_revision;
}

/**
 * The entry's record revision where generation `generationId` stands for it, its record written and
 * acknowledged (`writtenRevision`); none otherwise.
 */
function standingRevision(
  deps: StandingDeps,
  entryId: string,
  generationId: string,
): number | undefined {
  return findEntry(deps.sql, entryId)?.current_generation_id === generationId
    ? writtenRevision(deps, entryId)
    : undefined;
}

/**
 * The entry's delivery record as KV holds it, where generation `generationId` still stands and its
 * record has been written and acknowledged — by whichever settle run: a commit whose generation
 * another run's projection reached first finds no record of its own (`written`). Built again from
 * the generation, outside the scope's queue: only where it could travel back at all
 * (`recordBytesOf`, before anything is read), and only where the same record still stands
 * once it is built. None otherwise, none where its bytes cannot be read, and none where the isolate
 * has no room to build it at once (`builtRecord`): the commit is then answered without a record.
 */
async function standingRecord(
  deps: StandingDeps,
  entryId: string,
  generationId: string,
): Promise<Uint8Array | undefined> {
  const revision = standingRevision(deps, entryId, generationId);
  const entry = findEntry(deps.sql, entryId);
  const generation = findGeneration(deps.sql, generationId);
  if (revision === undefined || entry === undefined || generation === undefined) {
    return undefined;
  }
  const bytes = await builtRecord(deps, entry, generation);
  return bytes !== undefined && standingRevision(deps, entryId, generationId) === revision
    ? bytes
    : undefined;
}

/**
 * `generation`'s delivery record as `entry`'s, built as a settle builds it, where it could travel
 * back at all (`recordBytesOf`, before anything is read); none otherwise, and none where its bytes
 * cannot be read.
 *
 * Built in the isolate's room for records, as a settle's chunk is (`projection-memory.ts`), and only
 * where there is room for it at once: the answers it is built for — a lease's, which a request may
 * wait on before its first byte — wait for none, and go without it where there is none, as they go
 * without one too large to travel back. Built outside that room, the answers for leases of a page
 * KV is behind, busy or not, would each hold a record of up to 4 MiB beside the settle runs' and
 * one another's, past what the isolate has.
 */
async function builtRecord(
  deps: StandingDeps,
  entry: EntryRow,
  generation: GenerationRow,
): Promise<Uint8Array | undefined> {
  // A data entry's record is a value, not a pack: none is handed back, and a pack's header is laid
  // out for a route entry alone.
  if (!routeEntryKindSchema.safeParse(entry.kind).success) {
    return undefined;
  }
  try {
    // Measured and built alike behind the catch: what cannot be laid out is answered without a
    // record.
    const bytes = recordBytesOf(deps.scopeId, entry, generation);
    if (bytes > MAX_RETURNED_RECORD_BYTES) {
      return undefined;
    }
    return await withProjectionMemoryAtOnce(packMemoryOf(bytes), () =>
      generationRecordBytes(deps, entry, generation),
    );
  } catch {
    return undefined;
  }
}

/**
 * The entry's record revision where generation `generationId` is its current one and it is not
 * retired, whether or not KV has that record yet; none otherwise.
 */
function currentRevision(
  deps: StandingDeps,
  entryId: string,
  generationId: string,
): number | undefined {
  const entry = findEntry(deps.sql, entryId);
  return entry === undefined ||
    entry.publication === 'retired' ||
    entry.current_generation_id !== generationId
    ? undefined
    : entry.record_revision;
}

/**
 * The delivery record of generation `generationId` as the entry's current one, built as a settle
 * builds it whether or not KV has it yet — the request it is for read KV behind it — and only where
 * the same generation still stands at the same revision once it is built.
 */
async function currentRecord(
  deps: StandingDeps,
  entryId: string,
  generationId: string,
): Promise<Uint8Array | undefined> {
  const revision = currentRevision(deps, entryId, generationId);
  const entry = findEntry(deps.sql, entryId);
  const generation = findGeneration(deps.sql, generationId);
  if (revision === undefined || entry === undefined || generation === undefined) {
    return undefined;
  }
  const bytes = await builtRecord(deps, entry, generation);
  return bytes !== undefined && currentRevision(deps, entryId, generationId) === revision
    ? bytes
    : undefined;
}

/** An answer for a lease as the scope gives it to the gateway, with the record it carries. */
export type StartAttemptOutcome = StartAttemptResponse & {
  /** The current generation's record, where the request judged an earlier one (`withCurrentRecord`). */
  readonly recordBytes?: Uint8Array | undefined;
};

/**
 * An answer for a lease, handed out or not, with the delivery record of the entry's current
 * generation (`recordBytes`) where the request named an earlier one it judged (`replaces`) and the
 * current one stands, condemned by no invalidation: a Function that read KV behind it answers its
 * request from that record rather than with a render of its own, which no other request is
 * answered with. None where the request named no generation, or the one it judged is the current;
 * none either where the isolate has no room to build it at once (`builtRecord`), and the request
 * is answered as for a record too large to travel back.
 */
export async function withCurrentRecord(
  answer: StartAttemptResponse | Refusal,
  replaces: string | null | undefined,
  deps: StandingDeps,
): Promise<StartAttemptOutcome | Refusal> {
  if (replaces === undefined || isRefusal(answer)) {
    return answer;
  }
  const { current } = answer;
  if (current === null || current.generationId === replaces || current.condemned !== null) {
    return answer;
  }
  const recordBytes = await currentRecord(deps, answer.entryId, current.generationId);
  return recordBytes === undefined ? answer : { ...answer, recordBytes };
}

/**
 * A commit's answer, once published with the delivery record written for the entry
 * (`recordBytes`) where it is small enough to travel back: the Function keeps it nearer than KV,
 * whose cache in a data center goes on answering with the generation it replaced. The record is the
 * one the commit's own settle wrote, while the entry's record still stands at the revision it was
 * written for, whichever generation it holds — a change that committed once it was written, a path
 * invalidated say, has another one written or on its way — or else the one standing for the
 * generation it published where another run wrote it (`standingRecord`). One its own settle wrote
 * and let go of before it waited for room (`WantedRecords.letGo`) is not built again: while it
 * stands, the answer says where it stands alone (`recordRevision`). The entry is named once the
 * commit has published (`entryOf`): no other answer needs it.
 */
export async function withWrittenRecord(
  committed: Promise<CommitOutcome | Refusal>,
  written: ReadonlyMap<string, WrittenRecord>,
  entryOf: () => string | undefined,
  deps: StandingDeps,
): Promise<CommitOutcome | Refusal> {
  const outcome = await committed;
  if (isRefusal(outcome) || outcome.kind !== 'published') {
    return outcome;
  }
  const entryId = entryOf();
  if (entryId === undefined) {
    return outcome;
  }
  const own = written.get(entryId);
  const recordBytes =
    own !== undefined && writtenRevision(deps, entryId) === own.revision
      ? own.bytes
      : await standingRecord(deps, entryId, outcome.generationId);
  if (recordBytes !== undefined && recordBytes.byteLength <= MAX_RETURNED_RECORD_BYTES) {
    return { ...outcome, recordBytes };
  }
  // No record travels back: where the entry's record stands, for the Function to tell the copies
  // that are behind it from one another commit handed back meanwhile (`recordRevision`).
  const recordRevision = findEntry(deps.sql, entryId)?.record_revision;
  return recordRevision === undefined ? outcome : { ...outcome, recordRevision };
}

/**
 * A commit's answer (`withWrittenRecord`), and what its run handed back let go of as it is given —
 * answered or failed: the record's room in the isolate's budget goes with it (`CommitRecords`).
 */
export async function answerCommit(
  committed: Promise<CommitOutcome | Refusal>,
  wanted: CommitRecords,
  entryOf: () => string | undefined,
  deps: StandingDeps,
): Promise<CommitOutcome | Refusal> {
  try {
    return await withWrittenRecord(committed, wanted.records, entryOf, deps);
  } finally {
    wanted.release();
  }
}
