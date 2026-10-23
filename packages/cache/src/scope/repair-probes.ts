import {
  type ArtifactRepair,
  RepairRowTooLargeError,
  repairSnapshotStep,
} from './artifact-repair.ts';
import { NO_HISTORY } from './history.ts';
import type { RepairJob } from './repair-jobs.ts';
import { record, type TxInput } from './tx.ts';

export { stageRepairPublication } from './repair-staging.ts';

/** Success deliberately escapes transactionSync so every candidate publication write rolls back. */
export class RepairPublicationProbedError extends Error {
  override name = 'RepairPublicationProbedError';
  readonly next: RepairJob;

  constructor(next: RepairJob, options?: ErrorOptions) {
    super('the repair publication fits', options);
    this.next = next;
  }
}

/**
 * Run the actual SQL-only final publication at its exact future revision. The writer barrier
 * keeps its quota, canonical counters and own generation stable; shared healing changes only
 * other snapshots' physical locations. A private success sentinel rolls the whole outer step back.
 * The coordinator, outside that transaction, persists the next phase in a fresh transaction.
 */
export function probeRepairPublication(
  _input: TxInput,
  next: RepairJob,
  publish: () => unknown,
): never {
  try {
    publish();
  } catch (error) {
    if (error instanceof Error && /\bSQLITE_TOOBIG\b/u.test(error.message))
      throw new RepairRowTooLargeError(error);
    throw error;
  }
  throw new RepairPublicationProbedError(next);
}

/** Every continuation belongs to the original accepted transaction revision. */
export function repairPreflightInput(input: TxInput, job: RepairJob): TxInput {
  return { ...input, revision: job.fromRevision };
}

/** A custom host's exact shared-row event must fit before any of the group is applied. */
export function probeRepairSnapshot(
  input: TxInput,
  next: RepairJob,
  repairs: ReadonlyMap<string, ArtifactRepair>,
  cursor: { readonly after: string; readonly excluding: ReadonlySet<string> },
): void {
  if (input.history === NO_HISTORY) return;
  probeRepairPublication(input, next, () => {
    const step = repairSnapshotStep(input, repairs, { ...cursor, apply: true });
    if (!step.changed || step.failure !== undefined)
      throw new Error('the preflighted shared repair changed');
    record(input, []);
  });
}
