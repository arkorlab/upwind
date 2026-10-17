import {
  evaluateFreshness,
  NEXT_ONE_YEAR_SECONDS,
  routeEntryKindSchema,
  tagIdFor,
} from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import {
  type ApplyResourceChangeInput,
  type ApplyResourceChangeResult,
  type FinishResourceWarmJobInput,
  type FinishResourceWarmJobResult,
  type ListResourceWarmJobsInput,
  type ListResourceWarmJobsResult,
  type ResourceWarmJob,
} from '@stayingupwind/host/cache';

import { entryStateEvent } from './attempts.ts';
import { planInvalidate } from './invalidations.ts';
import {
  type EntryRow,
  type GenerationRow,
  generationHeaders,
  type TagRow,
  toGeneration,
} from './rows.ts';
import { isRefusal, readScope, type Refusal, refuse, requireActiveScope } from './state.ts';
import { findTag } from './tags.ts';
import { type Apply, record, type TxInput } from './tx.ts';

/**
 * Resource invalidations and their background work commit together. A dispatch job is independent
 * of entry.regeneration: a render that began before this change can publish a condemned generation
 * and become idle, but it has not satisfied the resource's required tag revision.
 */

const DISPATCH_LEASE_MS = 60_000;
const MAX_RETRY_MS = 300_000;
const MIN_RETRY_MS = 1000;
const MILLISECONDS_PER_SECOND = 1000;
const HTTP_OK = 200;
const MAX_RETRY_EXPONENT = 9;
const PRIVATE_CACHE_CONTROL = /\b(?:private|no-store)\b/iu;
/**
 * How many warm jobs one statement queues. A change may reach every entry its scope holds, and its
 * jobs are queued in its own transaction, beside its invalidation: a page a statement, as that
 * invalidation's history is written, rather than a statement for each route.
 */
const WARM_JOB_PAGE = 500;

interface ResourceHeadRow extends Record<string, SqlStorageValue> {
  resource_id: string;
  event_id: string;
  version: number;
  tag: string;
  tag_revision: number;
  applied_at: number;
}

interface WarmJobRow extends Record<string, SqlStorageValue> {
  job_id: string;
  resource_id: string;
  entry_id: string;
  event_id: string;
  version: number;
  required_revision: number;
  status: string;
  attempt_count: number;
  retry_at: number;
  lease_token: string | null;
  lease_expires_at: number | null;
  detail: string | null;
  updated_at: number;
}

function headOf(sql: SqlStorage, resourceId: string): ResourceHeadRow | undefined {
  return sql
    .exec<ResourceHeadRow>(`SELECT * FROM resource_heads WHERE resource_id = ?`, resourceId)
    .toArray()[0];
}

/**
 * Whether the scope may keep a head for one resource more. A head is kept for good, to order its
 * resource's changes, and a host may name resources without end: the scope keeps as many as it may
 * keep tags, each resource's changes moving a tag of its own.
 */
function resourceHeadsFit(sql: SqlStorage, limit: number): boolean {
  return (
    sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM resource_heads`).one().count < limit
  );
}

function pendingCount(sql: SqlStorage, resourceId: string): number {
  return sql
    .exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM resource_warm_jobs
       WHERE resource_id = ? AND status <> 'skipped'`,
      resourceId,
    )
    .one().count;
}

/**
 * No browser identity is invented for a route that is not in the trusted bundle's allowlist. Each
 * entry is judged by its current generation's headers, read beside it in the one query, rather
 * than by another read of that generation for each.
 */
function eligibleEntries(
  sql: SqlStorage,
  affectedEntryIds: readonly string[],
  allowedRoutes: readonly string[],
): string[] {
  if (allowedRoutes.length === 0 || affectedEntryIds.length === 0) return [];
  const entries = sql
    .exec<Pick<GenerationRow, 'entry_id' | 'headers'>>(
      `SELECT e.entry_id, g.headers FROM entries e
       JOIN generations g ON g.generation_id = e.current_generation_id
       WHERE e.entry_id IN (SELECT value FROM json_each(?))
         AND e.route IN (SELECT value FROM json_each(?))
         AND e.kind IN ('app-page', 'pages', 'app-route')
         AND e.pathname IS NOT NULL AND (e.pathname <> e.route OR instr(e.route, '[') = 0)
         AND g.status = 200 AND g.storage = 'present'`,
      JSON.stringify(affectedEntryIds),
      JSON.stringify(allowedRoutes),
    )
    .toArray();
  return entries
    .filter((entry) => {
      return Object.entries(generationHeaders(entry)).every(([name, value]) => {
        const normalized = name.toLowerCase();
        return (
          normalized !== 'set-cookie' &&
          (normalized !== 'cache-control' || !PRIVATE_CACHE_CONTROL.test(value))
        );
      });
    })
    .map((entry) => entry.entry_id);
}

/**
 * The tag a newer change of a resource takes the place of, where it names another: the entries
 * still tagged with it show the resource as it was, and are condemned and warmed with those of the
 * tag the change names.
 */
function replacedTags(
  head: ResourceHeadRow | undefined,
  request: ApplyResourceChangeInput,
): string[] {
  return head !== undefined && head.version < request.version && head.tag !== request.tag
    ? [head.tag]
    : [];
}

export async function planApplyResourceChange(
  input: TxInput,
  request: ApplyResourceChangeInput,
): Promise<Apply<ApplyResourceChangeResult | Refusal>> {
  // Read here, under the lock every head is written under, the head is the one the transaction
  // that follows finds.
  const head = headOf(input.sql, request.resourceId);
  const tags = [request.tag, ...replacedTags(head, request)];
  const [invalidate, tagId] = await Promise.all([
    planInvalidate(input, {
      tags: tags.map((value) => ({ kind: 'next-explicit' as const, value })),
      expire: NEXT_ONE_YEAR_SECONDS,
      cause: { source: 'platform', api: 'resourceChange', requestId: request.eventId },
    }),
    // What a reconciliation takes up is the change the head keeps (`reconcile`): the tag that
    // change named, whatever tag the delivery names.
    tagIdFor(input.scopeId, 'next-explicit', head?.tag ?? request.tag),
  ]);
  return () => {
    const { sql, now } = input;
    const scope = requireActiveScope(sql);
    if (isRefusal(scope)) return scope;
    const previous = headOf(sql, request.resourceId);
    if (previous !== undefined && previous.version >= request.version) {
      if (previous.version === request.version && request.reconcile === true) {
        return reconcile(input, request, previous, tagId);
      }
      return {
        kind: 'already-applied',
        revision: previous.tag_revision,
        affectedEntryIds: [],
        queuedJobs: pendingCount(sql, request.resourceId),
      };
    }
    // Before anything is written: a refusal leaves the transaction committed.
    if (previous === undefined && !resourceHeadsFit(sql, input.limits.tagsPerScope)) {
      return refuse('quota_exceeded', 'the scope keeps as many resources as it may');
    }
    const result = invalidate();
    if (isRefusal(result)) return result;
    sql.exec(
      `INSERT INTO resource_heads (resource_id, event_id, version, tag, tag_revision, applied_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (resource_id) DO UPDATE SET
         event_id = excluded.event_id, version = excluded.version, tag = excluded.tag,
         tag_revision = excluded.tag_revision, applied_at = excluded.applied_at`,
      request.resourceId,
      request.eventId,
      request.version,
      request.tag,
      result.revision,
      now,
    );
    const queuedJobs = queueEligible(input, request, {
      requiredRevision: result.revision,
      affectedEntryIds: result.affectedEntryIds,
    });
    // A newer change also withdraws a prior dispatch permission if the route ceased to qualify.
    sql.exec(
      `DELETE FROM resource_warm_jobs WHERE resource_id = ? AND version < ?`,
      request.resourceId,
      request.version,
    );
    return {
      kind: 'applied',
      revision: result.revision,
      affectedEntryIds: result.affectedEntryIds,
      queuedJobs,
    };
  };
}

function queueEligible(
  input: TxInput,
  request: ApplyResourceChangeInput,
  queue: {
    readonly requiredRevision: number;
    readonly affectedEntryIds: readonly string[];
    readonly onlyNew?: boolean;
  },
): number {
  const { sql, now } = input;
  const eligible = eligibleEntries(sql, queue.affectedEntryIds, request.allowedRoutes ?? []);
  const queued = queue.onlyNew === true ? notYetQueued(sql, request, eligible) : eligible;
  for (let offset = 0; offset < queued.length; offset += WARM_JOB_PAGE) {
    const page = queued
      .slice(offset, offset + WARM_JOB_PAGE)
      .map((entryId) => [createId('rwj'), entryId]);
    sql.exec(
      `INSERT INTO resource_warm_jobs (job_id, resource_id, entry_id, event_id, version,
         required_revision, status, attempt_count, retry_at, lease_token, lease_expires_at,
         detail, updated_at)
       SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), ?, ?, ?, 'pending', 0,
         ?, NULL, NULL, NULL, ?
       FROM json_each(?) WHERE true
       ON CONFLICT (resource_id, entry_id) DO UPDATE SET
         event_id = excluded.event_id, version = excluded.version,
         required_revision = excluded.required_revision, status = 'pending', attempt_count = 0,
         retry_at = excluded.retry_at, lease_token = NULL, lease_expires_at = NULL,
         detail = NULL, updated_at = excluded.updated_at`,
      request.resourceId,
      request.eventId,
      request.version,
      queue.requiredRevision,
      now,
      now,
      JSON.stringify(page),
    );
  }
  return queued.length;
}

/** The entries a job of this change, or of a later one, does not already cover. */
function notYetQueued(
  sql: SqlStorage,
  request: ApplyResourceChangeInput,
  entryIds: readonly string[],
): string[] {
  const rows = sql.exec<{ entry_id: string }>(
    `SELECT entry_id FROM resource_warm_jobs WHERE resource_id = ? AND version >= ?`,
    request.resourceId,
    request.version,
  );
  const covered = new Set<string>();
  for (const row of rows) {
    covered.add(row.entry_id);
  }
  return entryIds.filter((entryId) => !covered.has(entryId));
}

/**
 * Every tag the head's change invalidated: the one it named (`tagId`), and those recorded at the
 * revision the change committed at, which no other change commits at. Those are the tag it names
 * and any it took the place of (`replacedTags`), whose entries seeded since show the resource as it
 * was too. Retention folds none of the invalidations at a head's revision (`invalidation-fold.ts`):
 * they are here however long ago the change was.
 */
function headTagIds(sql: SqlStorage, head: ResourceHeadRow, tagId: string): string[] {
  const tagIds = [tagId];
  const recorded = sql.exec<{ target_id: string }>(
    `SELECT target_id FROM invalidations WHERE revision = ? AND target_kind = 'tag'`,
    head.tag_revision,
  );
  for (const row of recorded) {
    if (!tagIds.includes(row.target_id)) tagIds.push(row.target_id);
  }
  return tagIds;
}

/** The tag's entries whose current generation is older than the head's change, or seeded since. */
function outdatedUnder(sql: SqlStorage, tagId: string, tagRevision: number): GenerationRow[] {
  return sql
    .exec<GenerationRow>(
      `SELECT g.* FROM entry_tags et JOIN entries e ON e.entry_id = et.entry_id
       JOIN generations g ON g.generation_id = e.current_generation_id
       WHERE et.tag_id = ? AND (g.dependency_revision < ?
         OR (g.source = 'build' AND g.published_revision > ?))`,
      tagId,
      tagRevision,
      tagRevision,
    )
    .toArray();
}

/** Condemn, as the tag stands, the outdated generations the head's change has not condemned. */
function condemnOutdated(
  input: TxInput,
  under: {
    readonly tag: TagRow | undefined;
    readonly outdated: readonly GenerationRow[];
    readonly tagRevision: number;
  },
  affected: Set<string>,
): void {
  const { sql, now, revision } = input;
  const { tag, outdated, tagRevision } = under;
  if (tag?.stale_at === null || tag?.stale_at === undefined) return;
  for (const generation of outdated) {
    const condemnedRevision =
      generation.condemned === null
        ? 0
        : (toGeneration(input.scopeId, generation).condemned?.revision ?? 0);
    if (condemnedRevision >= tagRevision) continue;
    sql.exec(
      `UPDATE generations SET condemned = json_object(
         'revision', MAX(COALESCE(json_extract(condemned, '$.revision'), 0), ?),
         'staleAt', MIN(COALESCE(json_extract(condemned, '$.staleAt'), ?), ?),
         'hardExpireAt', MIN(COALESCE(json_extract(condemned, '$.hardExpireAt'), ?), ?)
       ) WHERE generation_id = ?`,
      tag.revision,
      tag.stale_at,
      tag.stale_at,
      tag.hard_expire_at,
      tag.hard_expire_at,
      generation.generation_id,
    );
    sql.exec(
      `UPDATE entries SET revision = ?, record_revision = ?,
       regeneration = CASE regeneration WHEN 'idle' THEN 'queued' ELSE regeneration END,
       updated_at = ? WHERE entry_id = ?`,
      revision,
      revision,
      now,
      generation.entry_id,
    );
    affected.add(generation.entry_id);
  }
}

/**
 * Seeding may have committed after the first delivery of this event to an already-active scope,
 * under any tag the head's change invalidated. Each tag's outdated entries are read after those of
 * the tags before it were condemned, so an entry under two is condemned and counted once. A
 * delivery of the head's version that names another tag is reconciled as the head's change all the
 * same, and takes up nothing of the tag it names, which that change did not invalidate.
 */
function reconcile(
  input: TxInput,
  request: ApplyResourceChangeInput,
  head: ResourceHeadRow,
  tagId: string,
): ApplyResourceChangeResult {
  const { sql } = input;
  const affected = new Set<string>();
  const outdatedEntryIds = new Set<string>();
  for (const id of headTagIds(sql, head, tagId)) {
    const outdated = outdatedUnder(sql, id, head.tag_revision);
    for (const generation of outdated) outdatedEntryIds.add(generation.entry_id);
    condemnOutdated(
      input,
      { tag: findTag(sql, id), outdated, tagRevision: head.tag_revision },
      affected,
    );
  }
  const affectedEntryIds = [...affected];
  if (affectedEntryIds.length > 0) {
    record(
      input,
      affectedEntryIds.map((entryId) => entryStateEvent(sql, entryId)),
    );
  }
  const queuedJobs = queueEligible(input, request, {
    requiredRevision: head.tag_revision,
    affectedEntryIds: [...outdatedEntryIds],
    onlyNew: true,
  });
  return { kind: 'already-applied', revision: head.tag_revision, affectedEntryIds, queuedJobs };
}

function currentGeneration(sql: SqlStorage, entryId: string): GenerationRow | undefined {
  return sql
    .exec<GenerationRow>(
      `SELECT g.* FROM entries e JOIN generations g ON g.generation_id = e.current_generation_id
       WHERE e.entry_id = ?`,
      entryId,
    )
    .toArray()[0];
}

/** A lost ACK is harmless; only the authority's fresh, fully published generation satisfies work. */
function satisfied(sql: SqlStorage, scopeId: string, job: WarmJobRow, now: number): boolean {
  const row = currentGeneration(sql, job.entry_id);
  if (
    row?.status !== HTTP_OK ||
    row.publication !== 'published' ||
    row.storage !== 'present' ||
    row.condemned !== null ||
    row.dependency_revision < job.required_revision
  ) {
    return false;
  }
  const generation = toGeneration(scopeId, row);
  return (
    evaluateFreshness({
      policy: generation.policy,
      cacheTimestamp: generation.cacheTimestamp,
      invalidation: generation.condemned ?? undefined,
      now,
    }).validity === 'fresh'
  );
}

function nextRetryAt(sql: SqlStorage): number | null {
  return sql
    .exec<{ at: number | null }>(
      `SELECT MIN(CASE status WHEN 'leased' THEN lease_expires_at ELSE retry_at END) AS at
       FROM resource_warm_jobs WHERE status IN ('pending', 'leased')`,
    )
    .one().at;
}

/** Called inside the DO mutex and a synchronous transaction; claims never race each other. */
export function claimResourceWarmJobs(
  sql: SqlStorage,
  input: ListResourceWarmJobsInput,
  now: number,
): ListResourceWarmJobsResult {
  if (readScope(sql)?.status !== 'active') return { jobs: [], nextRetryAt: null };
  // Entry retention may remove an unpublishable member while nothing was claiming the jobs.
  sql.exec(`DELETE FROM resource_warm_jobs WHERE entry_id NOT IN (SELECT entry_id FROM entries)`);
  // Taken up in the order they came due: a pending job at its retry, and one whose dispatch lease
  // ran out with no answer once it ran out. By its first retry, a job whose answers keep being lost
  // would be taken up again ahead of every job that came due since, each time.
  const candidates = sql
    .exec<WarmJobRow>(
      `SELECT * FROM resource_warm_jobs
       WHERE (status = 'pending' AND retry_at <= ?)
          OR (status = 'leased' AND lease_expires_at <= ?)
       ORDER BY CASE status WHEN 'leased' THEN lease_expires_at ELSE retry_at END, job_id
       LIMIT ?`,
      now,
      now,
      input.limit ?? 2,
    )
    .toArray();
  const jobs: ResourceWarmJob[] = [];
  for (const job of candidates) {
    if (satisfied(sql, input.scopeId, job, now)) {
      sql.exec(`DELETE FROM resource_warm_jobs WHERE job_id = ?`, job.job_id);
      continue;
    }
    const entry = sql
      .exec<EntryRow>(`SELECT * FROM entries WHERE entry_id = ?`, job.entry_id)
      .one();
    const leaseToken = createId('rwl');
    const leaseExpiresAt = now + DISPATCH_LEASE_MS;
    sql.exec(
      `UPDATE resource_warm_jobs SET status = 'leased', attempt_count = attempt_count + 1,
       lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE job_id = ?`,
      leaseToken,
      leaseExpiresAt,
      now,
      job.job_id,
    );
    jobs.push({
      jobId: job.job_id,
      resourceId: job.resource_id,
      eventId: job.event_id,
      version: job.version,
      requiredRevision: job.required_revision,
      entryId: job.entry_id,
      entryKind: routeEntryKindSchema.parse(entry.kind),
      route: entry.route ?? '/',
      pathname: entry.pathname ?? '/',
      leaseToken,
      leaseExpiresAt,
    });
  }
  return { jobs, nextRetryAt: nextRetryAt(sql) };
}

/** An ACK from a replaced/expired dispatch lease cannot erase a newer resource change. */
export function finishResourceWarmJob(
  sql: SqlStorage,
  input: FinishResourceWarmJobInput,
  now: number,
): FinishResourceWarmJobResult {
  const job = sql
    .exec<WarmJobRow>(`SELECT * FROM resource_warm_jobs WHERE job_id = ?`, input.jobId)
    .toArray()[0];
  if (job === undefined) return { kind: 'unknown', nextRetryAt: nextRetryAt(sql) };
  if (
    job.status !== 'leased' ||
    job.lease_token !== input.leaseToken ||
    (job.lease_expires_at ?? 0) <= now
  ) {
    return { kind: 'superseded', nextRetryAt: nextRetryAt(sql) };
  }
  if (satisfied(sql, input.scopeId, job, now)) {
    sql.exec(`DELETE FROM resource_warm_jobs WHERE job_id = ?`, job.job_id);
    return { kind: 'completed', nextRetryAt: nextRetryAt(sql) };
  }
  if (input.outcome === 'skipped') {
    sql.exec(
      `UPDATE resource_warm_jobs SET status = 'skipped', lease_token = NULL,
       lease_expires_at = NULL, detail = ?, updated_at = ? WHERE job_id = ?`,
      input.detail ?? null,
      now,
      job.job_id,
    );
    return { kind: 'completed', nextRetryAt: nextRetryAt(sql) };
  }
  const backoffMs = Math.min(
    2 ** Math.min(job.attempt_count, MAX_RETRY_EXPONENT) * MILLISECONDS_PER_SECOND,
    MAX_RETRY_MS,
  );
  const retryAt =
    now + Math.max(MIN_RETRY_MS, Math.min(input.retryAfterMs ?? backoffMs, MAX_RETRY_MS));
  sql.exec(
    `UPDATE resource_warm_jobs SET status = 'pending', retry_at = ?, lease_token = NULL,
     lease_expires_at = NULL, detail = ?, updated_at = ? WHERE job_id = ?`,
    retryAt,
    input.detail ??
      (input.outcome === 'published' ? 'generation is not fresh at required revision' : null),
    now,
    job.job_id,
  );
  return { kind: 'retry', nextRetryAt: nextRetryAt(sql) };
}
