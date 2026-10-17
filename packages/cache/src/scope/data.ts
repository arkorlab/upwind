import {
  artifactIdFor,
  type CachePolicy,
  finiteSeconds,
  GENERATION_ID_PREFIX,
  type GenerationTag,
  type InvalidationState,
  type OutputSnapshot,
  tagKindOf,
} from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { type DataEntryMetadata } from '@stayingupwind/host/cache';

import { addedBytesOf, findArtifactBySha, referenceArtifact } from './artifacts.ts';
import { reservedBytes } from './attempts.ts';
import { controlFenceFloorInvalidations, controlFenceInvalidations } from './control-fences.ts';
import {
  type EntryIdentity,
  findEntry,
  identifyEntry,
  insertEntry,
  publishEntry,
  requireEntry,
} from './entries.ts';
import { foldsFrom } from './folded-invalidations.ts';
import {
  condemnedOf,
  findGeneration,
  insertGeneration,
  supersedeGeneration,
} from './generations.ts';
import type { EventInput } from './history.ts';
import { type IsrWrite, isrWriteOf, sameOutputs } from './metering.ts';
import {
  type EntryRow,
  generationOutputs,
  type GenerationRow,
  toEntry,
  toEntryState,
  toPublicGeneration,
} from './rows.ts';
import { isRefusal, type Refusal, refuse, requireActiveScope } from './state.ts';
import { replaceEntryTags, type TagRef, tagRefsFor } from './tags.ts';
import type { TimedPart } from './timing.ts';
import { type Apply, record, type TxInput } from './tx.ts';

/**
 * The data caches — `fetch` and `use cache` — as entries of the scope. A value is a generation
 * like any other: one output, one artifact, the lifetime Next.js gave it, the tags it named. The
 * bytes were stored by the gateway before this runs; the delivery record is written after.
 */

const OUTPUT_ID_PREFIX = 'out';
const DATA_VALUE = 'data-value';

interface DataValueUpload {
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly storageRef: string;
}

/**
 * Where a write stands among the writes its writer sent: the writer — one isolate of an
 * application's Function — and a count it raises with each write it sends.
 */
export interface WriteOrder {
  readonly writer: string;
  readonly seq: number;
}

export interface DataSetInput {
  readonly key: string;
  readonly entry: DataEntryMetadata;
  readonly value: DataValueUpload;
  /** Where the write stands among its writer's (`writtenAfter`), when its writer says. */
  readonly order?: WriteOrder | undefined;
  /**
   * The value's bytes as the gateway stored them, where the value is small (its `CARRIED_VALUE_BYTES`):
   * what the write's own settle makes the value's record of, rather than read back from storage what
   * was stored a moment before (`CarriedValue`).
   */
  readonly bytes?: Uint8Array | undefined;
}

export interface DataSetOutcome {
  readonly entryId: string;
  readonly generationId: string;
  /** The adopted generation's dependency revision, also for an unchanged write. */
  readonly revision: number;
  /**
   * The adopted generation as an invalidation left it — an unchanged write's since it was made, a
   * new one's on arrival: the writer remembers what it wrote, and must not remember as fresh what
   * a read of the entry would call condemned.
   */
  readonly invalidation?: InvalidationState;
  /**
   * Set when the entry has a later write of this one's writer, or has had this one already,
   * whatever came between: nothing was written, and the generation named is that write's
   * (`writtenAfter`).
   */
  readonly superseded?: true;
  /** Internal only: the upload adopted by the content-addressed artifact row, if one was. */
  readonly retainedStorageRef?: string | undefined;
  /** Internal only: the write a new value made, for the gateway to meter (`metering.ts`). */
  readonly metered?: IsrWrite | undefined;
  /** Internal only: how long the scope's object took over each part of the write (`Timing`). */
  readonly timing?: readonly TimedPart[] | undefined;
}

interface DataPlan {
  readonly input: DataSetInput;
  readonly identity: EntryIdentity;
  readonly tagRefs: readonly TagRef[];
  readonly artifactId: string;
  readonly generationId: string;
}

function generationTags(entry: DataEntryMetadata): GenerationTag[] {
  return entry.tags.map((value) => ({ kind: tagKindOf(value), value }));
}

/** The lifetime Next.js gave a value, as its generation keeps it. */
function dataPolicy(entry: DataEntryMetadata): CachePolicy {
  return {
    revalidateAfter: finiteSeconds(entry.revalidate),
    expireAfter: finiteSeconds(entry.expire),
    clientStale: finiteSeconds(entry.stale),
    source: 'runtime-output',
  };
}

export async function planSetData(
  input: TxInput,
  data: DataSetInput,
): Promise<Apply<DataSetOutcome | Refusal>> {
  const descriptor = {
    kind: data.entry.kind,
    ...(data.entry.handler !== undefined && { handler: data.entry.handler }),
    key: data.key,
  };
  const [identity, tagRefs, artifactId] = await Promise.all([
    identifyEntry(input.scopeId, descriptor),
    tagRefsFor(input.scopeId, generationTags(data.entry)),
    artifactIdFor(input.scopeId, data.value.sha256),
  ]);
  return () => {
    return applySetData(input, {
      input: data,
      identity,
      tagRefs,
      artifactId,
      generationId: createId(GENERATION_ID_PREFIX),
    });
  };
}

/**
 * What the invalidations of a value's tags that took effect at or after it was made leave it with.
 * Where it was made before the history window, those retention folded are weighed as their tag's
 * fold (`foldsFrom`).
 */
function dataCondemnation(sql: SqlStorage, plan: DataPlan): InvalidationState | null {
  const tagIds = plan.tagRefs.map((ref) => ref.tagId);
  const { timestamp } = plan.input.entry;
  const privateFences = controlFenceInvalidations(sql, { tagIds, timestamp });
  const invalidations = sql
    .exec<{ revision: number | null; stale_at: number | null; hard_expire_at: number | null }>(
      `SELECT MAX(revision) AS revision, MIN(stale_at) AS stale_at, MIN(hard_expire_at) AS hard_expire_at
      FROM invalidations WHERE target_kind = 'tag' AND target_id IN (SELECT value FROM json_each(?))
        AND stale_at >= ? HAVING COUNT(*) > 0`,
      JSON.stringify(tagIds),
      timestamp,
    )
    .toArray()[0];
  const all: { revision: number; stale_at: number; hard_expire_at: number | null }[] = [
    ...privateFences,
    ...foldsFrom(sql, tagIds, timestamp),
  ];
  if (
    invalidations?.revision !== undefined &&
    invalidations.revision !== null &&
    invalidations.stale_at !== null
  )
    all.push({
      ...invalidations,
      revision: invalidations.revision,
      stale_at: invalidations.stale_at,
    });
  if (all.length === 0) return null;
  const deadlines = all.flatMap((row) => (row.hard_expire_at === null ? [] : [row.hard_expire_at]));
  return {
    revision: Math.max(...all.map((row) => row.revision)),
    staleAt: Math.min(...all.map((row) => row.stale_at)),
    ...(deadlines.length > 0 && { hardExpireAt: Math.min(...deadlines) }),
  };
}

/**
 * The same value, made at the same time, with the same tags, lifetime and dependency coverage: the
 * current generation already is it. A write that differs in any of them is a new one, whose lifetime
 * and coverage the generation and its record carry from then on.
 */
function unchangedGeneration(
  sql: SqlStorage,
  entry: EntryRow,
  plan: DataPlan,
): GenerationRow | undefined {
  if (entry.current_generation_id === null) {
    return undefined;
  }
  const { entry: metadata, value } = plan.input;
  const current = findGeneration(sql, entry.current_generation_id);
  if (current?.cache_timestamp !== metadata.timestamp) {
    return undefined;
  }
  const sha = generationOutputs(current)[0]?.artifacts[0]?.sha256;
  return sha === value.sha256 &&
    current.tags === JSON.stringify(generationTags(metadata)) &&
    current.policy === JSON.stringify(dataPolicy(metadata)) &&
    current.dependency_coverage === metadata.dependencyCoverage
    ? current
    : undefined;
}

/**
 * How long an entry remembers each writer's latest write (`writer_marks`). A write crosses a later
 * one of its writer's only while it is in flight — behind its upload, or behind its writer's
 * patience for the write before it — and no write of an application's Function is in flight for an
 * hour. Retention sweeps the marks past it.
 */
export const WRITER_MARK_WINDOW_MS = 3_600_000;

/** A generation of the entry, as much of it as a write it supersedes is answered with. */
interface LaterWrite {
  readonly generation_id: string;
  readonly revision: number;
}

/**
 * The generation of a write its writer sent after this one: a write held up on its way — behind
 * its upload, or sent once its writer would wait no longer for the write before it — arriving
 * after one its writer sent later, whatever other writers' writes landed in between, and however
 * many. Writes are published as they arrive, and the order they arrive in is the network's; the
 * order a writer handed them over in is its own, and the entry remembers the latest of each writer
 * (`markWriter`). Writes of a writer whose later writes the entry has not had, or of one that says
 * nothing of its order, are published as they arrive: nothing orders writes of different writers
 * but their arrival.
 *
 * Or the generation of this write itself, the entry's latest of its writer, arriving again: its
 * request sent once more, its answer lost the first time. A writer raises its count with each
 * write, so its place names the write, and published again it would take back what another
 * writer's write has made current since.
 */
function writtenAfter(sql: SqlStorage, plan: DataPlan, now: number): LaterWrite | undefined {
  const { order } = plan.input;
  if (order === undefined) {
    return undefined;
  }
  return sql
    .exec<{ generation_id: string; revision: number }>(
      `SELECT generation_id, revision FROM writer_marks
       WHERE entry_id = ? AND writer = ? AND seq >= ? AND marked_at >= ?`,
      plan.identity.entryId,
      order.writer,
      order.seq,
      now - WRITER_MARK_WINDOW_MS,
    )
    .toArray()[0];
}

/** Remember the write as its writer's latest of the entry's, unless a later one is remembered. */
function markWriter(
  sql: SqlStorage,
  order: WriteOrder | undefined,
  written: { readonly entryId: string; readonly generationId: string; readonly revision: number },
  now: number,
): void {
  if (order === undefined) {
    return;
  }
  sql.exec(
    `INSERT INTO writer_marks (entry_id, writer, seq, generation_id, revision, marked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (entry_id, writer) DO UPDATE SET
       seq = excluded.seq, generation_id = excluded.generation_id, revision = excluded.revision,
       marked_at = excluded.marked_at
     WHERE excluded.seq > writer_marks.seq`,
    written.entryId,
    order.writer,
    order.seq,
    written.generationId,
    written.revision,
    now,
  );
}

/**
 * What a write is answered with when it writes nothing: a later write of its writer's the entry has
 * had (`writtenAfter`), adopting nothing, so the gateway removes the upload; or the current
 * generation when it is this value already, adopting the upload's artifact.
 */
function writesNothing(
  sql: SqlStorage,
  entry: EntryRow | undefined,
  plan: DataPlan,
  where: { readonly storageRef: string; readonly now: number },
): DataSetOutcome | undefined {
  // Asked of the entry's id, not its row: an entry reclaimed since its writer's later write — a
  // value expired, its record withdrawn — is made again by this one, under the same id.
  const later = writtenAfter(sql, plan, where.now);
  if (later !== undefined) {
    return {
      entryId: plan.identity.entryId,
      generationId: later.generation_id,
      revision: later.revision,
      superseded: true,
    };
  }
  if (entry === undefined) {
    return undefined;
  }
  const current = unchangedGeneration(sql, entry, plan);
  if (current === undefined) {
    return undefined;
  }
  const written = {
    entryId: current.entry_id,
    generationId: current.generation_id,
    revision: current.dependency_revision,
  };
  markWriter(sql, plan.input.order, written, where.now);
  const condemned = condemnedOf(current);
  return {
    ...written,
    ...(condemned !== null && { invalidation: condemned }),
    retainedStorageRef: where.storageRef,
  };
}

function applySetData(input: TxInput, plan: DataPlan): DataSetOutcome | Refusal {
  const { sql, scopeId, now, revision, limits } = input;
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  const floor = controlFenceFloorInvalidations(sql, {
    tagIds: plan.tagRefs.map((ref) => ref.tagId),
    timestamp: plan.input.entry.timestamp,
  });
  if (floor.length > 0)
    return refuse('lease_expired', 'the data value predates reclaimed control fences');
  const events: EventInput[] = [];
  const { value, entry: metadata } = plan.input;
  // Uploads have unique keys. Reuse the authority's existing content-addressed object, and let
  // the gateway remove only its own unadopted upload after the transaction answers.
  const storageRef = findArtifactBySha(sql, value.sha256)?.storage_ref ?? value.storageRef;
  const reference = {
    artifactId: plan.artifactId,
    sha256: value.sha256,
    storageRef,
    byteLength: value.byteLength,
    owned: true,
  };
  let entry = findEntry(sql, plan.identity.entryId);
  const unwritten = writesNothing(sql, entry, plan, { storageRef, now });
  if (unwritten !== undefined) {
    return unwritten;
  }
  // Every quota first: a refusal leaves the transaction committed, so anything written before one
  // would stay behind at a revision nothing records — an entry no event ever announced. The bytes
  // live attempts have uploaded count too (`reservedBytes`), as they do for another upload: their
  // commits would add them after this write had taken the room.
  const added = addedBytesOf(sql, reference);
  if (
    added > 0 &&
    scope.body_bytes + reservedBytes(sql, value.sha256) + added > limits.bodyBytesPerScope
  ) {
    return refuse('quota_exceeded', 'the scope holds as many bytes as it may');
  }
  if (entry === undefined) {
    if (scope.entry_count >= limits.entriesPerScope) {
      return refuse('quota_exceeded', 'the scope holds as many entries as it may');
    }
    entry = insertEntry(sql, { identity: plan.identity, groupInstanceId: null, revision, now });
    events.push({
      entityType: 'entry',
      entityId: entry.entry_id,
      kind: 'entry.created',
      payload: { entry: toEntry(scopeId, entry) },
    });
  }
  const { addedBytes } = referenceArtifact(sql, reference, now);
  const outputs: OutputSnapshot[] = [
    {
      outputId: createId(OUTPUT_ID_PREFIX),
      representationKey: DATA_VALUE,
      pathname: null,
      status: null,
      headers: {},
      compute: 'unknown',
      response: 'complete',
      htmlSize: null,
      artifacts: [
        {
          artifactId: plan.artifactId,
          sha256: value.sha256,
          byteLength: value.byteLength,
          contentType: value.contentType,
          encoding: 'identity',
          role: DATA_VALUE,
          storageRef,
        },
      ],
    },
  ];
  const previous =
    entry.current_generation_id === null
      ? undefined
      : findGeneration(sql, entry.current_generation_id);
  // The same bytes set again, made later: published for the freshness it carries, and not metered
  // — nothing new was written, as for a regeneration that rendered what was current.
  const rewritten = previous !== undefined && sameOutputs(outputs, generationOutputs(previous));
  const seq = entry.seq_max + 1;
  // A value made before an invalidation of one of its tags arrives condemned by it.
  const condemned = dataCondemnation(sql, plan);
  insertGeneration(sql, {
    generationId: plan.generationId,
    entryId: entry.entry_id,
    seq,
    source: 'runtime',
    attemptId: null,
    cacheTimestamp: metadata.timestamp,
    producedAt: now,
    policy: dataPolicy(metadata),
    status: 200,
    headers: {},
    tags: generationTags(metadata),
    dependencyCoverage: metadata.dependencyCoverage,
    dependencyRevision: revision,
    publishedRevision: revision,
    condemned,
    bodyBytes: value.byteLength,
    producer: { kind: 'attempt', reason: 'data-set' },
    outputs,
    committedAt: now,
  });
  if (entry.current_generation_id !== null) {
    supersedeGeneration(sql, entry.current_generation_id, revision);
  }
  replaceEntryTags(sql, entry.entry_id, plan.tagRefs);
  publishEntry(sql, {
    entryId: entry.entry_id,
    generationId: plan.generationId,
    seq,
    revision,
    now,
  });
  markWriter(
    sql,
    plan.input.order,
    { entryId: entry.entry_id, generationId: plan.generationId, revision },
    now,
  );
  sql.exec(`UPDATE scope SET body_bytes = body_bytes + ?`, addedBytes);
  const published = findGeneration(sql, plan.generationId);
  if (published !== undefined) {
    events.push({
      entityType: 'generation',
      entityId: plan.generationId,
      kind: 'generation.committed',
      payload: {
        generation: toPublicGeneration(scopeId, published),
        entryState: toEntryState(requireEntry(sql, entry.entry_id)),
        supersededGenerationId: entry.current_generation_id,
      },
    });
  }
  record(input, events);
  return {
    entryId: entry.entry_id,
    generationId: plan.generationId,
    revision,
    ...(condemned !== null && { invalidation: condemned }),
    retainedStorageRef: storageRef,
    ...(!rewritten && { metered: isrWriteOf(input, value.byteLength) }),
  };
}
