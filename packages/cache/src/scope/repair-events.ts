import { type EventInput, NO_HISTORY, type ScopeHistory } from './history.ts';
import { readRepairValue, repairDataKey, writeRepairValue, type RepairJob } from './repair-jobs.ts';
import { readMeta, writeMeta } from './state.ts';
import type { TxInput } from './tx.ts';

// An identity may be as long as an already accepted entity ID. A bounded trie avoids both a new
// key-length limit and a hash dependency; each edge fits independently of the complete identity.
const IDENTITY_CHUNK = 65_536;
const LAST_SINGLE_CODE_UNIT = 0xff_ff;

function eventOrdinal(sql: SqlStorage, jobId: string, event: EventInput): number {
  const identity = JSON.stringify([event.entityType, event.entityId, event.kind]);
  let node = 'root';
  for (let start = 0; start < identity.length;) {
    let end = Math.min(start + IDENTITY_CHUNK, identity.length);
    if ((identity.codePointAt(end - 1) ?? 0) > LAST_SINGLE_CODE_UNIT) end -= 1;
    const key = repairDataKey(jobId, `event-edge:${node}:${identity.slice(start, end)}`);
    let next = readMeta(sql, key);
    if (next === undefined) {
      next = crypto.randomUUID();
      writeMeta(sql, key, next);
    }
    node = next;
    start = end;
  }
  const key = repairDataKey(jobId, `event-ordinal:${node}`);
  const existing = readMeta(sql, key);
  if (existing !== undefined) return Number(existing);
  const countKey = repairDataKey(jobId, 'event-count');
  const ordinal = Number(readMeta(sql, countKey) ?? 0);
  writeMeta(sql, key, String(ordinal));
  writeMeta(sql, countKey, String(ordinal + 1));
  return ordinal;
}

/** Keep the original transaction's finalStates semantics across every durable continuation. */
export function stageRepairEvents(
  input: TxInput,
  jobId: string,
  events: readonly EventInput[],
): void {
  if (input.history === NO_HISTORY) return;
  for (const event of events) {
    const ordinal = eventOrdinal(input.sql, jobId, event);
    writeRepairValue(input.sql, jobId, `event-${ordinal}`, event);
  }
}

/** Only the rare job's real writes are buffered; preflight still probes the actual host append. */
export function repairEventHistory(input: TxInput, jobId: string): ScopeHistory {
  const { history } = input;
  if (history === NO_HISTORY) return history;
  return {
    schema: history.schema,
    open: history.open.bind(history),
    begin: history.begin.bind(history),
    reseed: history.reseed.bind(history),
    seeded: history.seeded.bind(history),
    records: history.records.bind(history),
    keeps: history.keeps.bind(history),
    append: (_context, event) => {
      stageRepairEvents(input, jobId, [event]);
    },
    owes: history.owes.bind(history),
    publish: history.publish.bind(history),
    ageOut: history.ageOut.bind(history),
    stop: history.stop.bind(history),
    head: history.head.bind(history),
  };
}

/** One original final-state event, in first-occurrence order, per finalization transaction. */
export function flushRepairEvent(input: TxInput, job: RepairJob, index: number): boolean {
  const count = Number(readMeta(input.sql, repairDataKey(job.id, 'event-count')) ?? 0);
  if (index >= count) return true;
  input.history.append(
    { sql: input.sql, revision: job.fromRevision, now: job.preparedAt },
    readRepairValue<EventInput>(input.sql, job.id, `event-${index}`),
  );
  return false;
}
