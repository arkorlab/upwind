import { tagIdFor, type TagHistoryMark } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import {
  INVALIDATION_ID_PREFIX,
  type InvalidateRequest,
  type InvalidateResponse,
} from '@stayingupwind/host/cache';

import {
  controlFencesFit,
  controlFenceTag,
  queueControlFence,
  reclaimControlFenceCapacity,
} from './control-fences.ts';
import type { EventInput } from './history.ts';
import { type InvalidationRow, toInvalidation, toTag } from './rows.ts';
import { isRefusal, type Refusal, refuse, requireActiveScope } from './state.ts';
import {
  findTag,
  controlTagProjectionsFit,
  hasCurrentTag,
  markTagInvalidated,
  queueControlTagProjection,
  tagKindFor,
  type TagRef,
  tagsFit,
  toDeltaEntry,
} from './tags.ts';
import { type Apply, record, type TxInput } from './tx.ts';

/**
 * On-demand invalidation, as Next.js means it. Without an `expire` the tag's entries are expired
 * at once — the next request waits for a fresh render — and with one they are stale until then,
 * served while a regeneration runs behind the response. Either way the ledger remembers the
 * invalidation's revision, so a render that read its inputs earlier is condemned at commit, and
 * one that read them later is not. Private control fanout uses bounded transient admission fences
 * and exact KV delivery marks for absent tags, without permanent tag rows or any history of them.
 * Reclaimed fences leave a constant admission floor that refuses older tagged writes and views.
 */

const MILLISECONDS_PER_SECOND = 1000;
const INVALIDATION_BATCH_SIZE = 200;
const TAG_MASK_BITS = 32;

/**
 * How far before its own clock the authority lets an invalidation take effect, where the Worker that
 * asked says when it put it in force there (`InvalidateRequest.inForceAt`, `inForceMoment`).
 *
 * The moment is the Worker's to say: a runtime puts an invalidation in force in its isolate before it
 * calls, and renders on — a Server Action's page, while the authority records what the action
 * invalidated — stamping what it computes after the invalidation later than it. Recorded at the
 * authority's own clock, once the call had come, the invalidation condemned those values, made after
 * it as they were. So it is recorded at the Worker's moment, but never later than the authority's
 * clock, which no invalidation may reach past, and no further back than this: what another isolate
 * made in between — by a clock that read later than the moment, from what its view still held of
 * values from before — is kept, where it would have been condemned. That window is the one Next.js
 * keeps itself, whose tags expire as of the moment `revalidateTag` ran on the server that ran it, and
 * this bounds it. Two seconds is how long the runtime holds the response of a request that
 * invalidated for the record of it, and the writes of its render behind it: a call that reaches the
 * authority within that comes while the request still waits on it, beside what its render wrote. One
 * that comes later — a call held up, a later chunk of a large one, a moment forged — is recorded as if
 * put in force two seconds before it came.
 */
export const IN_FORCE_WITHIN_MS = 2000;

/**
 * The moment an invalidation takes effect at, by the authority's clock `now`: the one the Worker said
 * it put it in force at, no later than `now` and no earlier than `IN_FORCE_WITHIN_MS` before it — a
 * fraction of a millisecond taken to the next whole one, as a moment that reaches more — or `now`
 * where it said none, or nothing a moment can be read from.
 */
export function inForceMoment(request: Pick<InvalidateRequest, 'inForceAt'>, now: number): number {
  const said = request.inForceAt;
  if (typeof said !== 'number' || !Number.isFinite(said)) {
    return now;
  }
  return Math.min(now, Math.max(now - IN_FORCE_WITHIN_MS, Math.ceil(said)));
}

interface InvalidatePlan {
  readonly request: InvalidateRequest;
  readonly targets: readonly { readonly ref: TagRef; readonly invalidationId: string }[];
  readonly control: boolean;
}

export type InvalidateResult = InvalidateResponse | Refusal;

export async function planInvalidate(
  input: TxInput,
  request: InvalidateRequest,
  mode: 'public' | 'control' = 'public',
): Promise<Apply<InvalidateResponse | Refusal>> {
  const targets = await Promise.all(
    request.tags.map(async (tag) => {
      const kind = tagKindFor(tag.value, tag.kind);
      return {
        ref: { tagId: await tagIdFor(input.scopeId, kind, tag.value), kind, value: tag.value },
        invalidationId: createId(INVALIDATION_ID_PREFIX),
      };
    }),
  );
  return () => applyInvalidate(input, { request, targets, control: mode === 'control' });
}

function rowForInvalidation(
  input: TxInput,
  target: InvalidatePlan['targets'][number],
  deadlines: { staleAt: number; hardExpireAt: number | null; meaning: 'immediate' | 'swr' },
  request: InvalidateRequest,
): InvalidationRow {
  const { now, revision } = input;
  const row: InvalidationRow = {
    invalidation_id: target.invalidationId,
    revision,
    target_kind: 'tag',
    target_id: target.ref.tagId,
    target_value: target.ref.value,
    stale_at: deadlines.staleAt,
    hard_expire_at: deadlines.hardExpireAt,
    meaning: deadlines.meaning,
    expire_seconds: request.expire ?? null,
    cause: JSON.stringify(request.cause),
    recorded_at: now,
  };
  return row;
}

function insertInvalidation(sql: SqlStorage, row: InvalidationRow): void {
  sql.exec(
    `INSERT INTO invalidations (
       invalidation_id, revision, target_kind, target_id, target_value, stale_at, hard_expire_at,
       meaning, expire_seconds, cause, recorded_at
     ) VALUES (?, ?, 'tag', ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.invalidation_id,
    row.revision,
    row.target_id,
    row.target_value,
    row.stale_at,
    row.hard_expire_at,
    row.meaning,
    row.expire_seconds,
    row.cause,
    row.recorded_at,
  );
}

/**
 * Of the entries with one of the tags `?` (a JSON array of their ids), those whose current value of
 * the data cache was made after the moment `?`, by its own timestamp: when the value began to be
 * computed, which the value's write is fenced by too (`dataCondemnation`, in `data.ts`). An
 * invalidation taking effect at that moment reaches none of them. A render goes on while the
 * authority records what its request invalidated (`inForceMoment`), and what it computed after the
 * moment can be written, and stand current, before the call — or a later chunk of a large one — is
 * recorded: it is kept, as the same write arriving after it is. Looked for among the entries with
 * the tags, by their index, and not among every entry of the scope, which has no index of kinds:
 * what an invalidation reads is what it reaches, as it was.
 *
 * Only the data cache's. A page's or a route handler's generation is stamped when its regeneration
 * built the commit, after its render had read what it is made of, so nothing of it says when that
 * render read: it is reached by its tags alone, as it was.
 */
const MADE_AFTER_THE_MOMENT = `SELECT e.entry_id FROM entry_tags et
  JOIN entries e ON e.entry_id = et.entry_id
  JOIN generations g ON g.generation_id = e.current_generation_id
  WHERE et.tag_id IN (SELECT value FROM json_each(?))
    AND e.kind LIKE 'data:%' AND g.cache_timestamp > ?`;

/**
 * Condemn the matching set in SQLite without allocating a generation/event per entry: the current
 * generations of the entries with the tags, and those entries — but the values made after the moment
 * the invalidation takes effect at (`MADE_AFTER_THE_MOMENT`), which it does not reach.
 */
function condemnCurrent(
  input: TxInput,
  tagIds: readonly string[],
  immediate: boolean,
  deadlines: { readonly staleAt: number; readonly hardExpireAt: number },
): void {
  const { sql, now, revision } = input;
  const { staleAt, hardExpireAt } = deadlines;
  const targets = JSON.stringify(tagIds);
  sql.exec(
    `UPDATE generations SET condemned = json_object(
       'revision', MAX(COALESCE(json_extract(condemned, '$.revision'), 0), ?),
       'staleAt', MIN(COALESCE(json_extract(condemned, '$.staleAt'), ?), ?),
       'hardExpireAt', MIN(COALESCE(json_extract(condemned, '$.hardExpireAt'), ?), ?)
     ) WHERE generation_id IN (
       SELECT current_generation_id FROM entries WHERE entry_id IN (
         SELECT entry_id FROM entry_tags WHERE tag_id IN (SELECT value FROM json_each(?))
       ) AND entry_id NOT IN (${MADE_AFTER_THE_MOMENT})
     )`,
    revision,
    staleAt,
    staleAt,
    hardExpireAt,
    hardExpireAt,
    targets,
    targets,
    staleAt,
  );
  sql.exec(
    `UPDATE entries SET revision = ?, record_revision = ?,
       tombstone_revision = COALESCE(?, tombstone_revision),
       regeneration = CASE regeneration WHEN 'idle' THEN 'queued' ELSE regeneration END,
       updated_at = ?
     WHERE entry_id IN (
       SELECT entry_id FROM entry_tags WHERE tag_id IN (SELECT value FROM json_each(?))
     ) AND entry_id NOT IN (${MADE_AFTER_THE_MOMENT})`,
    revision,
    revision,
    immediate ? revision : null,
    now,
    targets,
    targets,
    staleAt,
  );
}

interface AffectedRow extends Record<string, SqlStorageValue> {
  readonly entry_id: string;
  readonly mask0: number;
  readonly mask1: number;
  readonly mask2: number;
  readonly mask3: number;
}

/**
 * Four 32-bit masks encode up to 128 tag memberships once per affected entry: an entry with one of
 * the tags whose current value was not made after `staleAt`, the moment the invalidation takes effect
 * at (`MADE_AFTER_THE_MOMENT`). What the history is told the invalidation reached, as what it
 * condemns (`condemnCurrent`).
 */
function affectedEntries(
  sql: SqlStorage,
  tagIds: readonly string[],
  staleAt: number,
): AffectedRow[] {
  const targets = JSON.stringify(tagIds);
  return sql
    .exec<AffectedRow>(
      `SELECT et.entry_id,
       SUM(CASE WHEN CAST(t.key AS INTEGER) < 32 THEN 1 << CAST(t.key AS INTEGER) ELSE 0 END) AS mask0,
       SUM(CASE WHEN CAST(t.key AS INTEGER) BETWEEN 32 AND 63 THEN 1 << (CAST(t.key AS INTEGER) - 32) ELSE 0 END) AS mask1,
       SUM(CASE WHEN CAST(t.key AS INTEGER) BETWEEN 64 AND 95 THEN 1 << (CAST(t.key AS INTEGER) - 64) ELSE 0 END) AS mask2,
       SUM(CASE WHEN CAST(t.key AS INTEGER) BETWEEN 96 AND 127 THEN 1 << (CAST(t.key AS INTEGER) - 96) ELSE 0 END) AS mask3
     FROM entry_tags et JOIN json_each(?) t ON t.value = et.tag_id
     WHERE et.entry_id NOT IN (${MADE_AFTER_THE_MOMENT})
     GROUP BY et.entry_id ORDER BY et.entry_id`,
      targets,
      targets,
      staleAt,
    )
    .toArray();
}

function includesTag(entry: AffectedRow, index: number): boolean {
  const masks = [entry.mask0, entry.mask1, entry.mask2, entry.mask3];
  const mask = masks[Math.floor(index / TAG_MASK_BITS)] ?? 0;
  return Math.floor(mask / 2 ** (index % TAG_MASK_BITS)) % 2 === 1;
}

function captureControlTags(input: TxInput, plan: InvalidatePlan): void {
  if (plan.control) input.controlTagIds?.push(...plan.targets.map((target) => target.ref.tagId));
}

/** The reply must carry the same older deadlines as a regional read, without another host call. */
function replyHistory(
  sql: SqlStorage,
  tagId: string,
  current: Pick<TagHistoryMark, 'staleAt' | 'hardExpireAt'>,
): TagHistoryMark[] | undefined {
  const tag = findTag(sql, tagId);
  if (tag !== undefined) return toDeltaEntry(tag, sql).history;
  const fence = controlFenceTag(sql, tagId);
  if (
    fence === undefined ||
    (fence.staleAt === current.staleAt && fence.hardExpireAt === current.hardExpireAt)
  )
    return undefined;
  return [{ revision: fence.revision, staleAt: fence.staleAt, hardExpireAt: fence.hardExpireAt }];
}

function applyTarget(
  input: TxInput,
  target: InvalidatePlan['targets'][number],
  state: {
    readonly deadlines: {
      staleAt: number;
      hardExpireAt: number | null;
      meaning: 'immediate' | 'swr';
    };
    readonly request: InvalidateRequest;
    readonly persistent: boolean;
    readonly entryIds: string[];
    readonly events: EventInput[];
  },
): void {
  const { deadlines, request, persistent, entryIds, events } = state;
  const row = rowForInvalidation(input, target, deadlines, request);
  const write = { ref: target.ref, revision: input.revision, ...deadlines };
  if (!persistent) {
    queueControlFence(input.sql, { ...write.ref, ...deadlines, revision: input.revision }, row);
    queueControlTagProjection(input.sql, write);
    return;
  }
  markTagInvalidated(input.sql, write);
  input.invalidatedTagIds?.push(target.ref.tagId);
  insertInvalidation(input.sql, row);
  const tag = findTag(input.sql, target.ref.tagId);
  events.push({
    entityType: 'invalidation',
    entityId: target.invalidationId,
    kind: 'invalidation.recorded',
    payload: {
      invalidation: toInvalidation(input.scopeId, row),
      tag: tag === undefined ? null : toTag(input.scopeId, tag),
      affectedEntryIds: entryIds,
    },
  });
}

function entryIdsFor(
  target: InvalidatePlan['targets'][number],
  indices: ReadonlyMap<string, number>,
  affected: readonly AffectedRow[],
  compact: boolean,
): string[] {
  const index = indices.get(target.invalidationId);
  return compact || index === undefined
    ? []
    : affected.filter((entry) => includesTag(entry, index)).map((entry) => entry.entry_id);
}

/**
 * An invalidation's transaction: refused before anything is written where the scope may hold no
 * more of what it would keep; otherwise each tag recorded at the moment it takes effect at
 * (`inForceMoment`), the entries it reaches condemned (`condemnCurrent`), and the history told what
 * it reached (`affectedEntries`).
 */
function applyInvalidate(input: TxInput, plan: InvalidatePlan): InvalidateResponse | Refusal {
  const { sql, scopeId, now, revision, limits } = input;
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  // Public invalidation keeps every tag for good. Private fanout only keeps tags already held or
  // referenced by a current generation; absent tags have a transient exact-mark projection.
  // Refuse the whole invalidation before any writes when the permanent rows would not fit.
  const refs = plan.targets
    .map((target) => target.ref)
    .filter(
      (ref) =>
        !plan.control || findTag(sql, ref.tagId) !== undefined || hasCurrentTag(sql, ref.tagId),
    );
  const persistent = new Set(refs.map((ref) => ref.tagId));
  const absent = plan.targets
    .filter((target) => !persistent.has(target.ref.tagId))
    .map((target) => target.ref);
  if (!controlTagProjectionsFit(sql, absent)) {
    return refuse('quota_exceeded', 'the scope has as many pending control tags as it may');
  }
  const absentIds = absent.map((ref) => ref.tagId);
  if (!controlFencesFit(sql, absentIds, now)) {
    return refuse('quota_exceeded', 'the scope has as many control fences as it may');
  }
  if (!tagsFit(sql, refs, limits.tagsPerScope)) {
    return refuse('quota_exceeded', 'the scope holds as many tags as it may');
  }
  const { request } = plan;
  const immediate = request.expire === undefined || request.expire === 0;
  // A window of a fraction of a second ends on the nearest whole millisecond, as every deadline is
  // kept, and one past the moment at the least, so it is never none.
  const windowMs = Math.max(1, Math.round((request.expire ?? 0) * MILLISECONDS_PER_SECOND));
  // When the Worker put it in force, within the window the authority allows (`inForceMoment`).
  const at = inForceMoment(request, now);
  const deadlines = {
    staleAt: at,
    hardExpireAt: immediate ? at : at + windowMs,
    meaning: immediate ? ('immediate' as const) : ('swr' as const),
  };
  const events: EventInput[] = [];
  const persistentTargets = plan.targets.filter((target) => persistent.has(target.ref.tagId));
  const indices = new Map(persistentTargets.map((target, index) => [target.invalidationId, index]));
  const affected = affectedEntries(
    sql,
    persistentTargets.map((target) => target.ref.tagId),
    deadlines.staleAt,
  );
  const compact = affected.length > INVALIDATION_BATCH_SIZE;
  const invalidations: InvalidateResponse['invalidations'] = [];
  reclaimControlFenceCapacity(sql, absentIds, now);
  captureControlTags(input, plan);
  for (const target of plan.targets) {
    applyTarget(input, target, {
      deadlines,
      request,
      persistent: persistent.has(target.ref.tagId),
      entryIds: entryIdsFor(target, indices, affected, compact),
      events,
    });
    const history = replyHistory(sql, target.ref.tagId, deadlines);
    invalidations.push({
      invalidationId: target.invalidationId,
      tagId: target.ref.tagId,
      value: target.ref.value,
      staleAt: deadlines.staleAt,
      hardExpireAt: deadlines.hardExpireAt,
      meaning: deadlines.meaning,
      ...(history !== undefined && { history }),
    });
  }
  condemnCurrent(
    input,
    plan.targets.map((target) => target.ref.tagId),
    immediate,
    deadlines,
  );
  if (compact) {
    const invalidationIds = persistentTargets.map((target) => target.invalidationId);
    for (let offset = 0; offset < affected.length; offset += INVALIDATION_BATCH_SIZE) {
      events.push({
        entityType: 'scope',
        entityId: `${scopeId}:invalidation:${revision}:${offset}`,
        kind: 'entries.invalidated',
        payload: {
          invalidationIds,
          invalidation: { revision, ...deadlines, recordedAt: now },
          entries: affected.slice(offset, offset + INVALIDATION_BATCH_SIZE).map((entry) => {
            return {
              entryId: entry.entry_id,
              tagMasks: [entry.mask0, entry.mask1, entry.mask2, entry.mask3],
            };
          }),
        },
      });
    }
  }
  record(input, events);
  return { revision, invalidations, affectedEntryIds: affected.map((entry) => entry.entry_id) };
}
