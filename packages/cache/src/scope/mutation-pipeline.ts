import { nextLeaseExpiry } from './attempts.ts';
import {
  commitMutation,
  type MutationResult,
  type ScopeMutationHost,
  type ScopeQueue,
} from './mutations.ts';
import {
  isRepairPending,
  isRepairStart,
  readRepairJob,
  nextRepairGarbageAt,
  type RepairPending,
  type RepairStart,
} from './repair-jobs.ts';
import { REPAIR_CONTINUE_MS, type RepairRunner } from './repair-runner.ts';
import { nextRetentionAt } from './retention-run.ts';
import { ownRecordsOf, type OwnRecords, type SettleDeps, type SettleRun } from './settle.ts';
import { readRevision, readScope } from './state.ts';
import type { Apply, TxInput } from './tx.ts';

export const LEASE_SWEEP_GRACE_MS = 1000;
export const RETENTION_INTERVAL_MS = 3_600_000;

export type OwnRun = Pick<OwnRecords, 'wanted' | 'carried'> &
  Pick<SettleDeps, 'timing'> & {
    readonly leaseClock?: true;
    readonly repairHeartbeat?: string;
  };

interface PipelineHost {
  readonly storage: DurableObjectStorage;
  readonly queue: ScopeQueue;
  readonly repairs: RepairRunner;
  readonly mutationHost: () => ScopeMutationHost;
  readonly committed: (tables: boolean) => void;
  readonly testHooks: () => boolean;
  readonly settling: () => Promise<void>;
  readonly settle: (own: OwnRecords | null, timing: SettleDeps['timing']) => SettleRun;
  readonly arm: (at: number) => Promise<void>;
  readonly armAnswered: (at: number, atOnce: boolean) => Promise<void>;
}

/** The write/settle pipeline may wait for a durable repair; serving reads do not use it. */
export class MutationPipeline {
  readonly #host: PipelineHost;

  constructor(host: PipelineHost) {
    this.#host = host;
  }

  input(now: number): TxInput {
    const host = this.#host.mutationHost();
    return {
      sql: host.storage.sql,
      scopeId: host.scopeId,
      buildId: host.buildId,
      packSchemaVersion: host.packSchemaVersion,
      repairNamespace: host.repairNamespace,
      limits: host.limits,
      now,
      revision: readRevision(host.storage.sql) + 1,
      history: host.history,
    };
  }

  async run<T>(
    now: number,
    plan: (
      input: TxInput,
    ) =>
      | Apply<T | RepairPending | RepairStart<T>>
      | Promise<Apply<T | RepairPending | RepairStart<T>>>,
    answers: { readonly atOnce?: boolean } & ({ readonly empty: T } | { readonly seed: T }),
    { wanted, timing, carried, leaseClock, repairHeartbeat }: OwnRun = {},
  ): Promise<T> {
    const clock = leaseClock === true && !this.#host.testHooks() ? Date.now : undefined;
    let result: MutationResult<T>;
    for (;;) {
      const attempted = await this.#host.queue.run(async () => {
        const job = this.#host.mutationHost().tables
          ? readRepairJob(this.#host.storage.sql)
          : undefined;
        // A healthy heartbeat cannot change generation outputs/canonical locations. Keep other
        // live render leases alive while writers wait; the accepted committing attempt is pinned.
        if (
          job !== undefined &&
          (repairHeartbeat === undefined || job.attemptId === repairHeartbeat)
        ) {
          return { blockedBy: job.id } as const;
        }
        let committed = await commitMutation(
          { ...this.#host.mutationHost(), ...(clock !== undefined && { clock }) },
          now,
          plan,
          answers,
        );
        this.#host.committed(committed.tables);
        if (isRepairStart<T>(committed.value)) {
          const deferred = committed.value;
          await this.prepare();
          await deferred.prepare?.();
          const input = this.input(clock?.() ?? now);
          const value = this.#host.storage.transactionSync(() => deferred.start(input));
          committed = {
            ...committed,
            value,
            own:
              readRevision(input.sql) >= input.revision
                ? ownRecordsOf(input.sql, input.revision)
                : null,
          };
        }
        // A bypassed healthy heartbeat owns no record. Avoid starting a history/tag settle
        // during the job; the already-armed continuation keeps maintenance scheduled.
        return job !== undefined && committed.own === null
          ? { ...committed, own: undefined }
          : committed;
      });
      if ('blockedBy' in attempted) {
        await this.#host.repairs.wait(attempted.blockedBy);
        continue;
      }
      if (isRepairPending(attempted.value)) {
        const completed = await this.#host.repairs.wait<T>(attempted.value.jobId);
        result = { ...completed, tables: true };
      } else {
        result = attempted as MutationResult<T>;
      }
      break;
    }
    timing?.lap('commit');
    if (result.own === undefined) return result.value;
    const own = result.own === null ? null : { ...result.own, wanted, carried };
    const run = this.#host.settle(own, timing);
    if (answers.atOnce === true) run.answerNow();
    await run.answered;
    timing?.lap('settle');
    // Armed before the answer, not after it: what the run still does once the change is answered —
    // what the host's history owes for it — is owed to this alarm, or to an earlier one, should the
    // object be reset before the run is over. Erasure may have come between: what is gone is not
    // asked for. An answer read from its own transaction is not taken back for it (`#armOrLog`).
    if (this.#host.mutationHost().tables && readScope(this.#host.storage.sql) !== undefined) {
      const at = now + RETENTION_INTERVAL_MS;
      await this.#host.armAnswered(at, answers.atOnce === true);
    }
    timing?.lap('alarm');
    return result.value;
  }

  /** Rare repair preparation only: no new reads, awaits or alarm I/O on healthy writes. */
  async prepare(): Promise<void> {
    // Earlier mutations schedule their settles after releasing the writer queue. Drain the
    // complete chain before acceptance so a seed's repairable kv_revision stays stable.
    for (;;) {
      const settling = this.#host.settling();
      await Promise.allSettled([settling]);
      if (settling === this.#host.settling()) break;
    }
    // Arm before the transaction persists the job: a reset at any later instruction is resumable.
    await this.#host.arm(Date.now() + REPAIR_CONTINUE_MS);
  }

  /** Non-publication mutations share the same barrier and release the queue before waiting. */
  async unblocked<T>(body: () => T | Promise<T>): Promise<T> {
    for (;;) {
      const result = await this.#host.queue.run(async () => {
        const host = this.#host.mutationHost();
        const job = host.tables ? readRepairJob(host.storage.sql) : undefined;
        return job === undefined ? { value: await body() } : { blockedBy: job.id };
      });
      if ('blockedBy' in result && result.blockedBy !== undefined) {
        await this.#host.repairs.wait(result.blockedBy);
      } else {
        return result.value as T;
      }
    }
  }

  locked<T>(empty: T, body: () => T): Promise<T> {
    return this.unblocked(() =>
      this.#host.mutationHost().tables ? this.#host.storage.transactionSync(body) : empty,
    );
  }

  /** One alarm is shared by repairs, leases, durable metadata cleanup and ordinary retention. */
  async rearm(now: number): Promise<void> {
    const host = this.#host.mutationHost();
    const sql = host.storage.sql;
    if (!host.tables || readScope(sql) === undefined) return;
    if (readRepairJob(sql) !== undefined) {
      await this.#host.arm(Date.now() + REPAIR_CONTINUE_MS);
      return;
    }
    const garbageAt = nextRepairGarbageAt(sql);
    if (garbageAt !== undefined) await this.#host.arm(Math.max(now, garbageAt));
    const lease = nextLeaseExpiry(sql);
    if (lease !== undefined) await this.#host.arm(Math.max(now, lease) + LEASE_SWEEP_GRACE_MS);
    await this.#host.arm(nextRetentionAt(sql, now, RETENTION_INTERVAL_MS));
  }
}
