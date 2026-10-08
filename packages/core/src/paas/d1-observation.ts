import { tagNextCacheRead } from './next-cache-registry.ts';
import { readsPrimary } from './resource-read-context.ts';
import { sqlEffect } from './sql-effect.ts';

/** A logical identity shared by local prerenders and a hosted project's sole D1 binding. */
export const DEFAULT_D1_CACHE_TAG = 'upwind:resource:d1:default';

export function d1CacheTag(_bindingName: string, d1Count: number): string | undefined {
  return d1Count === 1 ? DEFAULT_D1_CACHE_TAG : undefined;
}

export interface D1Observation {
  /** Hosted mutations await bounded delivery; a reporting failure preserves the committed result. */
  readonly changed?: (bindingName: string) => Promise<void>;
  readonly failed?: (bindingName: string, error: unknown) => void;
  readonly primaryReads?: () => boolean;
}

interface Statement {
  bind(...values: unknown[]): Statement;
  all(...args: unknown[]): Promise<unknown>;
  run(...args: unknown[]): Promise<unknown>;
  first(...args: unknown[]): Promise<unknown>;
  raw(...args: unknown[]): Promise<unknown>;
}

interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
  exec(sql: string): Promise<unknown>;
  withSession?: (constraint?: string) => Database;
}

function method<T extends object>(target: T, key: PropertyKey): unknown {
  const value = Reflect.get(target, key, target) as unknown;
  return typeof value === 'function' && key !== 'constructor' ? value.bind(target) : value;
}

/** Match native bind's eager snapshots of binary inputs when a warm read must be re-prepared. */
function boundValues(values: readonly unknown[]): unknown[] {
  return values.map((value) => {
    if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));
    if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<unknown>);
    return value;
  });
}

function changed(result: unknown, sql: string): boolean {
  if (typeof result === 'object' && result !== null) {
    const meta = (result as { meta?: unknown }).meta;
    if (typeof meta === 'object' && meta !== null) {
      const fields = meta as { changed_db?: unknown; rows_written?: unknown };
      if (typeof fields.changed_db === 'boolean') return fields.changed_db;
      if (typeof fields.rows_written === 'number') return fields.rows_written > 0;
    }
  }
  return sqlEffect(sql) !== 'read';
}

/** Preserve native raw row/column ordering, and use metadata wherever the public API offers it. */
export function observeD1(
  binding: object,
  bindingName: string,
  observation: D1Observation = {},
): object {
  const root = binding as Database;
  const originalStatements = new WeakMap<
    object,
    { statement: Statement; sql: string; values: unknown[] }
  >();
  const notify = async (): Promise<void> => {
    try {
      await observation.changed?.(bindingName);
    } catch (error) {
      // The database already committed. Reporting failure must never invite a SQL retry.
      try {
        observation.failed?.(bindingName, error);
      } catch {
        /* Preserve the committed result. */
      }
    }
  };
  const warming = (): boolean => readsPrimary() || observation.primaryReads?.() === true;
  const primarySession = (): Database => root.withSession?.('first-primary') ?? root;

  function statementOf(
    database: Database,
    sql: string,
    values: unknown[] = [],
    native?: Statement,
  ): Statement {
    const statement = native ?? database.prepare(sql);
    const selected = (): Statement => {
      // Session constraints are the application's outside warming. Inside it even an old
      // explicit bookmark is replaced at execution, before fresh output can be published.
      if (warming()) {
        const primary = primarySession().prepare(sql);
        return values.length === 0 ? primary : primary.bind(...values);
      }
      return statement;
    };
    const execute = async (kind: 'all' | 'run' | 'raw', args: unknown[]): Promise<unknown> => {
      tagNextCacheRead(DEFAULT_D1_CACHE_TAG);
      const result = await selected()[kind](...args);
      if (changed(result, sql)) await notify();
      return result;
    };
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind')
          return (...args: unknown[]) =>
            statementOf(database, sql, boundValues(args), target.bind(...args));
        if (key === 'all' || key === 'run' || key === 'raw')
          return (...args: unknown[]) => execute(key, args);
        if (key === 'first')
          return async (column?: unknown): Promise<unknown> => {
            // first() hides metadata. all() uses the same native query and exposes it, before
            // first's shaping can throw (a successful UPDATE RETURNING still changed the DB).
            const result = await execute('all', []);
            const rows = (result as { results?: Record<string, unknown>[] }).results;
            const row = rows?.[0];
            if (row === undefined) return null;
            if (column === undefined) return row;
            const value = row[String(column)];
            if (value === undefined) {
              throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${String(column)})`, {
                cause: new Error('Column not found'),
              });
            }
            return value;
          };
        return method(target, key);
      },
    });
    originalStatements.set(proxy, { statement, sql, values });
    return proxy;
  }

  function databaseOf(database: Database): Database {
    return new Proxy(database, {
      get(target, key) {
        if (key === 'prepare') return (sql: string) => statementOf(target, sql);
        if (key === 'withSession' && target.withSession !== undefined) {
          return (constraint?: string) => databaseOf(target.withSession?.(constraint) as Database);
        }
        if (key === 'batch')
          return async (statements: Statement[]): Promise<unknown[]> => {
            tagNextCacheRead(DEFAULT_D1_CACHE_TAG);
            const entries = statements.map((statement) => originalStatements.get(statement));
            const selected = warming() ? primarySession() : target;
            const native = statements.map((statement, index) => {
              const entry = entries[index];
              if (entry === undefined) return statement;
              if (selected !== target) {
                const primary = selected.prepare(entry.sql);
                return entry.values.length === 0 ? primary : primary.bind(...entry.values);
              }
              return entry.statement;
            });
            const results = await selected.batch(native);
            if (results.some((result, index) => changed(result, entries[index]?.sql ?? '')))
              await notify();
            return results;
          };
        if (key === 'exec' && typeof target.exec === 'function')
          return async (sql: string): Promise<unknown> => {
            tagNextCacheRead(DEFAULT_D1_CACHE_TAG);
            // Native exec accepts newline-separated statements as well as semicolons.
            const mayWrite = sql.split('\n').some((line) => sqlEffect(line) !== 'read');
            let result: unknown;
            try {
              result = await target.exec(sql);
            } catch (error) {
              // exec may commit earlier statements before a later statement fails. Its public
              // error has no metadata, so successful partial writes need conservative invalidation.
              if (mayWrite) await notify();
              throw error;
            }
            if (mayWrite) await notify();
            return result;
          };
        return method(target, key);
      },
    });
  }
  return databaseOf(root);
}
