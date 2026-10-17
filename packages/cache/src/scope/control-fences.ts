import { tagDeltaEntrySchema, type TagDeltaEntry } from '@stayingupwind/host/cache';
import { toZod } from '@stayingupwind/host/zod';
import { z } from 'zod';

import type { InvalidationRow } from './rows.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';

/** A private absent tag needs an admission fence, not a permanent invalidation row of its own. */
export const CONTROL_FENCE_LIFETIME_MS = 3_600_000;
export const CONTROL_FENCE_LIMIT = 4096;
const FENCE_PREFIX = 'control_tag_fence:';
const EXPIRY_PREFIX = 'control_tag_fence_expiry:';
const PROJECTION_PREFIX = 'control_tag_projection:';
const COUNT = 'control_tag_fence_count';
const FLOOR = 'control_tag_fence_floor';
const SWEEP_CLOCK = 'control_tag_fence_sweep_clock';
const SWEEP_BATCH = 200;
const CLOCK_DIGITS = 16;

const fenceSchema = z.object({
  tag: toZod(tagDeltaEntrySchema),
  invalidationId: z.string(),
  cause: z.string(),
  recordedAt: z.number(),
  expiresAt: z.number(),
});
type Fence = z.infer<typeof fenceSchema>;
const floorSchema = z.object({ revision: z.number(), timestamp: z.number() });

function expiryKey(fence: Fence): string {
  return `${EXPIRY_PREFIX}${String(fence.expiresAt).padStart(CLOCK_DIGITS, '0')}:${fence.tag.tagId}`;
}

function readFence(sql: SqlStorage, tagId: string): Fence | undefined {
  const value = readMeta(sql, FENCE_PREFIX + tagId);
  return value === undefined ? undefined : fenceSchema.parse(JSON.parse(value));
}

export function controlFenceTag(sql: SqlStorage, tagId: string): TagDeltaEntry | undefined {
  return readFence(sql, tagId)?.tag;
}

function fenceCount(sql: SqlStorage): number {
  const count = readMeta(sql, COUNT);
  return count === undefined ? 0 : Number(count);
}

function forgetFence(sql: SqlStorage, fence: Fence): void {
  const floor = readControlFenceFloor(sql);
  writeMeta(
    sql,
    FLOOR,
    JSON.stringify({
      revision: Math.max(floor.revision, fence.tag.revision),
      timestamp: Math.max(floor.timestamp, fence.tag.staleAt),
    }),
  );
  deleteMeta(sql, FENCE_PREFIX + fence.tag.tagId);
  deleteMeta(sql, expiryKey(fence));
  writeMeta(sql, COUNT, String(fenceCount(sql) - 1));
}

/** Only projected fences can be reclaimed; pending KV obligations have an independent hard cap. */
function projectedFencePage(
  sql: SqlStorage,
  before: string,
  limit: number,
  excluded: readonly string[] = [],
): Fence[] {
  const rows = sql
    .exec<{ value: string }>(
      `SELECT f.value FROM meta e JOIN meta f ON f.key = ? || e.value
       WHERE e.key >= ? AND e.key < ?
         AND NOT EXISTS (SELECT 1 FROM meta p WHERE p.key = ? || e.value)
         AND e.value NOT IN (SELECT value FROM json_each(?))
       ORDER BY e.key LIMIT ?`,
      FENCE_PREFIX,
      EXPIRY_PREFIX,
      before,
      PROJECTION_PREFIX,
      JSON.stringify(excluded),
      limit,
    )
    .toArray();
  return rows.map((row) => fenceSchema.parse(JSON.parse(row.value)));
}

function expiredBoundary(now: number): string {
  return `${EXPIRY_PREFIX}${String(now).padStart(CLOCK_DIGITS, '0')};`;
}

function requiredCapacity(sql: SqlStorage, tagIds: readonly string[]): number {
  const added = new Set(
    tagIds.filter((tagId) => readMeta(sql, FENCE_PREFIX + tagId) === undefined),
  );
  return Math.max(0, fenceCount(sql) + added.size - CONTROL_FENCE_LIMIT);
}

/** A capacity refusal is decided before any counter, floor or current mutation is written. */
export function controlFencesFit(sql: SqlStorage, tagIds: readonly string[], now: number): boolean {
  const needed = requiredCapacity(sql, tagIds);
  return (
    needed === 0 || projectedFencePage(sql, expiredBoundary(now), needed, tagIds).length === needed
  );
}

/** Only expired, projected tags outside this request can make room for its distinct new fences. */
export function reclaimControlFenceCapacity(
  sql: SqlStorage,
  tagIds: readonly string[],
  now: number,
): void {
  const needed = requiredCapacity(sql, tagIds);
  if (needed === 0) return;
  const page = projectedFencePage(sql, expiredBoundary(now), needed, tagIds);
  for (const fence of page) forgetFence(sql, fence);
}

function earliest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  return right === null ? left : Math.min(left, right);
}

/** Repeated absent tags coalesce conservatively; a later writer must cross the newest mark. */
export function queueControlFence(sql: SqlStorage, tag: TagDeltaEntry, row: InvalidationRow): void {
  const previous = readFence(sql, tag.tagId);
  if (previous === undefined && fenceCount(sql) >= CONTROL_FENCE_LIMIT) {
    throw new Error('control fence capacity was not reserved');
  }
  if (previous !== undefined) deleteMeta(sql, expiryKey(previous));
  const fence: Fence = {
    tag: {
      ...tag,
      staleAt: Math.max(previous?.tag.staleAt ?? tag.staleAt, tag.staleAt),
      hardExpireAt: earliest(previous?.tag.hardExpireAt ?? null, tag.hardExpireAt),
      meaning: previous?.tag.meaning === 'immediate' ? 'immediate' : tag.meaning,
    },
    invalidationId: row.invalidation_id,
    cause: row.cause,
    recordedAt: row.recorded_at,
    expiresAt: row.recorded_at + CONTROL_FENCE_LIFETIME_MS,
  };
  writeMeta(sql, FENCE_PREFIX + tag.tagId, JSON.stringify(fence));
  writeMeta(sql, expiryKey(fence), tag.tagId);
  if (previous === undefined) writeMeta(sql, COUNT, String(fenceCount(sql) + 1));
}

/** Fixed-size evidence survives collection, including an old live lease renewed indefinitely. */
export function readControlFenceFloor(sql: SqlStorage): z.infer<typeof floorSchema> {
  const value = readMeta(sql, FLOOR);
  return value === undefined ? { revision: 0, timestamp: 0 } : floorSchema.parse(JSON.parse(value));
}

/** Prefix/expiry indexes bound each retention pass; the hard cap bounds even a busy hour. */
export function expireControlFences(sql: SqlStorage, now?: number): void {
  const clock = Math.max(now ?? 0, Number(readMeta(sql, SWEEP_CLOCK) ?? '0'));
  if (now !== undefined) writeMeta(sql, SWEEP_CLOCK, String(clock));
  const page = projectedFencePage(sql, expiredBoundary(clock), SWEEP_BATCH);
  for (const fence of page) forgetFence(sql, fence);
}

export function controlFenceSweepPending(sql: SqlStorage): boolean {
  const clock = Number(readMeta(sql, SWEEP_CLOCK) ?? '0');
  return projectedFencePage(sql, expiredBoundary(clock), 1).length > 0;
}

function rowOf(fence: Fence): InvalidationRow {
  return {
    invalidation_id: fence.invalidationId,
    revision: fence.tag.revision,
    target_kind: 'tag',
    target_id: fence.tag.tagId,
    target_value: fence.tag.value,
    stale_at: fence.tag.staleAt,
    hard_expire_at: fence.tag.hardExpireAt,
    meaning: fence.tag.meaning,
    expire_seconds: null,
    cause: fence.cause,
    recorded_at: fence.recordedAt,
  };
}

interface AdmissionQuery {
  readonly tagIds: readonly string[];
  readonly afterRevision?: number;
  readonly timestamp?: number;
}

function matches(tag: TagDeltaEntry, query: AdmissionQuery): boolean {
  return (
    (query.afterRevision === undefined || tag.revision > query.afterRevision) &&
    (query.timestamp === undefined || tag.staleAt >= query.timestamp)
  );
}

/** Admission only: collection never condemns an existing generation or rewrites its delivery. */
export function controlFenceInvalidations(
  sql: SqlStorage,
  query: AdmissionQuery,
): InvalidationRow[] {
  const rows: InvalidationRow[] = [];
  for (const tagId of query.tagIds) {
    const fence = readFence(sql, tagId);
    if (fence !== undefined && matches(fence.tag, query)) rows.push(rowOf(fence));
  }
  return [...rows, ...controlFenceFloorInvalidations(sql, query)];
}

export function controlFenceFloorInvalidations(
  sql: SqlStorage,
  query: AdmissionQuery,
): InvalidationRow[] {
  const floor = readControlFenceFloor(sql);
  const tagId = query.tagIds[0];
  if (
    tagId !== undefined &&
    floor.revision > 0 &&
    (query.afterRevision === undefined || query.afterRevision < floor.revision) &&
    (query.timestamp === undefined || query.timestamp <= floor.timestamp)
  ) {
    return [
      {
        invalidation_id: 'inv_control_fence_floor',
        revision: floor.revision,
        target_kind: 'tag',
        target_id: tagId,
        target_value: null,
        stale_at: floor.timestamp,
        hard_expire_at: floor.timestamp,
        meaning: 'immediate',
        expire_seconds: null,
        cause: JSON.stringify({ source: 'control' }),
        recorded_at: floor.timestamp,
      },
    ];
  }
  return [];
}
