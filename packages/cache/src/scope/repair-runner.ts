import { RepairRowTooLargeError } from './artifact-repair.ts';
import { advancePreparedCommit } from './commit.ts';
import { advancePreparedData } from './data.ts';
import type { ScopeQueue } from './mutations.ts';
import {
  advanceRepairJob,
  completeRepairJob,
  readRepairJob,
  readRepairValue,
  releaseRepairGroup,
  repairJobResult,
  type RepairCompletion,
  type RepairGroup,
  type RepairStep,
} from './repair-jobs.ts';
import { advancePreparedSeed } from './seed-repair-job.ts';
import { ownRepairRecordsOf } from './settle.ts';
import { readRevision, refuse } from './state.ts';
import type { TxInput } from './tx.ts';

/** Fixed selected-row work, independent of the number of matching or skipped scope entries. */
const REPAIR_STEPS_PER_ALARM = 8;
export const REPAIR_CONTINUE_MS = 1;

interface RepairRunnerHost {
  readonly storage: DurableObjectStorage;
  readonly queue: ScopeQueue;
  readonly input: (now: number) => TxInput;
  readonly arm: (at: number) => Promise<void>;
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
    await this.#host.arm(Date.now() + REPAIR_CONTINUE_MS);
    await waiting.promise;
    const result = repairJobResult<T>(this.#sql, id);
    if (result === undefined) throw new Error('a completed repair has no durable result');
    return result;
  }

  async advance(now: number): Promise<boolean> {
    if (readRepairJob(this.#sql) === undefined) return false;
    // Explicit continuation survives more failures than the platform's finite automatic retries.
    await this.#host.arm(Date.now() + REPAIR_CONTINUE_MS);
    for (let index = 0; index < REPAIR_STEPS_PER_ALARM; index += 1) {
      const advance = (): string | undefined =>
        this.#host.storage.transactionSync(() => {
          const job = readRepairJob(this.#sql);
          if (job === undefined) return undefined;
          const input = { ...this.#host.input(now), limits: job.limits };
          let step: RepairStep<unknown>;
          switch (job.operation) {
            case 'commit':
              step = advancePreparedCommit(input, job);
              break;
            case 'data':
              step = advancePreparedData(input, job);
              break;
            case 'seed':
              step = advancePreparedSeed(input, job);
              break;
          }
          if (step.kind !== 'completed') return undefined;
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
      const finished = await this.#host.queue.run(() => {
        try {
          return advance();
        } catch (error) {
          if (!(error instanceof RepairRowTooLargeError)) throw error;
          // The failed probe's transaction has fully rolled back. Refuse this group only now,
          // using another transaction; no partial SQL update or cursor movement can escape it.
          return this.#host.storage.transactionSync(() => {
            const job = readRepairJob(this.#sql);
            if (job === undefined || job.phase !== 'preflight') throw error;
            if (job.operation === 'seed') {
              advanceRepairJob(this.#sql, {
                ...job,
                group: job.group + 1,
                phase: 'preflight',
                after: '',
              });
              return undefined;
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
