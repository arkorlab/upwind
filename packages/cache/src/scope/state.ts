import type { GatewayErrorCode } from '@stayingupwind/host/cache';

import type { ScopeRow } from './rows.ts';

/**
 * The scope row and the revision counter, and the shape every refusal takes on its way out of the
 * authority. A mutation that records anything commits at one revision; a read never moves it.
 */

/** Why the authority would not do what it was asked; the gateway turns the code into a status. */
export interface Refusal {
  readonly kind: 'refused';
  readonly code: GatewayErrorCode;
  readonly message: string;
}

export function refuse(code: GatewayErrorCode, message: string): Refusal {
  return { kind: 'refused', code, message };
}

export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'refused'
  );
}

export function readScope(sql: SqlStorage): ScopeRow | undefined {
  return sql.exec<ScopeRow>(`SELECT * FROM scope LIMIT 1`).toArray()[0];
}

export function readRevision(sql: SqlStorage): number {
  return readScope(sql)?.revision ?? 0;
}

/** The scope, unless it was never seeded or is retired; those are refusals, not states to act on. */
export function requireActiveScope(sql: SqlStorage): ScopeRow | Refusal {
  const scope = readScope(sql);
  if (scope === undefined) {
    return refuse('not_found', 'the scope has not been seeded');
  }
  if (scope.status === 'retired') {
    return refuse('scope_retired', 'the scope is retired');
  }
  return scope;
}

/** Move the scope to `revision`: called once by a transaction that recorded something. */
export function commitRevision(sql: SqlStorage, revision: number): void {
  sql.exec(`UPDATE scope SET revision = ?`, revision);
}

export function readMeta(sql: SqlStorage, key: string): string | undefined {
  return sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key).toArray()[0]
    ?.value;
}

export function writeMeta(sql: SqlStorage, key: string, value: string): void {
  sql.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`, key, value);
}

export function deleteMeta(sql: SqlStorage, key: string): void {
  sql.exec(`DELETE FROM meta WHERE key = ?`, key);
}
