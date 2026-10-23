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
import { foldInvalidations } from './invalidation-fold.ts';
import { pruneQuotaWindows } from './quotas.ts';
import { REPAIR_PIN_PREFIX } from './repair-jobs.ts';
import {
  type AttemptArtifactRow,
  type EntryRow,
  generationOutputs,
  type GenerationRow,
} from './rows.ts';
import {
  commitRevision,
  deleteMeta,
  readMeta,
  readRevision,
  readScope,
  writeMeta,
} from './state.ts';

/**
 * What is kept, and for how long. A generation that is no longer current loses its bytes after a
 * time or when enough newer ones exist — except the one a rollback would go back to — and keeps its
 * metadata for the history window, marked `pruned`. An upload that no generation took is dropped
 * once its attempt is well over. An invalidation is kept for the history window, past which it is
 * folded with its tag's others into the one row the tag keeps of them (`invalidation-fold.ts`). A
 * retired scope loses every body at once and everything else once its history has aged out. Blobs
 * go only when nothing refers to them; the build's own blobs are never this Worker's to delete.
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
/**
 * Set by a run that retired expired data, while their entries wait to be let go of: for their
 * withdrawal from KV, which the settle after the run writes a slice at a time, or past a batch that
 * came back full (`letGoOfWithdrawn`).
 */
const META_RETIRED_WITHDRAWING = 'retired_withdrawing';
/** One bounded pass over borrowed metadata left unreferenced by earlier authorities. */
const META_BORROWED_SWEEP_CURSOR = 'borrowed_artifact_sweep_cursor';
const META_BORROWED_SWEEP_DONE = 'borrowed_artifact_sweep_done';
/** An entry with no value now, and no render holding a lease on it, as an SQL condition. */
const UNUSED = `e.current_generation_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.entry_id = e.entry_id AND a.status IN ('leased', 'uploading'))`;
/** A retired entry whose record is withdrawn from KV and whose bytes are gone, likewise. */
const WITHDRAWN = `e.publication = 'retired' AND e.kv_revision >= e.record_revision
  AND NOT EXISTS (SELECT 1 FROM generations g WHERE g.entry_id = e.entry_id AND g.storage = 'present')`;

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
  /**
   * A batch came back full (`PRUNE_BATCH`): more is left than one run lets go of, and the next run
   * comes soon rather than an interval later (`nextRetentionAt`).
   */
  readonly more: boolean;
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
          SELECT 1 FROM artifacts a JOIN meta pin ON pin.key = ? || a.sha256
          WHERE a.storage_ref = pending_deletions.storage_ref
        )
        OR EXISTS (
          SELECT 1 FROM attempt_artifacts aa
          JOIN attempts a ON a.attempt_id = aa.attempt_id
          WHERE aa.storage_ref = pending_deletions.storage_ref AND a.status <> 'committed'
        )`,
    REPAIR_PIN_PREFIX,
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

/** Whether the batch came back full (`RetentionPlan.more`). */
function pruneFormerGenerations(
  input: RetentionInput,
  windows: Windows,
  deletable: string[],
): boolean {
  const expired = prunableGenerations(input.sql, {
    before: input.now - windows.noncurrentMs,
    retain: input.limits.retainNoncurrentGenerations,
    limit: PRUNE_BATCH,
  });
  for (const generation of expired) {
    releaseGeneration(input, generation, deletable);
  }
  return expired.length === PRUNE_BATCH;
}

function pruneEverything(input: RetentionInput, deletable: string[]): boolean {
  const present = presentGenerations(input.sql, PRUNE_BATCH);
  for (const generation of present) {
    releaseGeneration(input, generation, deletable);
  }
  return present.length === PRUNE_BATCH;
}

/**
 * Uploads of attempts that ended without publishing them, or whose attempt has aged out. Read by
 * when each was uploaded (`attempt_artifacts_by_age`), as far as the same grace: an upload is
 * recorded while its attempt holds its lease, so one whose attempt ended before the grace began was
 * uploaded before it too, and one whose attempt has aged out long before. What is read is the old
 * uploads, not the many an hour of renders leaves behind.
 */
function dropOrphanedUploads(input: RetentionInput, deletable: string[]): boolean {
  const before = input.now - UPLOAD_GRACE_MS;
  const rows = input.sql
    .exec<AttemptArtifactRow>(
      `SELECT aa.* FROM attempt_artifacts aa
       LEFT JOIN attempts a ON a.attempt_id = aa.attempt_id
       WHERE aa.uploaded_at < ?
         AND (a.attempt_id IS NULL
           OR (a.status NOT IN ('leased', 'uploading') AND a.finished_at < ?))
       LIMIT ?`,
      before,
      before,
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
  return rows.length === PRUNE_BATCH;
}

function ageOutHistory(input: RetentionInput, windows: Windows, deletable: string[]): boolean {
  const { sql, now } = input;
  const before = now - windows.historyMs;
  deletable.push(...input.history.ageOut(sql, before));
  // Removing the oldest page advances the existing finished-at index, including tied timestamps.
  // RETURNING counts attempts, not their additional index writes, for the backlog signal.
  const attempts = sql
    .exec<{ attempt_id: string }>(
      `DELETE FROM attempts WHERE attempt_id IN (
       SELECT attempt_id FROM attempts INDEXED BY attempts_by_finished_at
       WHERE finished_at < ? AND status NOT IN ('leased', 'uploading')
       ORDER BY finished_at LIMIT ?)
     RETURNING attempt_id`,
      before,
      PRUNE_BATCH,
    )
    .toArray();
  const generations = deletePrunedBefore(sql, before, PRUNE_BATCH);
  // Only the owners actually removed above can have become orphaned in this transaction.
  // Use their existing primary-key prefix, keeping every statement within SQLite's binding limit.
  const ownersPerStatement = 100;
  for (let start = 0; start < generations.length; start += ownersPerStatement) {
    const owners = generations.slice(start, start + ownersPerStatement);
    sql.exec(
      `DELETE FROM dependencies WHERE owner_generation_id IN (${owners.map(() => '?').join(',')})`,
      ...owners,
    );
  }
  pruneQuotaWindows(sql, now);
  return attempts.length === PRUNE_BATCH || generations.length === PRUNE_BATCH;
}

/** Expired data has no useful current value; withdraw it before reclaiming its entry slot. */
function retireExpiredData(input: RetentionInput): boolean {
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
    return false;
  }
  const revision = readRevision(sql) + 1;
  commitRevision(sql, revision);
  for (const entry of entries) {
    sql.exec(
      `UPDATE generations SET publication = 'retired' WHERE generation_id = ?`,
      entry.current_generation_id,
    );
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
  writeMeta(sql, META_RETIRED_WITHDRAWING, '1');
  return entries.length === PRUNE_BATCH;
}

/** Let go of entries: their tags, their rows and their places in the scope's count. */
function letGoOf(sql: SqlStorage, entries: readonly EntryRow[]): void {
  for (const entry of entries) {
    sql.exec(`DELETE FROM entry_tags WHERE entry_id = ?`, entry.entry_id);
    // Not its writers' marks: a write delayed past its entry's reclamation must still find them
    // (`writtenAfter`), and they age out on their own (`forgetWriterMarks`).
    sql.exec(`DELETE FROM entries WHERE entry_id = ?`, entry.entry_id);
  }
  sql.exec(`UPDATE scope SET entry_count = MAX(0, entry_count - ?)`, entries.length);
}

/** Whether entries whose value a run retired wait to be let go of as they are withdrawn. */
export function retiredWithdrawing(sql: SqlStorage): boolean {
  return readMeta(sql, META_RETIRED_WITHDRAWING) !== undefined;
}

/**
 * The entries whose value a run retired (`retireExpiredData`), let go of once the settle after the
 * run has withdrawn them: asked after each slice of it, not left to the next run an interval on.
 * The run after this one can come before most of them are out, and each would hold its place in
 * the scope's count until then, which a scope at its limit spends refusing new keys. Says nothing
 * and commits no revision, as a run lets go of them (`dropUnusedEntries`). Done with once its batch
 * did not come back full and none of them still waits for its withdrawal, or the scope is retired.
 *
 * Whether the batch came back full: a settle can withdraw more of them at once than one batch takes,
 * the rest of a batch whose withdrawal failed with a later run's, and those past it are left to a
 * run that comes soon (`letGoOfRetired`), as a run's own full batch leaves its rest.
 */
export function letGoOfWithdrawn(sql: SqlStorage): boolean {
  const scope = readScope(sql);
  if (scope !== undefined && scope.status !== 'retired') {
    const entries = sql
      .exec<EntryRow>(
        `SELECT * FROM entries e WHERE ${UNUSED} AND ${WITHDRAWN} ORDER BY e.updated_at LIMIT ?`,
        PRUNE_BATCH,
      )
      .toArray();
    if (entries.length > 0) {
      letGoOf(sql, entries);
    }
    if (entries.length === PRUNE_BATCH) {
      return true;
    }
    const waiting = sql
      .exec(
        `SELECT 1 FROM entries WHERE kv_revision < record_revision
         AND publication = 'retired' AND current_generation_id IS NULL LIMIT 1`,
      )
      .toArray();
    if (waiting.length > 0) {
      return false;
    }
  }
  deleteMeta(sql, META_RETIRED_WITHDRAWING);
  return false;
}

/** Keep historical attempts/generations, but release entries that can no longer serve a value. */
function dropUnusedEntries(input: RetentionInput): boolean {
  const { sql, now } = input;
  const entries = sql
    .exec<EntryRow>(
      `SELECT * FROM entries e WHERE ${UNUSED}
       AND ((e.publication = 'none' AND e.updated_at < ?) OR (${WITHDRAWN}))
     ORDER BY e.updated_at LIMIT ?`,
      now - UPLOAD_GRACE_MS,
      PRUNE_BATCH,
    )
    .toArray();
  if (entries.length === 0) {
    return false;
  }
  // One retirement, one event: an entry whose value expired was announced retired as its record
  // was withdrawn (`retireExpiredData`), and one that never published is announced now, at a
  // revision the batch commits for it. Letting go of the first says nothing, and commits no
  // revision: every revision says what was done at it, and a history read back in order would
  // wait for good at one that says nothing.
  const unannounced = entries.filter((entry) => entry.publication !== 'retired');
  if (unannounced.length > 0) {
    const revision = readRevision(sql) + 1;
    commitRevision(sql, revision);
    for (const entry of unannounced) {
      sql.exec(
        `UPDATE entries SET publication = 'retired', revision = ? WHERE entry_id = ?`,
        revision,
        entry.entry_id,
      );
      input.history.append(
        { sql, revision, now },
        { ...entryStateEvent(sql, entry.entry_id), kind: 'entry.retired' },
      );
    }
  }
  letGoOf(sql, entries);
  return entries.length === PRUNE_BATCH;
}

/** Expired ordering marks, one indexed page so a busy scope leaves room for other requests. */
function forgetWriterMarks(input: RetentionInput): boolean {
  const removed = input.sql
    .exec<{ removed: number }>(
      `DELETE FROM writer_marks WHERE rowid IN (
        SELECT rowid FROM writer_marks INDEXED BY writer_marks_by_age
        WHERE marked_at < ? ORDER BY marked_at LIMIT ?
      ) RETURNING 1 AS removed`,
      input.now - WRITER_MARK_WINDOW_MS,
      PRUNE_BATCH,
    )
    .toArray();
  return removed.length === PRUNE_BATCH;
}

/** Old zero-reference rows, sought through the existing primary key without a new index build. */
function forgetUnusedBorrowedArtifacts(input: RetentionInput): boolean {
  const { sql } = input;
  if (readMeta(sql, META_BORROWED_SWEEP_DONE) !== undefined) return false;
  const rows = sql
    .exec<{ artifact_id: string; sha256: string; owned: number; refs: number }>(
      `SELECT artifact_id, sha256, owned, refs FROM artifacts
       WHERE artifact_id > ? ORDER BY artifact_id LIMIT ?`,
      readMeta(sql, META_BORROWED_SWEEP_CURSOR) ?? '',
      PRUNE_BATCH,
    )
    .toArray();
  for (const row of rows) {
    if (row.owned === 0 && row.refs === 0) deleteArtifactRow(sql, row.sha256);
  }
  const last = rows.at(-1);
  if (last !== undefined && rows.length === PRUNE_BATCH) {
    writeMeta(sql, META_BORROWED_SWEEP_CURSOR, last.artifact_id);
    return true;
  }
  deleteMeta(sql, META_BORROWED_SWEEP_CURSOR);
  writeMeta(sql, META_BORROWED_SWEEP_DONE, '1');
  return false;
}

/** Runs inside one transaction; the caller deletes what the plan names afterwards. */
export function applyRetention(input: RetentionInput): RetentionPlan {
  const deletable: string[] = [];
  const scope = readScope(input.sql);
  if (scope === undefined) {
    return { deletable, deleteAll: false, more: false };
  }
  const retired = scope.status === 'retired';
  const windows = windowsOf(input);
  expireControlFences(input.sql, input.now);
  // A step whose batch came back full leaves the rest to a run that comes soon (`more`).
  const full: boolean[] = [];
  if (retired) {
    full.push(pruneEverything(input, deletable));
  } else {
    full.push(
      retireExpiredData(input),
      pruneFormerGenerations(input, windows, deletable),
      dropUnusedEntries(input),
      foldInvalidations(input),
      forgetWriterMarks(input),
    );
  }
  full.push(
    dropOrphanedUploads(input, deletable),
    ageOutHistory(input, windows, deletable),
    forgetUnusedBorrowedArtifacts(input),
  );
  queueDeletions(input.sql, deletable, input.now);
  forgetReferenced(input.sql);
  const page = pendingDeletions(input.sql, PRUNE_BATCH);
  return {
    deletable: page,
    deleteAll: scopeErasable(input),
    more: full.includes(true) || page.length === PRUNE_BATCH,
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
