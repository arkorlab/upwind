import type { ScopeLimits } from '../env.ts';
import { deleteArtifactRow, findArtifactBySha, releaseArtifact } from './artifacts.ts';
import { entryStateEvent } from './attempts.ts';
import { expireControlFences } from './control-fences.ts';
import { WRITER_MARK_WINDOW_MS } from './data.ts';
import {
  deletePrunedBefore,
  markPruned,
  presentGenerations,
  prunableGenerations,
} from './generations.ts';
import type { ScopeHistory } from './history.ts';
import { pruneQuotaWindows } from './quotas.ts';
import {
  type AttemptArtifactRow,
  type EntryRow,
  generationOutputs,
  type GenerationRow,
} from './rows.ts';
import { commitRevision, readRevision, readScope } from './state.ts';

/**
 * What is kept, and for how long. A generation that is no longer current loses its bytes after a
 * time or when enough newer ones exist — except the one a rollback would go back to — and keeps its
 * metadata for the history window, marked `pruned`. An upload that no generation took is dropped
 * once its attempt is well over. A retired scope loses every body at once and everything else once
 * its history has aged out. Blobs go only when nothing refers to them; the build's own blobs are
 * never this Worker's to delete.
 *
 * Both windows are the history's, for a scope that records it or recorded it once and has stopped,
 * whose history is read back up to the stop. One whose history is not kept (`ScopeHistory.keeps`)
 * is never looked back at, and keeps a former generation's bytes and a finished attempt only as
 * long as serving needs them: the bytes for a reader still holding a delivery record that names
 * them, the attempt for a commit still in flight. A former generation's time is counted from when a
 * newer one replaced it, not from its own commit, so one that served for a long while is not
 * dropped as soon as it is replaced. How long a retired scope lasts before it is erased is the same
 * either way.
 */

const PRUNE_BATCH = 200;
const MILLISECONDS_PER_HOUR = 3_600_000;
/** How long a finished attempt's uploads are kept, for a commit that is still in flight. */
const UPLOAD_GRACE_MS = MILLISECONDS_PER_HOUR;

export interface RetentionInput {
  readonly sql: SqlStorage;
  readonly limits: ScopeLimits;
  readonly now: number;
  /** What the host keeps of the scope's history: kept as long as its windows say, and told. */
  readonly history: ScopeHistory;
}

export interface RetentionPlan {
  /** Storage keys nothing refers to any more, for the caller to delete. */
  readonly deletable: string[];
  /** The scope is retired, past its history window, and holds nothing left to delete. */
  readonly deleteAll: boolean;
}

/**
 * Keys wait here until R2 says they are gone.
 *
 * The metadata that named a blob is dropped in the same transaction that decides to delete it, so
 * a delete that fails afterwards would leave a key nothing could ever name again. Written down,
 * the next tick asks for it once more.
 */
export function queueDeletions(sql: SqlStorage, keys: readonly string[], now: number): void {
  for (const key of keys) {
    sql.exec(
      `INSERT OR IGNORE INTO pending_deletions (storage_ref, queued_at) VALUES (?, ?)`,
      key,
      now,
    );
  }
}

/**
 * A key written down for deletion that something refers to again is no longer one to delete.
 *
 * The bytes are content-addressed, so a later generation of the same content is stored under the
 * same key: a delete that storage refused, waiting here, would otherwise come back on a later
 * tick and take the blob out from under the generation that now refers to it. Route uploads
 * reserve their canonical key before R2 HEAD/PUT, so a retained uncommitted attempt also owns
 * its bytes. A committed attempt hands that protection over to its generation references.
 */
function forgetReferenced(sql: SqlStorage): void {
  sql.exec(
    `DELETE FROM pending_deletions
     WHERE EXISTS (
          SELECT 1 FROM artifacts
          WHERE artifacts.storage_ref = pending_deletions.storage_ref AND refs > 0
        )
        OR EXISTS (
          SELECT 1 FROM attempt_artifacts aa
          JOIN attempts a ON a.attempt_id = aa.attempt_id
          WHERE aa.storage_ref = pending_deletions.storage_ref AND a.status <> 'committed'
        )`,
  );
}

function pendingDeletions(sql: SqlStorage, limit: number): string[] {
  const rows = sql
    .exec<{ storage_ref: string }>(
      `SELECT storage_ref FROM pending_deletions ORDER BY queued_at, storage_ref LIMIT ?`,
      limit,
    )
    .toArray();
  return rows.map((row) => row.storage_ref);
}

/** Called once R2 has confirmed the deletes; what is not confirmed is asked for again. */
export function forgetDeletions(sql: SqlStorage, keys: readonly string[]): void {
  for (const key of keys) {
    sql.exec(`DELETE FROM pending_deletions WHERE storage_ref = ?`, key);
  }
}

/**
 * Whether anything of the scope's bytes is still this Worker's to account for: a body it has not
 * pruned, an upload it has not dropped, a blob row it still holds, a delete R2 has not confirmed,
 * or a delivery record whose withdrawal from KV is still behind — rewritten a slice at a time,
 * and once the object is gone, nothing would ever withdraw it. Retirement prunes in batches, so
 * the history window running out is not on its own a moment when there is nothing left to lose.
 */
function bytesRemain(sql: SqlStorage): boolean {
  const counted = sql
    .exec<{ n: number }>(
      `SELECT
         (SELECT COUNT(*) FROM generations WHERE storage = 'present')
         + (SELECT COUNT(*) FROM attempt_artifacts)
         + (SELECT COUNT(*) FROM artifacts WHERE owned = 1)
         + (SELECT COUNT(*) FROM pending_deletions)
         + (SELECT COUNT(*) FROM entries WHERE kv_revision < record_revision) AS n`,
    )
    .one().n;
  return counted > 0;
}

function releaseGeneration(
  input: RetentionInput,
  generation: GenerationRow,
  deletable: string[],
): void {
  const { sql, now, history } = input;
  let freed = 0;
  for (const output of generationOutputs(generation)) {
    for (const artifact of output.artifacts) {
      const released = releaseArtifact(sql, artifact.sha256);
      if (released?.deletable === true) {
        deletable.push(released.storageRef);
        freed += released.byteLength;
        deleteArtifactRow(sql, released.sha256);
      }
    }
  }
  markPruned(sql, generation.generation_id, now);
  sql.exec(`UPDATE scope SET body_bytes = MAX(0, body_bytes - ?)`, freed);
  const revision = readRevision(sql) + 1;
  commitRevision(sql, revision);
  history.append(
    { sql, revision, now },
    {
      entityType: 'generation',
      entityId: generation.generation_id,
      kind: 'generation.pruned',
      payload: {
        generationId: generation.generation_id,
        entryId: generation.entry_id,
        prunedAt: now,
      },
    },
  );
}

/** How long what is no longer current is kept: longer for a scope whose history is looked at. */
interface Windows {
  readonly noncurrentMs: number;
  readonly historyMs: number;
}

function windowsOf(input: RetentionInput): Windows {
  const { limits } = input;
  return input.history.keeps(input.sql)
    ? { noncurrentMs: limits.retainNoncurrentMs, historyMs: limits.retainHistoryMs }
    : {
        noncurrentMs: limits.retainNoncurrentUnrecordedMs,
        historyMs: limits.retainHistoryUnrecordedMs,
      };
}

function pruneFormerGenerations(
  input: RetentionInput,
  windows: Windows,
  deletable: string[],
): void {
  const expired = prunableGenerations(input.sql, {
    before: input.now - windows.noncurrentMs,
    retain: input.limits.retainNoncurrentGenerations,
    limit: PRUNE_BATCH,
  });
  for (const generation of expired) {
    releaseGeneration(input, generation, deletable);
  }
}

function pruneEverything(input: RetentionInput, deletable: string[]): void {
  for (const generation of presentGenerations(input.sql, PRUNE_BATCH)) {
    releaseGeneration(input, generation, deletable);
  }
}

/** Uploads of attempts that ended without publishing them, or whose attempt has aged out. */
function dropOrphanedUploads(input: RetentionInput, deletable: string[]): void {
  const rows = input.sql
    .exec<AttemptArtifactRow>(
      `SELECT aa.* FROM attempt_artifacts aa
       LEFT JOIN attempts a ON a.attempt_id = aa.attempt_id
       WHERE a.attempt_id IS NULL
          OR (a.status NOT IN ('leased', 'uploading') AND a.finished_at < ?)
       LIMIT ?`,
      input.now - UPLOAD_GRACE_MS,
      PRUNE_BATCH,
    )
    .toArray();
  for (const row of rows) {
    const kept = findArtifactBySha(input.sql, row.sha256);
    // A commit that found the bytes already stored kept referring to where they were, so an
    // upload under another key is a copy nothing names — the build's own blobs, deduplicated
    // against, are the usual way that happens.
    if (kept === undefined || kept.refs === 0 || kept.storage_ref !== row.storage_ref) {
      deletable.push(row.storage_ref);
    }
    input.sql.exec(
      `DELETE FROM attempt_artifacts WHERE attempt_id = ? AND sha256 = ? AND role = ?`,
      row.attempt_id,
      row.sha256,
      row.role,
    );
  }
}

function ageOutHistory(input: RetentionInput, windows: Windows, deletable: string[]): void {
  const { sql, now } = input;
  const before = now - windows.historyMs;
  deletable.push(...input.history.ageOut(sql, before));
  sql.exec(
    `DELETE FROM attempts WHERE status NOT IN ('leased', 'uploading') AND finished_at < ?`,
    before,
  );
  deletePrunedBefore(sql, before);
  sql.exec(
    `DELETE FROM dependencies WHERE owner_generation_id NOT IN (SELECT generation_id FROM generations)`,
  );
  pruneQuotaWindows(sql, now);
}

/** Expired data has no useful current value; withdraw it before reclaiming its entry slot. */
function retireExpiredData(input: RetentionInput): void {
  const { sql, now } = input;
  const entries = sql
    .exec<EntryRow>(
      `SELECT e.* FROM entries e JOIN generations g ON g.generation_id = e.current_generation_id
     WHERE e.kind LIKE 'data:%' AND e.publication = 'published'
       AND ((json_extract(g.policy, '$.expireAfter.kind') = 'finite'
         AND COALESCE(g.cache_timestamp, g.committed_at) + json_extract(g.policy, '$.expireAfter.seconds') * 1000 <= ?)
         OR json_extract(g.condemned, '$.hardExpireAt') <= ?)
     ORDER BY e.updated_at LIMIT ?`,
      now,
      now,
      PRUNE_BATCH,
    )
    .toArray();
  if (entries.length === 0) {
    return;
  }
  const revision = readRevision(sql) + 1;
  commitRevision(sql, revision);
  for (const entry of entries) {
    sql.exec(`UPDATE generations SET publication = 'retired' WHERE entry_id = ?`, entry.entry_id);
    sql.exec(
      `UPDATE entries SET publication = 'retired', current_generation_id = NULL,
      revision = ?, record_revision = ?, updated_at = ? WHERE entry_id = ?`,
      revision,
      revision,
      now,
      entry.entry_id,
    );
    // A distinct event, so that a history kept of the scope can hold the publication fence even
    // after this entry is recreated, and a delayed older commit cannot appear published again.
    input.history.append(
      { sql, revision, now },
      { ...entryStateEvent(sql, entry.entry_id), kind: 'entry.retired' },
    );
  }
}

/** Keep historical attempts/generations, but release entries that can no longer serve a value. */
function dropUnusedEntries(input: RetentionInput): void {
  const { sql, now } = input;
  const entries = sql
    .exec<EntryRow>(
      `SELECT * FROM entries e WHERE e.current_generation_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.entry_id = e.entry_id AND a.status IN ('leased', 'uploading'))
       AND ((e.publication = 'none' AND e.updated_at < ?)
         OR (e.publication = 'retired' AND e.kv_revision >= e.record_revision
           AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.entry_id = e.entry_id AND g.storage = 'present')))
     ORDER BY e.updated_at LIMIT ?`,
      now - UPLOAD_GRACE_MS,
      PRUNE_BATCH,
    )
    .toArray();
  if (entries.length === 0) {
    return;
  }
  const revision = readRevision(sql) + 1;
  commitRevision(sql, revision);
  for (const entry of entries) {
    sql.exec(
      `UPDATE entries SET publication = 'retired', revision = ? WHERE entry_id = ?`,
      revision,
      entry.entry_id,
    );
    input.history.append(
      { sql, revision, now },
      { ...entryStateEvent(sql, entry.entry_id), kind: 'entry.retired' },
    );
    sql.exec(`DELETE FROM entry_tags WHERE entry_id = ?`, entry.entry_id);
    // Not its writers' marks: a write delayed past its entry's reclamation must still find them
    // (`writtenAfter`), and they age out on their own (`forgetWriterMarks`).
    sql.exec(`DELETE FROM entries WHERE entry_id = ?`, entry.entry_id);
  }
  sql.exec(`UPDATE scope SET entry_count = MAX(0, entry_count - ?)`, entries.length);
}

/** The writers' marks past the window a write can cross a later one in (`WRITER_MARK_WINDOW_MS`). */
function forgetWriterMarks(input: RetentionInput): void {
  input.sql.exec(`DELETE FROM writer_marks WHERE marked_at < ?`, input.now - WRITER_MARK_WINDOW_MS);
}

/** Runs inside one transaction; the caller deletes what the plan names afterwards. */
export function applyRetention(input: RetentionInput): RetentionPlan {
  const deletable: string[] = [];
  const scope = readScope(input.sql);
  if (scope === undefined) {
    return { deletable, deleteAll: false };
  }
  const retired = scope.status === 'retired';
  const windows = windowsOf(input);
  expireControlFences(input.sql, input.now);
  if (retired) {
    pruneEverything(input, deletable);
  } else {
    retireExpiredData(input);
    pruneFormerGenerations(input, windows, deletable);
    dropUnusedEntries(input);
    forgetWriterMarks(input);
  }
  dropOrphanedUploads(input, deletable);
  ageOutHistory(input, windows, deletable);
  queueDeletions(input.sql, deletable, input.now);
  forgetReferenced(input.sql);
  return {
    deletable: pendingDeletions(input.sql, PRUNE_BATCH),
    deleteAll: scopeErasable(input),
  };
}

/**
 * Whether the scope's storage may go whole: it is retired, past its history window, and holds
 * nothing left to delete (`bytesRemain`). Asked again once a run's deletes are confirmed, which may
 * have been the last of its bytes (`runRetention`).
 */
export function scopeErasable(input: Omit<RetentionInput, 'history'>): boolean {
  const scope = readScope(input.sql);
  return (
    scope?.status === 'retired' &&
    scope.retired_at !== null &&
    input.now - scope.retired_at > input.limits.retainHistoryMs &&
    !bytesRemain(input.sql)
  );
}
