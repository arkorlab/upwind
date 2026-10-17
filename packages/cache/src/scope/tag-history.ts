import { MAX_TAG_HISTORY, type TagHistoryMark, withTagHistory } from '@stayingupwind/core/cache';

import { controlFenceTag } from './control-fences.ts';
import { foldedMark } from './folded-invalidations.ts';
import type { InvalidationRow, TagRow } from './rows.ts';
import { readMeta, writeMeta } from './state.ts';

const META_TAG_HISTORY_PREFIX = 'tag_history:';
type RecordedTagDeadline = Pick<InvalidationRow, 'revision' | 'stale_at' | 'hard_expire_at'>;

export function readTagHistory(sql: SqlStorage, tagId: string): TagHistoryMark[] | undefined {
  const value = readMeta(sql, META_TAG_HISTORY_PREFIX + tagId);
  return value === undefined ? undefined : (JSON.parse(value) as TagHistoryMark[]);
}

function toMark(row: RecordedTagDeadline): TagHistoryMark {
  return { revision: row.revision, staleAt: row.stale_at, hardExpireAt: row.hard_expire_at };
}

/**
 * Every raw tag invalidation's deadline is its timestamp plus a nonnegative expiry
 * (`applyInvalidate`); an immediate invalidation uses its timestamp. Thus a deadline not inspected
 * here cannot precede the first timestamp beyond the sample. Coalesced control fences and stored
 * history can have earlier deadlines, and are merged separately without this assumption.
 *
 * At most fifteen newer rows are excluded by `through`, so the forced timestamp-index seek visits
 * at most those fifteen plus this bounded sample, even where clocks moved backwards.
 */
function tailDeadline(sql: SqlStorage, tagId: string, through: number): number | null {
  const oldest = sql
    .exec<RecordedTagDeadline>(
      `SELECT revision, stale_at, hard_expire_at
       FROM invalidations INDEXED BY invalidations_by_target_stale
       WHERE target_kind = 'tag' AND target_id = ? AND revision <= ?
       ORDER BY stale_at LIMIT ?`,
      tagId,
      through,
      MAX_TAG_HISTORY + 1,
    )
    .toArray();
  let deadline = oldest[MAX_TAG_HISTORY]?.stale_at ?? Infinity;
  for (const row of oldest.slice(0, MAX_TAG_HISTORY)) {
    deadline = Math.min(deadline, row.hard_expire_at ?? Infinity);
  }
  return deadline === Infinity ? null : deadline;
}

/** A conservative summary of the old tail, whose largest timestamp needs at most sixteen reads. */
function tailMark(sql: SqlStorage, tagId: string, through: number): TagHistoryMark {
  const latest = sql
    .exec<{ stale_at: number }>(
      `SELECT stale_at FROM invalidations INDEXED BY invalidations_by_target_stale
       WHERE target_kind = 'tag' AND target_id = ? AND revision <= ?
       ORDER BY stale_at DESC LIMIT 1`,
      tagId,
      through,
    )
    .one();
  return {
    revision: through,
    staleAt: latest.stale_at,
    hardExpireAt: tailDeadline(sql, tagId, through),
  };
}

/**
 * Upgrade old metadata only on mutation, with bounded reads as well as bounded retained state.
 * Small ledgers remain exact. Overflow retains the newest fifteen rows and a conservative old
 * tail: its deadline lower bound may expire an old value early, but never reopens an expired one.
 * A tag's fold stands for the rows retention folded (`foldedMark`), though the fold stores the
 * tag's history before it folds any (`keepTagHistory`), and this is never asked of such a tag.
 */
function legacyHistory(sql: SqlStorage, tagId: string): TagHistoryMark[] {
  const newest = sql
    .exec<RecordedTagDeadline>(
      `SELECT revision, stale_at, hard_expire_at
       FROM invalidations INDEXED BY invalidations_by_target
       WHERE target_kind = 'tag' AND target_id = ? ORDER BY revision DESC LIMIT ?`,
      tagId,
      MAX_TAG_HISTORY + 1,
    )
    .toArray();
  const cutoff = newest.length > MAX_TAG_HISTORY ? newest[MAX_TAG_HISTORY - 1] : undefined;
  const retained = cutoff === undefined ? newest : newest.slice(0, MAX_TAG_HISTORY - 1);
  let history = cutoff === undefined ? [] : [tailMark(sql, tagId, cutoff.revision)];
  const folded = foldedMark(sql, tagId);
  if (folded !== undefined) history = withTagHistory(history, folded);
  for (const row of retained.toReversed()) history = withTagHistory(history, toMark(row));
  return history;
}

/**
 * The history a mutation that finds none stored upgrades a tag to: its rows in the ledger, the
 * mark its row keeps, and a fence of it.
 */
function upgradedHistory(
  sql: SqlStorage,
  tagId: string,
  previous: TagRow | undefined,
): TagHistoryMark[] {
  let history = previous === undefined ? [] : legacyHistory(sql, tagId);
  if (previous !== undefined && previous.stale_at !== null) {
    history = withTagHistory(history, toMark({ ...previous, stale_at: previous.stale_at }));
  }
  const fence = controlFenceTag(sql, tagId);
  return fence === undefined ? history : withTagHistory(history, fence);
}

export function recordTagHistory(
  sql: SqlStorage,
  tagId: string,
  mark: TagHistoryMark,
  previous: TagRow | undefined,
): void {
  const history = readTagHistory(sql, tagId) ?? upgradedHistory(sql, tagId, previous);
  writeMeta(sql, META_TAG_HISTORY_PREFIX + tagId, JSON.stringify(withTagHistory(history, mark)));
}

/**
 * Store a tag's history where none is stored yet, as its next invalidation would upgrade it from
 * its rows (`legacyHistory`): what retention's fold does before it folds any of them
 * (`invalidation-fold.ts`), which the upgrade reads. A tag invalidated since histories were kept
 * has one already, and nothing is written. Nor for a tag the scope keeps no row of: its upgrade
 * reads nothing of the ledger, and takes in a fence of it made since, which a history stored now
 * would leave out.
 */
export function keepTagHistory(sql: SqlStorage, tagId: string, tag: TagRow | undefined): void {
  if (tag !== undefined && readTagHistory(sql, tagId) === undefined) {
    writeMeta(
      sql,
      META_TAG_HISTORY_PREFIX + tagId,
      JSON.stringify(upgradedHistory(sql, tagId, tag)),
    );
  }
}
