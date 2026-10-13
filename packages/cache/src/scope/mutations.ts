import { kvScopeKey } from '@stayingupwind/core/cache';

import type { ScopeLimits } from '../env.ts';
import type { ScopeHistory } from './history.ts';
import { applySchema, holdsScopeTables } from './schema.ts';
import { type OwnRecords, ownRecordsOf } from './settle.ts';
import { readRevision } from './state.ts';
import type { Apply, TxInput } from './tx.ts';

/** One plan at a time without holding the Durable Object's input while a plan performs I/O. */
export class ScopeQueue {
  #pending: Promise<unknown> = Promise.resolve();

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    const previous = this.#pending;
    const done = Promise.withResolvers<undefined>();
    this.#pending = done.promise;
    await previous;
    try {
      return await action();
    } finally {
      done.resolve(undefined);
    }
  }
}

export function scopeName(ctx: DurableObjectState): string {
  const name = ctx.id.name;
  if (name === undefined) {
    throw new Error('CacheScope must be addressed by scope id (idFromName)');
  }
  return name;
}

export interface ScopeMutationHost {
  readonly storage: DurableObjectStorage;
  readonly scopeId: string;
  readonly kv: KVNamespace;
  readonly limits: ScopeLimits;
  /** What the host keeps of the scope's history: its tables, and each change as it commits. */
  readonly history: ScopeHistory;
  readonly tables: boolean;
  readonly createdTables: () => void;
}

interface MutationResult<T> {
  readonly value: T;
  readonly own: OwnRecords | null | undefined;
  readonly tables: boolean;
}

/** Preserve the same transaction, revision fence and unknown/retired seed behavior for every RPC. */
export async function commitMutation<T>(
  host: ScopeMutationHost,
  now: number,
  plan: (input: TxInput) => Apply<T> | Promise<Apply<T>>,
  unseeded: { readonly empty: T } | { readonly seed: T },
): Promise<MutationResult<T>> {
  const sql = host.storage.sql;
  if (!host.tables) {
    if ('empty' in unseeded) return { value: unseeded.empty, own: undefined, tables: false };
    if ((await host.kv.get(kvScopeKey(host.scopeId))) !== null) {
      return { value: unseeded.seed, own: undefined, tables: false };
    }
    applySchema(sql, host.history.schema);
    host.createdTables();
  }
  const controlTagIds: string[] = [];
  const invalidatedTagIds: string[] = [];
  const input = {
    sql,
    scopeId: host.scopeId,
    limits: host.limits,
    now,
    revision: readRevision(sql) + 1,
    history: host.history,
    controlTagIds,
    invalidatedTagIds,
  };
  const apply = await plan(input);
  // Projection acknowledgments may commit while asynchronous ID planning yields.
  input.revision = readRevision(sql) + 1;
  const value = host.storage.transactionSync(apply);
  const committed = readRevision(sql) >= input.revision;
  return {
    value,
    own: committed ? ownRecordsOf(sql, input.revision, controlTagIds, invalidatedTagIds) : null,
    tables: true,
  };
}

/**
 * Upgrade a previously seeded scope before any mutation of this instance can record past it: its
 * tables and the history's, and the history told before any change of this version is
 * (`ScopeHistory.open`).
 */
export function initializeScope(sql: SqlStorage, now: number, history: ScopeHistory): boolean {
  const tables = holdsScopeTables(sql);
  if (tables) {
    applySchema(sql, history.schema);
    history.open(sql, now);
  }
  return tables;
}
