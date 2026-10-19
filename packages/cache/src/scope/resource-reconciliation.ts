import { invalidationStateSchema } from '@stayingupwind/core/cache';

import type { EventInput } from './history.ts';
import { type EntryStateRow, parseJson, type TagRow, toEntryState } from './rows.ts';
import { record, type TxInput } from './tx.ts';

const PAGE = 500;

interface OutdatedRow extends Record<string, SqlStorageValue> {
  generation_id: string;
  entry_id: string;
  condemned: string | null;
}

interface Reconciliation {
  readonly tagId: string;
  readonly tag: TagRow | undefined;
  readonly tagRevision: number;
  readonly affected: Set<string>;
  readonly outdated: Set<string>;
}

/** Only the current generation's identity and existing condemnation are needed here. */
function outdatedPage(sql: SqlStorage, under: Reconciliation, after: string): OutdatedRow[] {
  return sql
    .exec<OutdatedRow>(
      `SELECT g.generation_id, g.entry_id, g.condemned
       FROM entry_tags et JOIN entries e ON e.entry_id = et.entry_id
       JOIN generations g ON g.generation_id = e.current_generation_id
       WHERE et.tag_id = ? AND et.entry_id > ? AND (g.dependency_revision < ?
         OR (g.source = 'build' AND g.published_revision > ?))
       ORDER BY et.entry_id LIMIT ?`,
      under.tagId,
      after,
      under.tagRevision,
      under.tagRevision,
      PAGE,
    )
    .toArray();
}

function needsCondemnation(row: OutdatedRow, revision: number): boolean {
  const condemned =
    row.condemned === null ? 0 : parseJson(invalidationStateSchema, row.condemned).revision;
  return condemned < revision;
}

/** The old two writes, applied to one selected page without hydrating generation metadata. */
function condemnPage(input: TxInput, rows: readonly OutdatedRow[], under: Reconciliation): void {
  const { tag } = under;
  if (tag?.stale_at === null || tag?.stale_at === undefined) return;
  const selected = rows.filter((row) => needsCondemnation(row, under.tagRevision));
  if (selected.length === 0) return;
  const generationIds = selected.map((row) => row.generation_id);
  const entryIds = selected.map((row) => row.entry_id);
  input.sql.exec(
    `UPDATE generations SET condemned = json_object(
       'revision', MAX(COALESCE(json_extract(condemned, '$.revision'), 0), ?),
       'staleAt', MIN(COALESCE(json_extract(condemned, '$.staleAt'), ?), ?),
       'hardExpireAt', MIN(COALESCE(json_extract(condemned, '$.hardExpireAt'), ?), ?)
     ) WHERE generation_id IN (SELECT value FROM json_each(?))`,
    tag.revision,
    tag.stale_at,
    tag.stale_at,
    tag.hard_expire_at,
    tag.hard_expire_at,
    JSON.stringify(generationIds),
  );
  input.sql.exec(
    `UPDATE entries SET revision = ?, record_revision = ?,
     regeneration = CASE regeneration WHEN 'idle' THEN 'queued' ELSE regeneration END,
     updated_at = ? WHERE entry_id IN (SELECT value FROM json_each(?))`,
    input.revision,
    input.revision,
    input.now,
    JSON.stringify(entryIds),
  );
  for (const entryId of entryIds) under.affected.add(entryId);
}

/**
 * Consume one tag before the next is judged, as before: the head revision decides whether work
 * was already done, while the current tag's values are what newly condemned generations receive.
 * Unrelated stored policy/tags/outputs are no longer parsed as a side effect of this operation.
 */
export function reconcileTag(input: TxInput, under: Reconciliation): void {
  let after = '';
  while (true) {
    const rows = outdatedPage(input.sql, under, after);
    if (rows.length === 0) return;
    for (const row of rows) under.outdated.add(row.entry_id);
    condemnPage(input, rows, under);
    if (rows.length < PAGE) return;
    // Every accepted entry id is nonempty; each page advances in the existing tag membership PK.
    const last = rows[rows.length - 1];
    if (last === undefined) return;
    after = last.entry_id;
  }
}

function finalStatePage(sql: SqlStorage, entryIds: readonly string[]): EventInput[] {
  const rows = sql
    .exec<EntryStateRow>(
      `SELECT e.entry_id, e.revision, e.current_generation_id, e.publication, e.regeneration,
         e.regeneration_attempt_id, e.failed_count, e.next_retry_at, e.tombstone_revision,
         e.kv_revision, e.committed_at, e.updated_at
       FROM json_each(?) p JOIN entries e ON e.entry_id = p.value
       ORDER BY CAST(p.key AS INTEGER)`,
      JSON.stringify(entryIds),
    )
    .toArray();
  if (rows.length !== entryIds.length) throw new Error('reconciled entry is missing');
  return rows.map((row) => {
    const event: EventInput = {
      entityType: 'entry',
      entityId: row.entry_id,
      kind: 'entry.state.changed',
      payload: { entryState: toEntryState(row) },
    };
    return event;
  });
}

/**
 * Capture every final payload before the first history callback, then record once as before.
 * SQL results and generation metadata hydration are bounded; the required id/event arrays and
 * total native work remain proportional to the scope. This does not bound transaction CPU.
 */
export function recordReconciliation(input: TxInput, entryIds: readonly string[]): void {
  if (entryIds.length === 0) return;
  const events: EventInput[] = [];
  for (let offset = 0; offset < entryIds.length; offset += PAGE) {
    const page = finalStatePage(input.sql, entryIds.slice(offset, offset + PAGE));
    for (const event of page) events.push(event);
  }
  record(input, events);
}
