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
  /** Already verified immutable build identity; absent before the first scope seed. */
  readonly buildId?: string | undefined;
  readonly packSchemaVersion?: 1 | 2 | undefined;
  readonly repairNamespace?: string | undefined;
  /** Rare repair preparation supplied by the authority; never stored with a publication. */
  readonly prepareRepair?: (() => Promise<void>) | undefined;
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
 * `each` of `items`, `size` at a time, answered in their order: what a plan derives or asks ahead of
 * its transaction for each of the things a request names. A request may name thousands, and a plan
 * that began a digest or a read of storage for each at once would hold every one of them out
 * together; a chunk begins once the one before it has answered.
 *
 * A chunk one of which fails is failed once the rest of it has answered too, with the first failure
 * in its order. A plan runs under the scope's lock, which its failure lets go of: failed at once, the
 * calls still out would go on beside the next plan's, past the bound.
 */
export async function inChunks<T, U>(
  items: readonly T[],
  size: number,
  each: (item: T) => Promise<U>,
): Promise<U[]> {
  const answers: U[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    const chunk = items.slice(offset, offset + size);
    const settled = await Promise.allSettled(chunk.map(async (item) => each(item)));
    for (const answer of settled) {
      if (answer.status === 'rejected') {
        throw answer.reason;
      }
      answers.push(answer.value);
    }
  }
  return answers;
}

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
