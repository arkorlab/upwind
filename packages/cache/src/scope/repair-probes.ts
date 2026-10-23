import { RepairRowTooLargeError } from './artifact-repair.ts';
import { markRecordWritten } from './entries.ts';
import type { RepairJob } from './repair-jobs.ts';
import type { TxInput } from './tx.ts';

/** Success deliberately escapes transactionSync so every candidate publication write rolls back. */
export class RepairPublicationProbed extends Error {
  override name = 'RepairPublicationProbed';
  readonly next: RepairJob;

  constructor(next: RepairJob) {
    super('the repair publication fits');
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
  input: TxInput,
  next: RepairJob,
  publish: () => unknown,
  entryId: string,
): never {
  try {
    publish();
    const entry = input.sql
      .exec<{ record_revision: number }>(
        'SELECT record_revision FROM entries WHERE entry_id = ?',
        entryId,
      )
      .toArray()[0];
    if (entry !== undefined) markRecordWritten(input.sql, entryId, entry.record_revision);
  } catch (error) {
    if (error instanceof Error && /\bSQLITE_TOOBIG\b/u.test(error.message))
      throw new RepairRowTooLargeError(error);
    throw error;
  }
  throw new RepairPublicationProbed(next);
}

/** Other writers cannot consume a revision; bypassed heartbeats only extend a lease. */
export function repairPreflightInput(input: TxInput, job: RepairJob): TxInput {
  return job.phase === 'preflight'
    ? { ...input, revision: input.revision + (job.matched ?? 0) }
    : input;
}
