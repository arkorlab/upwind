import type { ScopeLimits } from '../env.ts';
import { raiseFoldedThrough } from './folded-invalidations.ts';
import type { InvalidationRow } from './rows.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';
import { keepTagHistory } from './tag-history.ts';
import { findTag } from './tags.ts';

/**
 * Retention's fold of the invalidations that took effect before the history window: each tag's are
 * folded into the one row it keeps of them (`folded_invalidations`), and go. A scope records a row
 * for each tag each invalidation names, and a busy one names the same tags again and again, for as
 * long as its deployment is served: kept whole, they would fill its storage. Folded, a scope keeps
 * one row for each tag beyond the window, as it keeps one in `tags`.
 *
 * The window is the history window (`retainHistoryMs`), the longest a scope keeps anything for
 * whatever reads it back: what is asked of the invalidations in the course of serving reaches back
 * an hour, an edge's (`RECENT_INVALIDATIONS_MS`) the furthest. What asks further back is answered
 * from each tag's fold (`folded-invalidations.ts`), which keeps what those answers take of the rows:
 * the latest revision and what it meant, the latest revision of one at once, the earliest and the
 * latest moment one took effect, the earliest deadline, and how many there were.
 *
 * Two kinds of what asks further back read the rows themselves, and the fold keeps both from
 * needing what it folds:
 * - A reconcile of a resource's change reads the rows recorded at the revision its head names, for
 *   the tags the change invalidated (`headTagIds`). Rows at a head's revision are never folded, and
 *   a head's rows are as many as its change named: two at the most.
 * - A tag invalidated before histories were kept has its history upgraded from its rows by the next
 *   invalidation of it (`legacyHistory`). The fold stores that history first, as the upgrade would
 *   (`keepTagHistory`), before any row of the tag goes.
 *
 * A batch of candidates at a time, oldest first: even a batch a head keeps leaves the rest to a run
 * within a second (`RetentionPlan.more`). Its position survives a restart; a finished pass returns
 * to the beginning next period, revisiting rows a head let go of and any inserted behind it.
 * Nothing is announced and no revision committed: what a reader is told of a tag stands as it stood.
 * Only an active scope's are folded: a retired one records no more, and goes whole once its history
 * window is over.
 */

/** How many invalidations one run of retention examines at the most. */
const FOLD_BATCH = 200;
const META_FOLD_CURSOR = 'invalidations_fold_cursor';

interface FoldCursor {
  readonly staleAt: number;
  readonly id: string;
  readonly before: number;
}

/**
 * Built only by retention, never an object's serving-path initialization. The tuple index seeks
 * past a page even when many rows took effect together; the head index bounds each candidate's
 * protection check, rather than building the whole head set each run. Existing objects gain both
 * idempotently at their next fold, with the initial index build borne by that background run.
 */
function prepareFold(sql: SqlStorage): void {
  sql.exec(
    `CREATE INDEX IF NOT EXISTS invalidations_to_fold
     ON invalidations (stale_at, invalidation_id) WHERE target_kind = 'tag'`,
  );
  sql.exec(
    `CREATE INDEX IF NOT EXISTS resource_heads_by_tag_revision ON resource_heads (tag_revision)`,
  );
}

/**
 * Candidates are bounded before protection is tested, including a batch entirely kept by heads.
 * Keep the pass's original cutoff: rows that age past the window during it wait for the next pass,
 * rather than making it chase a busy scope's advancing window. A clock that went back still keeps
 * the history window intact. Backdated insertions behind the cursor wait for the next pass too.
 */
function candidates(
  sql: SqlStorage,
  before: number,
): (InvalidationRow & { at_resource_head: number })[] {
  const kept = readMeta(sql, META_FOLD_CURSOR);
  const after = kept === undefined ? undefined : (JSON.parse(kept) as FoldCursor);
  const position = after === undefined ? [] : [after.staleAt, after.id];
  const cutoff = Math.min(before, after?.before ?? before);
  const rows = sql
    .exec<InvalidationRow & { at_resource_head: number }>(
      `SELECT i.*, EXISTS (
         SELECT 1 FROM resource_heads AS h WHERE h.tag_revision = i.revision
       ) AS at_resource_head
       FROM invalidations AS i INDEXED BY invalidations_to_fold
       WHERE target_kind = 'tag' AND stale_at < ?
         ${after === undefined ? '' : 'AND (stale_at, invalidation_id) > (?, ?)'}
       ORDER BY stale_at, invalidation_id LIMIT ?`,
      cutoff,
      ...position,
      FOLD_BATCH,
    )
    .toArray();
  const last = rows.at(-1);
  if (last !== undefined && rows.length === FOLD_BATCH) {
    writeMeta(
      sql,
      META_FOLD_CURSOR,
      JSON.stringify({ staleAt: last.stale_at, id: last.invalidation_id, before: cutoff }),
    );
  } else {
    deleteMeta(sql, META_FOLD_CURSOR);
  }
  return rows;
}

interface FoldInput {
  readonly sql: SqlStorage;
  readonly limits: ScopeLimits;
  readonly now: number;
}

/** What a tag's rows in one batch come to, as the row it keeps of them is moved by. */
interface Folded {
  readonly revision: number;
  readonly meaning: string;
  /** The latest revision among them of one at once (`immediate`); `null` where none was. */
  readonly latestImmediateRevision: number | null;
  readonly earliestStaleAt: number;
  readonly latestStaleAt: number;
  readonly earliestHardExpireAt: number | null;
  readonly folded: number;
}

/**
 * The latest revision among `rows`, and what it meant: one invalidation names a tag once at its
 * revision, with one meaning. Where rows of one revision should differ, the fold takes the one
 * with a window, which excuses a render less (`weighInvalidations`). And the latest revision of one
 * at once among them, which refuses a render as that one would where the latest has a window.
 */
function foldOf(rows: readonly InvalidationRow[]): Folded {
  const revision = Math.max(...rows.map((row) => row.revision));
  const latest = rows.filter((row) => row.revision === revision);
  const immediate = rows.filter((row) => row.meaning === 'immediate').map((row) => row.revision);
  const deadlines = rows.flatMap((row) =>
    row.hard_expire_at === null ? [] : [row.hard_expire_at],
  );
  return {
    revision,
    meaning: latest.every((row) => row.meaning === 'immediate') ? 'immediate' : 'swr',
    latestImmediateRevision: immediate.length === 0 ? null : Math.max(...immediate),
    earliestStaleAt: Math.min(...rows.map((row) => row.stale_at)),
    latestStaleAt: Math.max(...rows.map((row) => row.stale_at)),
    earliestHardExpireAt: deadlines.length === 0 ? null : Math.min(...deadlines),
    folded: rows.length,
  };
}

/**
 * Move the tag's row by what a batch folds of it: the latest revision and its meaning — the one with
 * a window where a batch before folded the same revision otherwise — the latest revision of one at
 * once, of those that had one, the earliest and latest moments, the earliest deadline of those that
 * had one, and the count.
 */
function foldInto(sql: SqlStorage, tagId: string, fold: Folded): void {
  sql.exec(
    `INSERT INTO folded_invalidations (tag_id, revision, meaning, latest_immediate_revision,
       earliest_stale_at, latest_stale_at, earliest_hard_expire_at, folded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tag_id) DO UPDATE SET
       revision = MAX(revision, excluded.revision),
       meaning = CASE
         WHEN excluded.revision > revision
           OR (excluded.revision = revision AND excluded.meaning = 'swr') THEN excluded.meaning
         ELSE meaning
       END,
       latest_immediate_revision = MAX(
         COALESCE(latest_immediate_revision, excluded.latest_immediate_revision),
         COALESCE(excluded.latest_immediate_revision, latest_immediate_revision)
       ),
       earliest_stale_at = MIN(earliest_stale_at, excluded.earliest_stale_at),
       latest_stale_at = MAX(latest_stale_at, excluded.latest_stale_at),
       earliest_hard_expire_at = MIN(
         COALESCE(earliest_hard_expire_at, excluded.earliest_hard_expire_at),
         COALESCE(excluded.earliest_hard_expire_at, earliest_hard_expire_at)
       ),
       folded = folded + excluded.folded`,
    tagId,
    fold.revision,
    fold.meaning,
    fold.latestImmediateRevision,
    fold.earliestStaleAt,
    fold.latestStaleAt,
    fold.earliestHardExpireAt,
    fold.folded,
  );
}

/**
 * Examine the next bounded page before the history window and fold what no resource head keeps,
 * inside retention's transaction; whether the candidate page was full, and more is left.
 */
export function foldInvalidations(input: FoldInput): boolean {
  const { sql } = input;
  prepareFold(sql);
  const page = candidates(sql, input.now - input.limits.retainHistoryMs);
  const more = page.length === FOLD_BATCH;
  const rows = page.filter((row) => row.at_resource_head === 0);
  if (rows.length === 0) {
    return more;
  }
  const byTag = Map.groupBy(rows, (row) => row.target_id);
  for (const [tagId, folded] of byTag) {
    keepTagHistory(sql, tagId, findTag(sql, tagId));
    foldInto(sql, tagId, foldOf(folded));
  }
  raiseFoldedThrough(sql, {
    revision: Math.max(...rows.map((row) => row.revision)),
    staleAt: Math.max(...rows.map((row) => row.stale_at)),
  });
  sql.exec(
    `DELETE FROM invalidations WHERE invalidation_id IN (SELECT value FROM json_each(?))`,
    JSON.stringify(rows.map((row) => row.invalidation_id)),
  );
  return more;
}
