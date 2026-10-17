import type { ScopeLimits } from '../env.ts';
import { raiseFoldedThrough } from './folded-invalidations.ts';
import type { InvalidationRow } from './rows.ts';
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
 * A batch at a time, the oldest first, as retention lets go of anything: one that comes back full
 * leaves the rest to a run that comes within a second (`RetentionPlan.more`). Nothing is announced
 * and no revision is committed: what any reader is told of a tag stands as it stood. Only an active
 * scope's are folded: a retired one records no more, and goes whole once its history window is over.
 */

/** How many invalidations one run of retention folds at the most. */
const FOLD_BATCH = 200;

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
 * Fold the oldest batch of the invalidations that took effect before the history window, inside
 * retention's transaction; whether the batch came back full, and more is left.
 */
export function foldInvalidations(input: FoldInput): boolean {
  const { sql } = input;
  const rows = sql
    .exec<InvalidationRow>(
      `SELECT * FROM invalidations INDEXED BY invalidations_by_stale_at
       WHERE stale_at < ? AND target_kind = 'tag'
         AND revision NOT IN (SELECT tag_revision FROM resource_heads)
       ORDER BY stale_at LIMIT ?`,
      input.now - input.limits.retainHistoryMs,
      FOLD_BATCH,
    )
    .toArray();
  if (rows.length === 0) {
    return false;
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
  return rows.length === FOLD_BATCH;
}
