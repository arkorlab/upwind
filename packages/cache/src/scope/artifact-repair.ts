import { isRepairStorageRef, r2BlobKey } from '@stayingupwind/core/cache';

import { requireEntry } from './entries.ts';
import { findGeneration } from './generations.ts';
import { headerFieldsOf, unwritableRecord } from './records.ts';
import { type EntryRow, generationOutputs, type GenerationRow, toEntryState } from './rows.ts';
import { readRevision } from './state.ts';
import { encodeStoredOutputs } from './stored-outputs.ts';
import type { TxInput } from './tx.ts';

/** A repair never accepts mere existence of the canonical key whose bytes failed verification. */
export function repairStorageRef(scopeId: string, sha256: string, attemptId: string): string {
  return `${r2BlobKey(scopeId, sha256)}/repair/${attemptId}`;
}

export interface ArtifactRepair {
  readonly sha256: string;
  readonly byteLength: number;
  readonly previousStorageRef: string;
  readonly storageRef: string;
  readonly previouslyOwned: boolean;
}

/** Only the provider's exact row limit is converted to a per-group preflight refusal. */
export class RepairRowTooLargeError extends Error {
  override name = 'RepairRowTooLargeError';

  constructor(cause: unknown) {
    super('a repaired generation exceeds the authority storage row limit', { cause });
  }
}

/** SQLite reports its configured row/string length limit with this stable result-code name. */
function rowLimitError(error: unknown): boolean {
  return error instanceof Error && /\bSQLITE_TOOBIG\b/u.test(error.message);
}

/** A durable continuation visits one entry primary-key row, including entries it skips. */
export interface RepairSnapshotStep {
  readonly done: boolean;
  readonly after: string;
  readonly changed: boolean;
  readonly failure?: string;
}

/**
 * Select the ID window before examining publication, JSON or artifact matches. A LIMIT after a
 * matching EXISTS can still visit every generation in the scope during a single invocation.
 * This query visits one entry after the primary-key seek; at most its one current generation is
 * then materialized. SQLite's existing row limit bounds that materialization independently of
 * how many matching or nonmatching entries the scope holds.
 */
export function repairSnapshotStep(
  input: TxInput,
  repairs: ReadonlyMap<string, ArtifactRepair>,
  cursor: {
    readonly after: string;
    readonly excluding: ReadonlySet<string>;
    readonly apply: boolean;
  },
): RepairSnapshotStep {
  const entry = input.sql
    .exec<EntryRow>(
      `SELECT * FROM entries WHERE entry_id > ? ORDER BY entry_id LIMIT 1`,
      cursor.after,
    )
    .toArray()[0];
  if (entry === undefined) return { done: true, after: cursor.after, changed: false };
  const skipped = { done: false, after: entry.entry_id, changed: false };
  if (
    entry.publication !== 'published' ||
    entry.current_generation_id === null ||
    cursor.excluding.has(entry.entry_id)
  )
    return skipped;
  const generation = findGeneration(input.sql, entry.current_generation_id);
  if (generation === undefined) throw new Error('the current repair snapshot disappeared');
  const before = generationOutputs(generation);
  let changed = false;
  const outputs = before.map((output) => ({
    ...output,
    artifacts: output.artifacts.map((artifact) => {
      const repair = repairs.get(artifact.sha256);
      if (
        repair === undefined ||
        repair.byteLength !== artifact.byteLength ||
        artifact.storageRef !== repair.previousStorageRef ||
        artifact.storageRef === repair.storageRef
      )
        return artifact;
      changed = true;
      return { ...artifact, storageRef: repair.storageRef };
    }),
  }));
  if (!changed) return skipped;
  const failure = unwritableRecord(
    headerFieldsOf(input, entry, generation, outputs),
    input.limits.maxRecordBytes,
  );
  if (failure !== undefined) {
    return { done: false, after: entry.entry_id, changed, failure };
  }
  const encoded = encodeStoredOutputs(outputs, input.packSchemaVersion === 2);
  if (!cursor.apply) {
    const nonGrowing =
      input.packSchemaVersion === 2 &&
      input.repairNamespace !== undefined &&
      [...repairs.values()].every(
        (repair) =>
          isRepairStorageRef(repair.storageRef) &&
          repair.storageRef.startsWith(`r/${input.repairNamespace}/`),
      );
    if (!nonGrowing) {
      // The pack does not contain every output-specific field. Its header can fit while this
      // generation's SQL row is near the provider limit. Ask that same limit, with no new cap.
      // Both writes are synchronous in this preflight transaction; no observer sees the probe.
      // A provider limit exception escapes and rolls the entire step back before the coordinator
      // records the refusal in a fresh transaction. Other storage errors remain retryable errors.
      probeRepairGeneration(input.sql, generation, encoded);
    }
    probeRepairEntry(input, entry);
    return { done: false, after: entry.entry_id, changed };
  }
  input.sql.exec(
    `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
    encoded,
    generation.generation_id,
  );
  input.sql.exec(
    `UPDATE entries SET revision = ?, record_revision = ?, updated_at = ?
     WHERE entry_id = ? AND current_generation_id = ?`,
    input.revision,
    input.revision,
    input.now,
    entry.entry_id,
    generation.generation_id,
  );
  input.history.append(
    { sql: input.sql, revision: input.revision, now: input.now },
    {
      entityType: 'entry',
      entityId: entry.entry_id,
      kind: 'entry.state.changed',
      payload: { entryState: toEntryState(requireEntry(input.sql, entry.entry_id)) },
    },
  );
  return { done: false, after: entry.entry_id, changed: true };
}

/** Check the exact future shared update and its mandatory KV acknowledgment, then restore both. */
function probeRepairEntry(input: TxInput, entry: EntryRow): void {
  const { sql } = input;
  const revision = readRevision(sql);
  try {
    sql.exec(
      `UPDATE entries SET revision = ?, record_revision = ?, kv_revision = ?, updated_at = ?
       WHERE entry_id = ?`,
      input.revision,
      input.revision,
      input.revision,
      input.now,
      entry.entry_id,
    );
    sql.exec('UPDATE scope SET revision = ?', input.revision);
  } catch (error) {
    if (rowLimitError(error)) throw new RepairRowTooLargeError(error);
    throw error;
  }
  sql.exec(
    `UPDATE entries SET revision = ?, record_revision = ?, kv_revision = ?, updated_at = ?
     WHERE entry_id = ?`,
    entry.revision,
    entry.record_revision,
    entry.kv_revision,
    entry.updated_at,
    entry.entry_id,
  );
  sql.exec('UPDATE scope SET revision = ?', revision);
}

/** Probe the publishing row too: output-specific fields are absent from delivery headers. */
export function probeRepairGeneration(
  sql: SqlStorage,
  generation: GenerationRow,
  encoded: string,
): void {
  try {
    sql.exec(
      `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
      encoded,
      generation.generation_id,
    );
  } catch (error) {
    if (rowLimitError(error)) throw new RepairRowTooLargeError(error);
    throw error;
  }
  sql.exec(
    `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
    generation.outputs,
    generation.generation_id,
  );
}

/** A verified attempt-specific upload replaces the failed canonical location atomically. */
export function repairArtifact(input: TxInput, repair: ArtifactRepair): number {
  const { sql, now } = input;
  const changed = sql.exec<{ refs: number }>(
    `UPDATE artifacts SET storage_ref = ?, owned = 1
     WHERE sha256 = ? AND storage_ref = ? AND byte_length = ? AND owned = ?
     RETURNING refs`,
    repair.storageRef,
    repair.sha256,
    repair.previousStorageRef,
    repair.byteLength,
    repair.previouslyOwned ? 1 : 0,
  );
  const rows = changed.toArray();
  const row = rows[0];
  if (row === undefined || rows.length !== 1)
    throw new Error('the failed artifact location changed');
  if (repair.previouslyOwned && repair.previousStorageRef !== repair.storageRef) {
    sql.exec(
      `INSERT OR IGNORE INTO pending_deletions (storage_ref, queued_at) VALUES (?, ?)`,
      repair.previousStorageRef,
      now,
    );
  }
  sql.exec(`DELETE FROM pending_deletions WHERE storage_ref = ?`, repair.storageRef);
  // An unreferenced row is charged by its first new reference, after this ownership change.
  return !repair.previouslyOwned && row.refs > 0 ? repair.byteLength : 0;
}

/** A seed retry changes a borrowed location only after its existing identical-byte verification. */
export function relocateBorrowedArtifact(input: TxInput, repair: ArtifactRepair): boolean {
  const changed = input.sql.exec(
    `UPDATE artifacts SET storage_ref = ?
     WHERE sha256 = ? AND storage_ref = ? AND byte_length = ? AND owned = 0
     RETURNING sha256`,
    repair.storageRef,
    repair.sha256,
    repair.previousStorageRef,
    repair.byteLength,
  );
  return changed.toArray().length === 1;
}
