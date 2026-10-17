import type { TagHistoryMark } from '@stayingupwind/core/cache';
import { z } from 'zod';

import type { InvalidationRow, TagRow } from './rows.ts';
import { readMeta, writeMeta } from './state.ts';

/**
 * What a scope keeps of the invalidations that took effect before its history window: one row a
 * tag (`folded_invalidations`), which retention folds them into a batch at a time
 * (`invalidation-fold.ts`). It keeps the latest revision among them and what that one meant, the
 * latest revision of one at once (`immediate`) among them, the earliest and the latest moment one of
 * them took effect, the earliest hard deadline, and how many there were.
 *
 * Whatever asks back past them weighs a tag's fold as one invalidation, which condemns whatever any
 * of them did, and as early: as of the latest revision, reaching every value made before the latest
 * moment, stale from the earliest, expired at the earliest deadline. A render's commit weighs the
 * latest one at once beside it where that is not the latest (`foldsPast`), so that a render one of
 * them would refuse is refused as before. It may condemn earlier than the invalidations themselves
 * would have, and never takes back what one of them condemned. Whatever asks nothing that far back
 * is answered from the invalidations it always was, and reads nothing more: how far the folds reach
 * is kept beside them, and held in memory once read (`foldedThrough`).
 */

/** How far a scope's folds reach: the latest revision folded, and the latest moment one took effect. */
export interface FoldedThrough {
  readonly revision: number;
  readonly staleAt: number;
}

const META_FOLDED_THROUGH = 'invalidations_folded_through';
const NOTHING_FOLDED: FoldedThrough = { revision: 0, staleAt: -Infinity };
const foldedThroughSchema = z.object({ revision: z.number(), staleAt: z.number() });

/**
 * Where each object's folds reach, once read: its storage's `sql` is the same object for as long as
 * the object lives. Raised by the fold in the transaction that deletes what it folded
 * (`raiseFoldedThrough`), so it is never short of what storage holds. A fold whose transaction
 * fails leaves it past what storage holds, which costs a question a read and changes no answer.
 */
const held = new WeakMap<SqlStorage, FoldedThrough>();

export function foldedThrough(sql: SqlStorage): FoldedThrough {
  const known = held.get(sql);
  if (known !== undefined) {
    return known;
  }
  const kept = readMeta(sql, META_FOLDED_THROUGH);
  const through = kept === undefined ? NOTHING_FOLDED : foldedThroughSchema.parse(JSON.parse(kept));
  held.set(sql, through);
  return through;
}

/** Called by the fold before it deletes what it folded, as far as that reaches. */
export function raiseFoldedThrough(sql: SqlStorage, folded: FoldedThrough): void {
  const before = foldedThrough(sql);
  const through = {
    revision: Math.max(before.revision, folded.revision),
    staleAt: Math.max(before.staleAt, folded.staleAt),
  };
  held.set(sql, through);
  writeMeta(sql, META_FOLDED_THROUGH, JSON.stringify(through));
}

interface FoldRow extends Record<string, SqlStorageValue> {
  tag_id: string;
  revision: number;
  meaning: string;
  latest_immediate_revision: number | null;
  earliest_stale_at: number;
  latest_stale_at: number;
  earliest_hard_expire_at: number | null;
  folded: number;
}

/**
 * A tag's fold as the invalidation a render or a value is weighed against (`weighInvalidations`,
 * `dataCondemnation`): as of its latest revision and with that one's meaning, stale from the
 * earliest moment, expired at the earliest deadline. What asked for the invalidations it stands for
 * is not kept: nothing weighed is told as a record of its own.
 */
function asInvalidation(fold: FoldRow): InvalidationRow {
  return {
    invalidation_id: `inv_folded_${fold.tag_id}`,
    revision: fold.revision,
    target_kind: 'tag',
    target_id: fold.tag_id,
    target_value: null,
    stale_at: fold.earliest_stale_at,
    hard_expire_at: fold.earliest_hard_expire_at,
    meaning: fold.meaning,
    expire_seconds: null,
    cause: '{}',
    recorded_at: fold.latest_stale_at,
  };
}

/**
 * The latest invalidation at once a fold stands for, weighed as one of its own where a question past
 * `afterRevision` reaches it and the fold's latest is not that one. Weighed as its latest alone, a
 * fold whose latest has a window would let a render publish that the one at once refuses, its view
 * not having held it (`weighInvalidations`); beside it, the render is refused as by its row. It
 * takes the fold's moments and deadline, so what a render it does not refuse is condemned by is the
 * fold's alone.
 */
function latestImmediateOf(fold: FoldRow, afterRevision: number): InvalidationRow | undefined {
  const revision = fold.latest_immediate_revision;
  if (
    revision === null ||
    revision <= afterRevision ||
    (fold.meaning === 'immediate' && revision === fold.revision)
  ) {
    return undefined;
  }
  return {
    ...asInvalidation(fold),
    invalidation_id: `inv_folded_immediate_${fold.tag_id}`,
    revision,
    meaning: 'immediate',
  };
}

/**
 * The folds of `tagIds` holding an invalidation past `afterRevision`: what a render whose inputs
 * were read at that revision, or a build's output, is weighed against beside the invalidations kept
 * (`weighInvalidations`) — each fold, and the latest invalidation at once it stands for where that is
 * past `afterRevision` and not the fold's latest (`latestImmediateOf`). None, and nothing read, where
 * no fold reaches past it.
 */
export function foldsPast(
  sql: SqlStorage,
  tagIds: readonly string[],
  afterRevision: number,
): InvalidationRow[] {
  if (tagIds.length === 0 || afterRevision >= foldedThrough(sql).revision) {
    return [];
  }
  const folds = sql
    .exec<FoldRow>(
      `SELECT * FROM folded_invalidations
       WHERE tag_id IN (SELECT value FROM json_each(?)) AND revision > ?`,
      JSON.stringify(tagIds),
      afterRevision,
    )
    .toArray();
  return folds.flatMap((fold) => {
    const immediate = latestImmediateOf(fold, afterRevision);
    return immediate === undefined ? [asInvalidation(fold)] : [asInvalidation(fold), immediate];
  });
}

/**
 * The folds of `tagIds` holding an invalidation that took effect at or after `timestamp`: what a
 * value made then is condemned by beside the invalidations kept (`dataCondemnation`). None, and
 * nothing read, where no fold took effect that late.
 */
export function foldsFrom(
  sql: SqlStorage,
  tagIds: readonly string[],
  timestamp: number,
): InvalidationRow[] {
  if (tagIds.length === 0 || timestamp > foldedThrough(sql).staleAt) {
    return [];
  }
  const folds = sql
    .exec<FoldRow>(
      `SELECT * FROM folded_invalidations
       WHERE tag_id IN (SELECT value FROM json_each(?)) AND latest_stale_at >= ?`,
      JSON.stringify(tagIds),
      timestamp,
    )
    .toArray();
  return folds.map((fold) => asInvalidation(fold));
}

/** What an edge asks of a scope's recent invalidations (`recentDelta`). */
interface RecentQuery {
  readonly since: number;
  readonly limit: number;
  readonly from: number;
}

/** The folds an edge is told of (`recentFolds`), and how many invalidations they stand for. */
export interface RecentFolds {
  readonly rows: readonly TagRow[];
  readonly folded: number;
}

const NO_FOLDS: RecentFolds = { rows: [], folded: 0 };

/**
 * The folds holding an invalidation past `since` that took effect from `from` on, each as its
 * tag's one invalidation as a reader of tags judges by it — reaching every value made before the
 * latest moment, expired at the earliest deadline — newest first and `limit` and one more at the
 * most; and how many invalidations those stand for, which an answer that counts each one counts
 * (`recentDelta`). None, and nothing read, where no fold reaches that window: an edge asks of the
 * last hour, and a fold holds none of it.
 */
export function recentFolds(sql: SqlStorage, query: RecentQuery): RecentFolds {
  const through = foldedThrough(sql);
  if (query.since >= through.revision || query.from > through.staleAt) {
    return NO_FOLDS;
  }
  const rows = sql
    .exec<TagRow & { folded: number }>(
      `SELECT t.tag_id AS tag_id, t.kind AS kind, t.value AS value, f.revision AS revision,
              f.latest_stale_at AS stale_at, f.earliest_hard_expire_at AS hard_expire_at,
              f.meaning AS meaning, f.folded AS folded
       FROM folded_invalidations AS f INDEXED BY folded_invalidations_by_stale_at
       JOIN tags AS t ON t.tag_id = f.tag_id
       WHERE f.latest_stale_at >= ? AND f.revision > ?
       ORDER BY f.revision DESC LIMIT ?`,
      query.from,
      query.since,
      query.limit + 1,
    )
    .toArray();
  return { rows, folded: rows.reduce((sum, row) => sum + row.folded, 0) };
}

/**
 * A tag's fold as a mark of its history (`legacyHistory`): reaching every value made before the
 * latest moment, expired at the earliest deadline, as of the latest revision. None, and nothing
 * read, where nothing was ever folded.
 */
export function foldedMark(sql: SqlStorage, tagId: string): TagHistoryMark | undefined {
  if (foldedThrough(sql).revision === 0) {
    return undefined;
  }
  const fold = sql
    .exec<FoldRow>(`SELECT * FROM folded_invalidations WHERE tag_id = ?`, tagId)
    .toArray()[0];
  return fold === undefined
    ? undefined
    : {
        revision: fold.revision,
        staleAt: fold.latest_stale_at,
        hardExpireAt: fold.earliest_hard_expire_at,
      };
}
