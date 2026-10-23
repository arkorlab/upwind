import type { ScopeLimits } from '../env.ts';
import type { Logger } from '../logger.ts';
import { expireLeases } from './attempts.ts';
import { tryListDataUploads } from './data-uploads.ts';
import type { BlobStore } from './io.ts';
import { RETENTION_INTERVAL_MS } from './mutation-pipeline.ts';
import type { ScopeQueue } from './mutations.ts';
import { collectRepairGarbage, readRepairJob } from './repair-jobs.ts';
import { REPAIR_CONTINUE_MS, type RepairRunner } from './repair-runner.ts';
import {
  eraseScopeStorage,
  letGoOfRetired,
  retentionDue,
  runRetention,
  type TickOptions,
} from './retention-run.ts';
import type { ScopeContext } from './scope-context.ts';
import type { SettleDeps } from './settle.ts';
import { readRevision } from './state.ts';

interface TickHost {
  readonly scope: ScopeContext;
  readonly storage: DurableObjectStorage;
  readonly queue: ScopeQueue;
  readonly repairs: RepairRunner;
  readonly deps: () => SettleDeps;
  readonly limits: () => ScopeLimits;
  readonly blobs: () => BlobStore;
  readonly log: Logger;
  readonly arm: (at: number) => Promise<void>;
  readonly rearm: (now: number) => Promise<void>;
  readonly settleOwes: () => Promise<boolean>;
  readonly settling: () => Promise<void>;
}

/** Housekeeping never expires leases, prunes or erases state while an accepted repair owns it. */
export async function tickScope(host: TickHost, now: number, options: TickOptions): Promise<void> {
  if (!host.scope.tables) {
    return;
  }
  if (await host.repairs.advance(now)) return;
  const garbageMore = host.storage.transactionSync(() =>
    collectRepairGarbage(host.storage.sql, now),
  );
  if (garbageMore) await host.arm(Date.now() + REPAIR_CONTINUE_MS);
  const scanDue = retentionDue(
    host.storage.sql,
    now,
    options.retention === true,
    RETENTION_INTERVAL_MS,
  );
  const page = scanDue ? await tryListDataUploads(host.deps()) : undefined;
  const deleteAll = await host.queue.run(async () => {
    if (readRepairJob(host.storage.sql) !== undefined) return false;
    host.storage.transactionSync(() => {
      expireLeases({
        sql: host.storage.sql,
        scopeId: host.scope.scopeId,
        limits: host.limits(),
        now,
        revision: readRevision(host.storage.sql) + 1,
        history: host.deps().history,
      });
    });
    const run = { ...host.deps(), limits: host.limits() };
    const due = retentionDue(
      host.storage.sql,
      now,
      options.retention === true,
      RETENTION_INTERVAL_MS,
    );
    return due && runRetention(run, now, page);
  });
  // Erasing waits for the whole run, and for one that left nothing owed: nothing of it may write
  // to storage after `deleteAll`, and what it could not deliver or write — whatever the host's
  // history owes — would go with the storage. A run that owes anything has armed its retry, and
  // the next retention looks again.
  const job = readRepairJob(host.storage.sql);
  if (job !== undefined) {
    await host.arm(Math.max(Date.now() + REPAIR_CONTINUE_MS, job.retryAt ?? 0));
    return;
  }
  const owed = await host.settleOwes();
  const { scopeId } = host.scope;
  // Everything of the scope left in storage once its history is over — whatever the host's
  // history wrote under the scope's prefix, and any blob a failed write left behind — erased
  // first: its tables are about to go, and after that nothing could name them.
  if (
    deleteAll &&
    !owed &&
    (await eraseScopeStorage(scopeId, host.blobs(), host.log, host.scope.repairNamespace))
  ) {
    // Under the lock, so that no change is planned against tables that go meanwhile; the tables
    // are given up first, so that no settle run begins against them, and those under way end.
    await host.queue.run(async () => {
      host.scope.tables = false;
      try {
        await Promise.allSettled([host.settling()]);
        await host.storage.deleteAlarm();
        await host.storage.deleteAll();
        host.scope.erased();
      } catch (error) {
        host.scope.tables = true;
        throw error;
      }
    });
    return;
  }
  // What the settle withdrew of the values a run retired goes now (`letGoOfRetired`).
  await letGoOfRetired(host.deps(), host.queue);
  await host.rearm(now);
}
