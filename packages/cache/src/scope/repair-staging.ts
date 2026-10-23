import type { TxInput } from './tx.ts';

/** Read-back and history describe the final revision; serving retains its earlier cursor. */
export function stageRepairPublication<T>(input: TxInput, entryId: string, publish: () => T): T {
  const before =
    input.sql
      .exec<{ record_revision: number }>(
        'SELECT record_revision FROM entries WHERE entry_id = ?',
        entryId,
      )
      .toArray()[0]?.record_revision ?? 0;
  const value = publish();
  input.sql.exec('UPDATE entries SET record_revision = ? WHERE entry_id = ?', before, entryId);
  return value;
}
