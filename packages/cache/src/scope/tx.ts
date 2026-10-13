import type { ScopeLimits } from '../env.ts';
import type { EventInput, ScopeHistory } from './history.ts';
import { commitRevision } from './state.ts';

/**
 * How a mutation is shaped. Ids are derived ahead of the transaction, since the SQLite transaction
 * is synchronous and the digests are not; the Durable Object serializes plans so the revision a
 * plan was made for is the one its transaction commits at. A plan returns the synchronous body
 * that runs inside the transaction.
 */

export interface TxInput {
  readonly sql: SqlStorage;
  readonly scopeId: string;
  readonly limits: ScopeLimits;
  /** The clock the caller acts at (unix ms). */
  readonly now: number;
  /** The revision this transaction commits at, if it records anything. */
  readonly revision: number;
  /** What the host keeps of the scope's history, told each change as it commits (`record`). */
  readonly history: ScopeHistory;
  /** Private exact marks this mutation must project before answering, captured at commit. */
  readonly controlTagIds?: string[];
  /**
   * The tags this mutation invalidates, whose records go out before it is answered: captured at
   * commit, as a later change may invalidate one again before this one's run begins.
   */
  readonly invalidatedTagIds?: string[];
}

export type Apply<T> = () => T;

/**
 * One state of an entity per revision: the last, which is the one the transaction leaves.
 *
 * A transaction can say the same thing twice — starting an attempt ends the lease before it and
 * records the entry's state, then takes the new one and records it again — and both would go out
 * at one revision, indistinguishable in order. A history that guards its writes by revision would
 * let whichever arrived last win, which is delivery order and not this one. Only the final
 * snapshot is sent; each was read from the row as it stood, so the last is what the row is.
 */
function finalStates(events: readonly EventInput[]): EventInput[] {
  const byEntity = new Map<string, EventInput>();
  for (const event of events) {
    byEntity.set(`${event.entityType}\u{0}${event.entityId}\u{0}${event.kind}`, event);
  }
  return [...byEntity.values()];
}

/** Commit the revision and tell the history what was done at it; a body that did nothing skips this. */
export function record(input: TxInput, events: readonly EventInput[]): void {
  commitRevision(input.sql, input.revision);
  for (const event of finalStates(events)) {
    input.history.append({ sql: input.sql, revision: input.revision, now: input.now }, event);
  }
}
