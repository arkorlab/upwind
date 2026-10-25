import { type DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** The authority's SQL cursor over Node's SQLite, wholly confined to its worker thread. */
export function sqlStorage(database: DatabaseSync): SqlStorage {
  const exec = <T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ) => {
    const statement = database.prepare(query);
    const args = bindings.map((value): SQLInputValue =>
      value instanceof ArrayBuffer ? new Uint8Array(value) : (value as SQLInputValue),
    );
    const columnNames = statement.columns().map((column) => column.name);
    let rows: T[];
    let rowsWritten: number;
    if (columnNames.length > 0) {
      rows = statement.all(...args) as T[];
      rowsWritten = Number(database.prepare('SELECT changes() AS changes').get()?.['changes'] ?? 0);
    } else {
      const result = statement.run(...args);
      rows = [];
      rowsWritten = Number(result.changes);
    }
    return {
      columnNames,
      rowsRead: rows.length,
      rowsWritten,
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`expected one SQL row, got ${String(rows.length)}`);
        return rows[0];
      },
      raw: () => rows.map((row) => columnNames.map((name) => row[name]))[Symbol.iterator](),
      [Symbol.iterator]: () => rows[Symbol.iterator](),
    };
  };
  // The authority uses exec/cursors alone. No Durable Object implementation is involved.
  return { exec } as unknown as SqlStorage;
}

export function transaction<T>(database: DatabaseSync, body: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const value = body();
    database.exec('COMMIT');
    return value;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
