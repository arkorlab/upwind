import { r2CachePrefix } from '@stayingupwind/core/cache';

import type { ScopeLimits } from '../env.ts';
import { detailOf, type Logger } from '../logger.ts';
import { controlFenceSweepPending } from './control-fences.ts';
import { dataUploadScanPending, type DataUploadPage, queueDataUploads } from './data-uploads.ts';
import type { ScopeHistory } from './history.ts';
import type { BlobStore } from './io.ts';
import { applyRetention, forgetDeletions, scopeErasable } from './retention.ts';
import { deleteMeta, readMeta, writeMeta } from './state.ts';

export interface TickOptions {
  /** Run retention now rather than when its hour is up. */
  readonly retention?: boolean;
}

/** When the scope's retention last ran, by the clock it was handed. */
const META_LAST_RETENTION = 'last_retention_at';
/** Set by a run that let go of a full batch and found no failure: more is left (`more`). */
const META_RETENTION_BACKLOG = 'retention_backlog';
/** How soon a run comes back for what one before it left. */
const SOON_MS = 1000;

/** Whether a run left more than it lets go of at once: a listing under way, or a full batch. */
function moreLeft(sql: SqlStorage): boolean {
  return dataUploadScanPending(sql) || readMeta(sql, META_RETENTION_BACKLOG) !== undefined;
}

export function retentionDue(
  sql: SqlStorage,
  now: number,
  forced: boolean,
  interval: number,
): boolean {
  return (
    forced ||
    moreLeft(sql) ||
    controlFenceSweepPending(sql) ||
    now - Number(readMeta(sql, META_LAST_RETENTION) ?? '0') >= interval
  );
}

/**
 * When retention runs next: once its interval is up, or within a second where a run left more than
 * it lets go of at once. A retired scope with tens of thousands of bodies, or a busy one whose
 * former generations come faster than a batch an interval, would otherwise wait days for them.
 */
export function nextRetentionAt(sql: SqlStorage, now: number, interval: number): number {
  const due = Math.max(now, Number(readMeta(sql, META_LAST_RETENTION) ?? '0') + interval);
  return moreLeft(sql) ? Math.min(due, now + SOON_MS) : due;
}

export interface RetentionRun {
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly limits: ScopeLimits;
  readonly blobs: BlobStore;
  readonly history: ScopeHistory;
  readonly log: Logger;
  readonly transaction: <T>(body: () => T) => T;
}

/**
 * One run of retention: the data uploads a listing found are queued, what retention lets go of is
 * written down and its blobs deleted, and what was deleted is forgotten. Whether the scope's
 * storage may now be erased whole — never while blobs it wrote down are left to delete.
 */
export async function runRetention(
  run: RetentionRun,
  now: number,
  page: DataUploadPage | undefined,
): Promise<boolean> {
  const plan = run.transaction(() => {
    if (page !== undefined) {
      queueDataUploads({ sql: run.sql, scopeId: run.scopeId, now, page });
    }
    const result = applyRetention({ sql: run.sql, limits: run.limits, now, history: run.history });
    writeMeta(run.sql, META_LAST_RETENTION, String(now));
    // Set again only once this run's deletes are confirmed: a storage that refuses them is not
    // asked again every second.
    deleteMeta(run.sql, META_RETENTION_BACKLOG);
    return result;
  });
  try {
    await run.blobs.delete(plan.deletable);
  } catch (error) {
    // The keys stay written down, so the next tick asks for them again rather than losing them
    // with the rows that named them.
    run.log.warn('pruned blobs not deleted', {
      count: plan.deletable.length,
      detail: detailOf(error),
    });
    return false;
  }
  // Asked again once the deletes are forgotten: where they were the last of the scope's bytes, this
  // run erases it, rather than the run an interval later.
  return run.transaction(() => {
    forgetDeletions(run.sql, plan.deletable);
    if (plan.more) writeMeta(run.sql, META_RETENTION_BACKLOG, '1');
    return scopeErasable({ sql: run.sql, limits: run.limits, now });
  });
}

/** Remove all scope blobs only once no unsettled records or retention obligations remain. */
export async function eraseScopeStorage(
  scopeId: string,
  blobs: BlobStore,
  log: Logger,
): Promise<boolean> {
  try {
    await blobs.deletePrefix(r2CachePrefix(scopeId));
    return true;
  } catch (error) {
    log.warn('scope storage not erased', { detail: detailOf(error) });
    return false;
  }
}
