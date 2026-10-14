import {
  type CacheEntryKind,
  deriveEntry,
  type EntryDescriptor,
  isRouteDescriptor,
  type KeyDescriptor,
  normalizeRoutePathname,
} from '@stayingupwind/core/cache';

import type { EntryRow } from './rows.ts';

/**
 * Entries: the logical things a generation replaces. An entry's identity is derived from its
 * descriptor ahead of the transaction that may create it (`identifyEntry`), so the transaction
 * itself stays synchronous.
 */

export interface EntryIdentity {
  readonly entryId: string;
  readonly kind: CacheEntryKind;
  readonly route: string | null;
  readonly pathname: string | null;
  readonly cacheKeyDigest: string;
  readonly keyDescriptor: KeyDescriptor;
  readonly handler: string | null;
}

export async function identifyEntry(
  scopeId: string,
  descriptor: EntryDescriptor,
  allowQuery?: readonly string[],
): Promise<EntryIdentity> {
  const derived = await deriveEntry(scopeId, descriptor, allowQuery);
  if (isRouteDescriptor(descriptor)) {
    return {
      entryId: derived.entryId,
      kind: descriptor.kind,
      route: descriptor.route,
      pathname: normalizeRoutePathname(descriptor.pathname),
      cacheKeyDigest: derived.cacheKeyDigest,
      keyDescriptor: derived.keyDescriptor,
      handler: null,
    };
  }
  return {
    entryId: derived.entryId,
    kind: descriptor.kind,
    route: null,
    pathname: null,
    cacheKeyDigest: derived.cacheKeyDigest,
    keyDescriptor: derived.keyDescriptor,
    handler: descriptor.handler ?? null,
  };
}

export function findEntry(sql: SqlStorage, entryId: string): EntryRow | undefined {
  return sql.exec<EntryRow>(`SELECT * FROM entries WHERE entry_id = ?`, entryId).toArray()[0];
}

export function requireEntry(sql: SqlStorage, entryId: string): EntryRow {
  const row = findEntry(sql, entryId);
  if (row === undefined) {
    throw new Error(`entry ${entryId} is not in the scope`);
  }
  return row;
}

export interface EntryInsert {
  readonly identity: EntryIdentity;
  readonly groupInstanceId: string | null;
  readonly revision: number;
  readonly now: number;
}

/** A new entry with no generation yet; the scope's count moves with it. */
export function insertEntry(sql: SqlStorage, insert: EntryInsert): EntryRow {
  const { identity, now, revision } = insert;
  sql.exec(
    `INSERT INTO entries (
       entry_id, kind, route, pathname, cache_key_digest, group_instance_id, key_descriptor, handler,
       created_at, created_revision, revision, record_revision, kv_revision, current_generation_id,
       publication, regeneration, regeneration_attempt_id, failed_count, next_retry_at,
       tombstone_revision, committed_at, updated_at, fencing_max, seq_max
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 'none', 'idle', NULL, 0, NULL, NULL, NULL, ?,
       (SELECT COALESCE(MAX(fencing_token), 0) FROM attempts WHERE entry_id = ?),
       (SELECT COALESCE(MAX(seq), 0) FROM generations WHERE entry_id = ?))`,
    identity.entryId,
    identity.kind,
    identity.route,
    identity.pathname,
    identity.cacheKeyDigest,
    insert.groupInstanceId,
    JSON.stringify(identity.keyDescriptor),
    identity.handler,
    now,
    revision,
    revision,
    now,
    identity.entryId,
    identity.entryId,
  );
  sql.exec(`UPDATE scope SET entry_count = entry_count + 1`);
  return requireEntry(sql, identity.entryId);
}

/** Whether any entry's delivery record is behind: one look at the partial index, not a count. */
export function anyRecordBehind(sql: SqlStorage): boolean {
  return (
    sql
      .exec<{ behind: number }>(
        `SELECT EXISTS (SELECT 1 FROM entries WHERE kv_revision < record_revision) AS behind`,
      )
      .one().behind === 1
  );
}

/** The record for `recordRevision` is in KV; a later change leaves the entry pending still. */
export function markRecordWritten(
  sql: SqlStorage,
  entryId: string,
  recordRevision: number,
): boolean {
  const marked = sql.exec(
    `UPDATE entries SET kv_revision = ? WHERE entry_id = ? AND record_revision = ?`,
    recordRevision,
    entryId,
    recordRevision,
  );
  return marked.rowsWritten > 0;
}

/** The ids of a page of the entries whose records are behind at `revision`, by id. */
export function recordIdsBehindAt(sql: SqlStorage, revision: number, limit: number): string[] {
  const rows = sql
    .exec<{ entry_id: string }>(
      `SELECT entry_id FROM entries WHERE kv_revision < record_revision AND record_revision = ?
       ORDER BY entry_id LIMIT ?`,
      revision,
      limit,
    )
    .toArray();
  return rows.map((row) => row.entry_id);
}

/** A page of the entries whose records are behind at `revision`, past `after` by id. */
export function recordsBehindAt(
  sql: SqlStorage,
  revision: number,
  after: string,
  limit: number,
): EntryRow[] {
  return sql
    .exec<EntryRow>(
      `SELECT * FROM entries WHERE kv_revision < record_revision AND record_revision = ?
         AND entry_id > ?
       ORDER BY entry_id LIMIT ?`,
      revision,
      after,
      limit,
    )
    .toArray();
}

/** Of the entries named, those whose records are behind, whatever revision they are at now. */
export function recordsBehindAmong(sql: SqlStorage, entryIds: readonly string[]): EntryRow[] {
  return sql
    .exec<EntryRow>(
      `SELECT * FROM entries WHERE entry_id IN (SELECT value FROM json_each(?))
         AND kv_revision < record_revision
       ORDER BY entry_id`,
      JSON.stringify(entryIds),
    )
    .toArray();
}

/** A place in the backlog of records behind: least recently written first, then by id. */
export interface BacklogCursor {
  readonly kvRevision: number;
  readonly entryId: string;
}

/**
 * A page of the backlog after `after` and up to `until`, least recently written first — by the
 * revision a record last went out at: a record a rewrite reaches goes to the back, so one that is
 * behind is never kept there by others that go out again and again. Read off the partial index of
 * the records behind. Up to `until` and not short of it: a pass that comes round to where the last
 * run stopped tries again the record it stopped at, should that one have failed.
 */
export function backlogRecords(
  sql: SqlStorage,
  after: BacklogCursor,
  until: BacklogCursor,
  limit: number,
): EntryRow[] {
  return sql
    .exec<EntryRow>(
      `SELECT * FROM entries WHERE kv_revision < record_revision
         AND (kv_revision, entry_id) > (?, ?) AND (kv_revision, entry_id) <= (?, ?)
       ORDER BY kv_revision, entry_id LIMIT ?`,
      after.kvRevision,
      after.entryId,
      until.kvRevision,
      until.entryId,
      limit,
    )
    .toArray();
}

export interface PublishedState {
  readonly entryId: string;
  readonly generationId: string;
  readonly seq: number;
  readonly revision: number;
  readonly now: number;
}

/** A new current generation: publication, regeneration and the delivery record all move. */
export function publishEntry(sql: SqlStorage, state: PublishedState): void {
  sql.exec(
    `UPDATE entries SET
       revision = ?, record_revision = ?, current_generation_id = ?, publication = 'published',
       regeneration = 'idle', regeneration_attempt_id = NULL, failed_count = 0, next_retry_at = NULL,
       tombstone_revision = NULL, committed_at = ?, updated_at = ?, seq_max = ?
     WHERE entry_id = ?`,
    state.revision,
    state.revision,
    state.generationId,
    state.now,
    state.now,
    state.seq,
    state.entryId,
  );
}

export interface RegenerationChange {
  readonly entryId: string;
  readonly regeneration: 'idle' | 'queued' | 'running' | 'failed';
  readonly attemptId: string | null;
  readonly failedCount: number;
  readonly nextRetryAt: number | null;
  readonly revision: number;
  readonly now: number;
}

/** Only the regeneration axis moves: the delivery record is what it was. */
export function setRegeneration(sql: SqlStorage, change: RegenerationChange): void {
  sql.exec(
    `UPDATE entries SET
       revision = ?, regeneration = ?, regeneration_attempt_id = ?, failed_count = ?,
       next_retry_at = ?, updated_at = ?
     WHERE entry_id = ?`,
    change.revision,
    change.regeneration,
    change.attemptId,
    change.failedCount,
    change.nextRetryAt,
    change.now,
    change.entryId,
  );
}

export function setFencingMax(sql: SqlStorage, entryId: string, fencingMax: number): void {
  sql.exec(`UPDATE entries SET fencing_max = ? WHERE entry_id = ?`, fencingMax, entryId);
}

/** Nothing of the scope is served any more; every delivery record is withdrawn. */
export function retireEntries(sql: SqlStorage, revision: number, now: number): void {
  sql.exec(
    `UPDATE entries SET revision = ?, record_revision = ?, publication = 'retired', updated_at = ?`,
    revision,
    revision,
    now,
  );
}
