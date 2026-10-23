import { RepairRowTooLargeError } from './artifact-repair.ts';
import { advancePreparedCommit } from './commit.ts';
import { advancePreparedData } from './data.ts';
import type { ScopeQueue } from './mutations.ts';
import { repairEventHistory } from './repair-events.ts';
import { advanceRepairFinalization, beginRepairFinalization } from './repair-finalize.ts';
import {
  advanceRepairJob,
  completeRepairJob,
  readRepairJob,
  readRepairValue,
  releaseRepairGroup,
  repairJobResult,
  retryRepairJob,
  type RepairCompletion,
  type RepairGroup,
  type RepairStep,
} from './repair-jobs.ts';
import { RepairPublicationProbedError } from './repair-probes.ts';
import { advancePreparedSeed } from './seed-repair-job.ts';
import { retryDelayMs } from './settle-retry.ts';
import { ownRepairRecordsOf } from './settle.ts';
import { isRefusal, readRevision, refuse } from './state.ts';
import type { TxInput } from './tx.ts';

/** Fixed selected-row work, independent of the number of matching or skipped scope entries. */
const REPAIR_STEPS_PER_ALARM = 8;
export const REPAIR_CONTINUE_MS = 1;

interface RepairRunnerHost {
  readonly storage: DurableObjectStorage;
  readonly queue: ScopeQueue;
  readonly input: (now: number) => TxInput;
  readonly arm: (at: number) => Promise<void>;
  readonly defer?: (at: number) => Promise<void>;
}

/** Only writes and alarms use this coordinator; ordinary serving reads never consult a job. */
export class RepairRunner {
  readonly #host: RepairRunnerHost;
  readonly #repairWaiters = new Map<string, ReturnType<typeof Promise.withResolvers<undefined>>>();

  constructor(host: RepairRunnerHost) {
    this.#host = host;
  }

  get #sql(): SqlStorage {
    return this.#host.storage.sql;
  }

  /** Wait outside ScopeQueue. An alarm, rather than a waiting writer, advances the durable cursor. */
  async wait<T = unknown>(id: string): Promise<RepairCompletion<T>> {
    const completed = repairJobResult<T>(this.#sql, id);
    if (completed !== undefined) return completed;
    let waiting = this.#repairWaiters.get(id);
    if (waiting === undefined) {
      waiting = Promise.withResolvers<undefined>();
      this.#repairWaiters.set(id, waiting);
    }
    const job = readRepairJob(this.#sql);
    await this.#host.arm(Math.max(Date.now() + REPAIR_CONTINUE_MS, job?.retryAt ?? 0));
    await waiting.promise;
    const result = repairJobResult<T>(this.#sql, id);
    if (result === undefined) throw new Error('a completed repair has no durable result');
    return result;
  }

  async advance(now: number): Promise<boolean> {
    const initial = readRepairJob(this.#sql);
    if (initial === undefined) return false;
    if ((initial.retryAt ?? 0) > now) {
      await this.#host.arm(initial.retryAt ?? now);
      return true;
    }
    // Explicit continuation survives more failures than the host's finite automatic retries.
    await this.#host.arm(Date.now() + REPAIR_CONTINUE_MS);
    for (let index = 0; index < REPAIR_STEPS_PER_ALARM; index += 1) {
      const advance = (): string | undefined => {
        return this.#host.storage.transactionSync(() => {
          const job = readRepairJob(this.#sql);
          if (job === undefined) return;
          const raw = {
            ...this.#host.input(job.preparedAt),
            revision: job.fromRevision,
            limits: job.limits,
            stageRepairRecords: true as const,
          };
          const input =
            job.phase === 'preflight' || job.finalizing !== undefined
              ? raw
              : { ...raw, history: repairEventHistory(raw, job.id) };
          let step: RepairStep<unknown>;
          if (job.finalizing === undefined) {
            switch (job.operation) {
              case 'commit': {
                step = advancePreparedCommit(input, job);
                break;
              }
              case 'data': {
                step = advancePreparedData(input, job);
                break;
              }
              case 'seed': {
                step = advancePreparedSeed(input, job);
                break;
              }
            }
          } else {
            step = advanceRepairFinalization(raw, job);
          }
          if (step.kind !== 'completed') return;
          if (job.finalizing === undefined && !isRefusal(step.value)) {
            beginRepairFinalization(raw, job, step.value);
            return;
          }
          const revision = readRevision(this.#sql);
          completeRepairJob(
            this.#sql,
            job,
            {
              value: step.value,
              own:
                revision >= job.fromRevision
                  ? ownRepairRecordsOf(this.#sql, job.fromRevision, revision)
                  : null,
            },
            now,
          );
          return job.id;
        });
      };
      const finished = await this.#host.queue.run(async () => {
        try {
          return advance();
        } catch (error) {
          if (error instanceof RepairPublicationProbedError) {
            this.#host.storage.transactionSync(() => {
              const owner = readRepairJob(this.#sql);
              if (owner?.id !== error.next.id || owner.phase !== 'preflight')
                throw new Error('the repair probe owner changed', { cause: error });
              advanceRepairJob(this.#sql, error.next);
            });
            return;
          }
          if (!(error instanceof RepairRowTooLargeError)) {
            const job = readRepairJob(this.#sql);
            if (job !== undefined) {
              const retryAt = now + retryDelayMs((job.failures ?? 0) + 1);
              try {
                this.#host.storage.transactionSync(() => {
                  retryRepairJob(this.#sql, job, retryAt);
                });
              } finally {
                // Replace the speculative 1ms alarm, rather than asking an earliest-only arm to
                // move it later. While this job is active, its pinned maintenance cannot run.
                await (this.#host.defer ?? this.#host.arm)(retryAt);
              }
            }
            throw error;
          }
          // The failed probe's transaction has fully rolled back. Refuse this group only now,
          // using another transaction; no partial SQL update or cursor movement can escape it.
          return this.#host.storage.transactionSync(() => {
            const job = readRepairJob(this.#sql);
            if (job?.phase !== 'preflight') throw error;
            if (job.operation === 'seed') {
              advanceRepairJob(this.#sql, {
                ...job,
                group: job.group + 1,
                phase: 'preflight',
                after: '',
              });
              return;
            }
            releaseRepairGroup(
              this.#sql,
              job.id,
              readRepairValue<RepairGroup>(this.#sql, job.id, 'group-0'),
            );
            completeRepairJob(
              this.#sql,
              job,
              { value: refuse('too_large', error.message), own: null },
              now,
            );
            return job.id;
          });
        }
      });
      if (finished !== undefined) {
        this.#repairWaiters.get(finished)?.resolve(undefined);
        this.#repairWaiters.delete(finished);
      }
      if (readRepairJob(this.#sql) === undefined) return false;
    }
    await this.#host.arm(Date.now() + REPAIR_CONTINUE_MS);
    return true;
  }
}
