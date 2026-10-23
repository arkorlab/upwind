import { flushRepairEvent } from './repair-events.ts';
import {
  advanceRepairJob,
  hasRepairValue,
  readRepairValue,
  releaseRepairGroup,
  type RepairGroup,
  type RepairJob,
  type RepairStep,
  writeRepairValue,
} from './repair-jobs.ts';
import type { TxInput } from './tx.ts';

/** Physical healing is complete; release serving cursors only after no later group can rewrite them. */
export function beginRepairFinalization(input: TxInput, job: RepairJob, value: unknown): void {
  writeRepairValue(input.sql, job.id, 'pending-result', value);
  advanceRepairJob(input.sql, {
    ...job,
    finalizing: { phase: 'records', after: '', index: 0 },
  });
}

function releaseFinalRepairGroup(input: TxInput, job: RepairJob, index: number): void {
  const group = readRepairValue<RepairGroup>(input.sql, job.id, `group-${index}`);
  releaseRepairGroup(input.sql, job.id, group, job.operation !== 'seed');
  const moved = `seed-moved-${index}`;
  if (
    job.operation === 'seed' &&
    hasRepairValue(input.sql, job.id, moved) &&
    readRepairValue<boolean>(input.sql, job.id, moved)
  )
    releaseRepairGroup(
      input.sql,
      job.id,
      readRepairValue<RepairGroup>(input.sql, job.id, `seed-active-${index}`),
      true,
    );
}

/** Every step selects one primary-key row, one event, or one originally bounded repair group. */
export function advanceRepairFinalization(input: TxInput, job: RepairJob): RepairStep<unknown> {
  const cursor = job.finalizing;
  if (cursor === undefined) throw new Error('the repair finalization cursor is missing');
  if (cursor.phase === 'records') {
    const entry = input.sql
      .exec<{ entry_id: string; revision: number; record_revision: number }>(
        'SELECT entry_id, revision, record_revision FROM entries WHERE entry_id > ? ORDER BY entry_id LIMIT 1',
        cursor.after,
      )
      .toArray()[0];
    if (entry === undefined) {
      advanceRepairJob(input.sql, {
        ...job,
        finalizing: { phase: 'events', after: '', index: 0 },
      });
    } else {
      if (entry.revision === job.fromRevision && entry.record_revision < job.fromRevision)
        input.sql.exec(
          'UPDATE entries SET record_revision = ? WHERE entry_id = ?',
          job.fromRevision,
          entry.entry_id,
        );
      advanceRepairJob(input.sql, {
        ...job,
        finalizing: { ...cursor, after: entry.entry_id },
      });
    }
    return { kind: 'pending' };
  }
  if (cursor.phase === 'events') {
    const done = flushRepairEvent(input, job, cursor.index);
    advanceRepairJob(input.sql, {
      ...job,
      finalizing: done
        ? { phase: 'pins', after: '', index: 0 }
        : { ...cursor, index: cursor.index + 1 },
    });
    return { kind: 'pending' };
  }
  if (cursor.index < job.groupCount) {
    releaseFinalRepairGroup(input, job, cursor.index);
    advanceRepairJob(input.sql, {
      ...job,
      finalizing: { ...cursor, index: cursor.index + 1 },
    });
    return { kind: 'pending' };
  }
  return { kind: 'completed', value: readRepairValue(input.sql, job.id, 'pending-result') };
}
