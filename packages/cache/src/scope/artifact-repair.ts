import { type OutputSnapshot, r2BlobKey } from '@stayingupwind/core/cache';

import { forgetArtifactFailure } from './artifacts.ts';
import { requireEntry } from './entries.ts';
import { findGeneration } from './generations.ts';
import { headerFieldsOf, unwritableRecord } from './records.ts';
import { generationOutputs, type GenerationRow, toEntryState } from './rows.ts';
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

/** Only current snapshots are inspected, in small pages, on the rare verified repair path. */
const SNAPSHOTS_AT_ONCE = 32;

function liveSnapshots(
  sql: SqlStorage,
  repairs: string,
  cursor: { readonly after: string; readonly excluding: string },
): Pick<GenerationRow, 'generation_id' | 'entry_id'>[] {
  return sql
    .exec<Pick<GenerationRow, 'generation_id' | 'entry_id'>>(
      `SELECT g.generation_id, g.entry_id FROM entries e
       JOIN generations g ON g.generation_id = e.current_generation_id
       WHERE e.publication = 'published' AND e.entry_id > ? AND e.entry_id <> ?
         AND EXISTS (SELECT 1 FROM json_each(g.outputs) o,
           json_each(o.value, '$.artifacts') a, json_each(?) r
           WHERE json_extract(a.value, '$.sha256') = json_extract(r.value, '$.sha256')
             AND json_extract(a.value, '$.byteLength') = json_extract(r.value, '$.byteLength')
             AND json_extract(a.value, '$.storageRef') = json_extract(r.value, '$.previousStorageRef'))
       ORDER BY e.entry_id LIMIT ?`,
      cursor.after,
      cursor.excluding,
      repairs,
      SNAPSHOTS_AT_ONCE,
    )
    .toArray();
}

function repairedOutputs(
  generation: GenerationRow,
  repairs: ReadonlyMap<string, ArtifactRepair>,
): OutputSnapshot[] {
  return generationOutputs(generation).map((output) => {
    return {
      ...output,
      artifacts: output.artifacts.map((artifact) => {
        const repair = repairs.get(artifact.sha256);
        return repair !== undefined &&
          artifact.byteLength === repair.byteLength &&
          artifact.storageRef === repair.previousStorageRef
          ? { ...artifact, storageRef: repair.storageRef }
          : artifact;
      }),
    };
  });
}

/** Preflight before publication: a longer replacement key must still fit every live record. */
export function retargetedRecordsFailure(
  input: TxInput,
  repairs: Iterable<ArtifactRepair>,
  publishingEntry: string,
): string | undefined {
  const bySha = new Map([...repairs].map((repair) => [repair.sha256, repair]));
  const selected = JSON.stringify([...bySha.values()]);
  let after = '';
  for (;;) {
    const page = liveSnapshots(input.sql, selected, { after, excluding: publishingEntry });
    for (const id of page) {
      after = id.entry_id;
      const generation = findGeneration(input.sql, id.generation_id);
      if (generation === undefined) throw new Error('the current repair snapshot disappeared');
      const fields = headerFieldsOf(
        input.scopeId,
        requireEntry(input.sql, generation.entry_id),
        generation,
        repairedOutputs(generation, bySha),
      );
      const failure = unwritableRecord(fields, input.limits.maxRecordBytes);
      if (failure !== undefined) return failure;
      after = generation.entry_id;
    }
    if (page.length < SNAPSHOTS_AT_ONCE) break;
  }
  return undefined;
}

/**
 * Redirect every other live snapshot before forgetting the broken location. Only storage refs
 * change; archived generations and reference counts stay as they were. The revision invalidates
 * an older projection's acknowledgment and queues every changed record in the existing settle
 * backlog. SQL may scan all current entries; paging holds only 32 ids plus one generation at a time, not a hard heap or total CPU bound. All repairs are applied to each entry together,
 * so its final state is appended once without accumulating scope-wide history events.
 */
export function finishArtifactRepairs(
  input: TxInput,
  repairs: ReadonlyMap<string, ArtifactRepair>,
  publishingEntry: string,
): void {
  const selected = JSON.stringify([...repairs.values()]);
  let after = '';
  for (;;) {
    const page = liveSnapshots(input.sql, selected, { after, excluding: publishingEntry });
    for (const id of page) {
      after = id.entry_id;
      const generation = findGeneration(input.sql, id.generation_id);
      if (generation === undefined) throw new Error('the current repair snapshot disappeared');
      const before = requireEntry(input.sql, generation.entry_id);
      if (
        before.current_generation_id !== generation.generation_id ||
        before.publication !== 'published'
      )
        continue;
      input.sql.exec(
        `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
        JSON.stringify(repairedOutputs(generation, repairs)),
        generation.generation_id,
      );
      input.sql.exec(
        `UPDATE entries SET revision = ?, record_revision = ?, updated_at = ?
         WHERE entry_id = ? AND current_generation_id = ?`,
        input.revision,
        input.revision,
        input.now,
        generation.entry_id,
        generation.generation_id,
      );
      // A prior seed repair in this transaction already emitted the same public entry state;
      // subsequent SHA relocations change private output refs alone, not that state again.
      if (before.revision !== input.revision) {
        input.history.append(
          { sql: input.sql, revision: input.revision, now: input.now },
          {
            entityType: 'entry',
            entityId: generation.entry_id,
            kind: 'entry.state.changed',
            payload: { entryState: toEntryState(requireEntry(input.sql, generation.entry_id)) },
          },
        );
      }
      after = generation.entry_id;
    }
    if (page.length < SNAPSHOTS_AT_ONCE) break;
  }
  for (const repair of repairs.values()) forgetArtifactFailure(input.sql, repair.sha256);
}

/** A verified attempt-specific upload replaces the failed canonical location atomically. */
export function repairArtifact(input: TxInput, repair: ArtifactRepair): number {
  const { sql, now } = input;
  const changed = sql.exec(
    `UPDATE artifacts SET storage_ref = ?, owned = 1
     WHERE sha256 = ? AND storage_ref = ? AND byte_length = ? AND owned = ?
     RETURNING sha256`,
    repair.storageRef,
    repair.sha256,
    repair.previousStorageRef,
    repair.byteLength,
    repair.previouslyOwned ? 1 : 0,
  );
  if (changed.toArray().length !== 1) throw new Error('the failed artifact location changed');
  if (repair.previouslyOwned && repair.previousStorageRef !== repair.storageRef) {
    sql.exec(
      `INSERT OR IGNORE INTO pending_deletions (storage_ref, queued_at) VALUES (?, ?)`,
      repair.previousStorageRef,
      now,
    );
  }
  sql.exec(`DELETE FROM pending_deletions WHERE storage_ref = ?`, repair.storageRef);
  return repair.previouslyOwned ? 0 : repair.byteLength;
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
