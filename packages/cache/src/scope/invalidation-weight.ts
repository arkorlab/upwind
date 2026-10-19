import { controlFenceInvalidations } from './control-fences.ts';
import { foldsPast } from './folded-invalidations.ts';
import type { InvalidationRow } from './rows.ts';

export interface CondemnationQuery {
  readonly entryId: string;
  readonly tagIds: readonly string[];
  readonly afterRevision: number;
  /**
   * The revisions each tag's reads were judged against, clipped by `viewHeld`. An immediate
   * invalidation in that view excuses itself and earlier SWR invalidations of the same tag;
   * the last SWR does not excuse itself. Entries and private control fences are never excused.
   */
  readonly held?: ReadonlyMap<string, number> | undefined;
}

export type CondemningInvalidation = Pick<
  InvalidationRow,
  'revision' | 'stale_at' | 'hard_expire_at' | 'meaning'
>;

export interface Weighed {
  readonly condemning: CondemningInvalidation[];
  /** Latest excused persistent revision, or zero: the generation stands past its lease by it. */
  readonly heldThrough: number;
}

interface SummaryRow extends Record<string, SqlStorageValue> {
  revision: number | null;
  stale_at: number | null;
  hard_expire_at: number | null;
  immediate: number;
  held_through: number;
}

const INPUT_AND_FOLDS = `WITH input(after_revision, tag_ids, entry_id, folds_json, held_json)
  AS (VALUES (?, ?, ?, ?, ?)),
folds(target_kind, target_id, revision, stale_at, hard_expire_at, meaning) AS (
  SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'),
    json_extract(value, '$[2]'), json_extract(value, '$[3]'),
    json_extract(value, '$[4]'), json_extract(value, '$[5]')
  FROM json_each((SELECT folds_json FROM input))
)`;

const PERSISTENT = `persistent(target_kind, target_id, revision, stale_at, hard_expire_at, meaning)
AS (
  SELECT target_kind, target_id, revision, stale_at, hard_expire_at, meaning
  FROM invalidations
  WHERE revision > (SELECT after_revision FROM input)
    AND ((target_kind = 'tag'
      AND target_id IN (SELECT value FROM json_each((SELECT tag_ids FROM input))))
      OR (target_kind = 'entry' AND target_id = (SELECT entry_id FROM input)))
  UNION ALL
  SELECT target_kind, target_id, revision, stale_at, hard_expire_at, meaning FROM folds
)`;

/** No per-tag held state is needed for the ordinary lease or a seed's afterRevision: 0. */
const WITHOUT_HELD = `${INPUT_AND_FOLDS}, ${PERSISTENT}
SELECT MAX(revision) AS revision, MIN(stale_at) AS stale_at,
  MIN(hard_expire_at) AS hard_expire_at,
  COALESCE(MAX(CASE WHEN meaning = 'immediate' THEN 1 ELSE 0 END), 0) AS immediate,
  0 AS held_through
FROM persistent`;

/**
 * The persistent stream is used once. Latest held immediate revisions have their own
 * predicate rather than reusing a materialized history CTE. SQLite may still scan matching history
 * twice and use temporary grouping/sort storage; one result row does not bound engine work.
 */
const WITH_HELD = `${INPUT_AND_FOLDS},
held(tag_id, revision) AS (
  SELECT key, value FROM json_each((SELECT held_json FROM input))
),
raw_afresh(tag_id, revision) AS (
  SELECT i.target_id, MAX(i.revision)
  FROM invalidations i JOIN held h ON h.tag_id = i.target_id
  WHERE i.target_kind = 'tag' AND i.meaning = 'immediate'
    AND i.revision > (SELECT after_revision FROM input) AND i.revision <= h.revision
    AND i.target_id IN (SELECT value FROM json_each((SELECT tag_ids FROM input)))
  GROUP BY i.target_id
),
fold_afresh(tag_id, revision) AS (
  SELECT f.target_id, MAX(f.revision)
  FROM folds f JOIN held h ON h.tag_id = f.target_id
  WHERE f.target_kind = 'tag' AND f.meaning = 'immediate' AND f.revision <= h.revision
  GROUP BY f.target_id
),
afresh(tag_id, revision) AS (
  SELECT tag_id, MAX(revision) FROM (
    SELECT tag_id, revision FROM raw_afresh
    UNION ALL SELECT tag_id, revision FROM fold_afresh
  ) GROUP BY tag_id
),
${PERSISTENT},
judged AS (
  SELECT p.revision, p.stale_at, p.hard_expire_at, p.meaning,
    (p.target_kind = 'tag' AND p.revision <= COALESCE(h.revision, 0)
      AND (p.meaning = 'immediate' OR COALESCE(a.revision, p.revision) > p.revision)) AS excused
  FROM persistent p
  LEFT JOIN held h ON p.target_kind = 'tag' AND h.tag_id = p.target_id
  LEFT JOIN afresh a ON p.target_kind = 'tag' AND a.tag_id = p.target_id
)
SELECT MAX(CASE WHEN NOT excused THEN revision END) AS revision,
  MIN(CASE WHEN NOT excused THEN stale_at END) AS stale_at,
  MIN(CASE WHEN NOT excused THEN hard_expire_at END) AS hard_expire_at,
  COALESCE(MAX(CASE WHEN NOT excused AND meaning = 'immediate' THEN 1 ELSE 0 END), 0) AS immediate,
  COALESCE(MAX(CASE WHEN excused THEN revision END), 0) AS held_through
FROM judged`;

function summarized(row: SummaryRow): CondemningInvalidation[] {
  if (row.revision === null) return [];
  // Both the ledger and fold rows have NOT NULL stale moments. Keep an impossible aggregate
  // failure visible instead of manufacturing a deadline when a nonempty result violates that.
  if (row.stale_at === null) throw new Error('an invalidation summary has no stale moment');
  return [
    {
      revision: row.revision,
      stale_at: row.stale_at,
      hard_expire_at: row.hard_expire_at,
      meaning: row.immediate === 1 ? 'immediate' : 'swr',
    },
  ];
}

/**
 * Weigh retained history inside SQLite, returning at most one persistent summary to JavaScript.
 * Existing folds retain their synthetic latest immediate and conservative deadlines. Only their
 * six required fields and the held tag map cross back into SQL, never the retained row graph.
 * Private fences are appended after persistent excusal, so holding a tag cannot excuse a fence.
 */
export function weighInvalidations(sql: SqlStorage, query: CondemnationQuery): Weighed {
  const folds = foldsPast(sql, query.tagIds, query.afterRevision);
  const encodedFolds = JSON.stringify(
    folds.map((row) => [
      row.target_kind,
      row.target_id,
      row.revision,
      row.stale_at,
      row.hard_expire_at,
      row.meaning,
    ]),
  );
  const held = query.held;
  const encodedHeld = held === undefined ? '{}' : JSON.stringify(Object.fromEntries(held));
  const row = sql
    .exec<SummaryRow>(
      encodedHeld === '{}' ? WITHOUT_HELD : WITH_HELD,
      query.afterRevision,
      JSON.stringify(query.tagIds),
      query.entryId,
      encodedFolds,
      encodedHeld,
    )
    .one();
  return {
    condemning: [...summarized(row), ...controlFenceInvalidations(sql, query)],
    heldThrough: row.held_through,
  };
}
