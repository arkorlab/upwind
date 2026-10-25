import type { ScopeLimits } from '../env.ts';
import { expireLeases } from '../scope/attempts.ts';
import { listDataUploads } from '../scope/data-uploads.ts';
import { RETENTION_INTERVAL_MS, type MutationPipeline } from '../scope/mutation-pipeline.ts';
import type { ScopeQueue } from '../scope/mutations.ts';
import { collectRepairGarbage, readRepairJob } from '../scope/repair-jobs.ts';
import type { RepairRunner } from '../scope/repair-runner.ts';
import { letGoOfRetired, retentionDue, runRetention } from '../scope/retention-run.ts';
import type { SettleDeps } from '../scope/settle.ts';

interface NativeMaintenance extends SettleDeps {
  readonly storage: DurableObjectStorage;
  readonly queue: ScopeQueue;
  readonly repairs: RepairRunner;
  readonly pipeline: MutationPipeline;
  readonly limits: ScopeLimits;
  readonly settle: () => Promise<void>;
  readonly arm: (at: number) => Promise<void>;
}

/** Bounded shared maintenance passes; an active repair always keeps its next tick. */
export async function maintainNativeCache(host: NativeMaintenance): Promise<void> {
  await host.storage.deleteAlarm();
  const now = Date.now();
  if (await host.repairs.advance(now)) return;
  const garbageMore = host.transaction(() => collectRepairGarbage(host.sql, now));
  if (garbageMore) await host.arm(Date.now() + 1);
  await host.queue.run(() => {
    if (readRepairJob(host.sql) !== undefined) return;
    host.transaction(() => expireLeases(host.pipeline.input(now)));
  });
  if (readRepairJob(host.sql) !== undefined) {
    await host.pipeline.rearm(now);
    return;
  }
  await host.settle();
  if (retentionDue(host.sql, now, false, RETENTION_INTERVAL_MS)) {
    const page = await listDataUploads(host);
    await host.queue.run(() => {
      // A repair can begin while the listing is in flight. A later tick must advance it,
      // so this tick must leave rather than wait on the publication barrier.
      if (readRepairJob(host.sql) !== undefined) return;
      return runRetention(host, now, page);
    });
    if (readRepairJob(host.sql) !== undefined) {
      await host.pipeline.rearm(now);
      return;
    }
    await host.settle();
    await letGoOfRetired(host, host.queue);
  }
  await host.pipeline.rearm(Date.now());
}
