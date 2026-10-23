import { createId } from '@stayingupwind/core/util';
import {
  ATTEMPT_ID_PREFIX,
  type FailRequest,
  type FailResponse,
  type StartAttemptRequest,
  type StartAttemptResponse,
} from '@stayingupwind/host/cache';

import { repairStorageRef } from './artifact-repair.ts';
import { HELD_WITHOUT_CHARGE, ownedUploadOf } from './artifacts.ts';
import { freshUploadStorageRef } from './attempt-upload.ts';
import {
  type EntryIdentity,
  findEntry,
  identifyEntry,
  insertEntry,
  requireEntry,
  setFencingMax,
  setRegeneration,
} from './entries.ts';
import { findGeneration, summaryOf } from './generations.ts';
import type { EventInput } from './history.ts';
import { takeAttemptSlot } from './quotas.ts';
import { type AttemptRow, type EntryRow, toAttempt, toEntry, toEntryState } from './rows.ts';
import { isRefusal, type Refusal, refuse, requireActiveScope } from './state.ts';
import { type Apply, record, type TxInput } from './tx.ts';

/**
 * Leases. One regeneration of an entry holds the right to publish at a time; the lease carries a
 * fencing token that increases with every lease of the entry, so the commit of an attempt that
 * outlived its lease is refused however late it arrives. A failed attempt backs the entry off; a
 * lease nobody renews expires on the next sweep.
 */

const MILLISECONDS_PER_SECOND = 1000;
const MAX_BACKOFF_SECONDS = 300;
const LEASE_SWEEP_BATCH = 200;
const LIVE_STATUSES = new Set(['leased', 'uploading']);
// Even six-byte JSON escapes for every code unit leave the retained error below 4 KiB.
const ERROR_CODE_UNITS = 128;
const ERROR_MESSAGE_UNITS = 512;

/** Retain diagnostic prefixes; accepting and ending a failed attempt needs no new quota. */
function retainedError(error: FailRequest['error']): string | null {
  return error === undefined
    ? null
    : JSON.stringify({
        code: error.code.slice(0, ERROR_CODE_UNITS),
        message: error.message.slice(0, ERROR_MESSAGE_UNITS),
      });
}

/** `min(2^n, 300)` seconds after the n-th consecutive failure. */
function backoffMs(failedCount: number): number {
  return Math.min(2 ** failedCount, MAX_BACKOFF_SECONDS) * MILLISECONDS_PER_SECOND;
}

export function findAttempt(sql: SqlStorage, attemptId: string): AttemptRow | undefined {
  return sql
    .exec<AttemptRow>(`SELECT * FROM attempts WHERE attempt_id = ?`, attemptId)
    .toArray()[0];
}

/** When the earliest lease still held runs out, if any is. */
export function nextLeaseExpiry(sql: SqlStorage): number | undefined {
  return (
    sql
      .exec<{ at: number | null }>(
        `SELECT MIN(lease_expires_at) AS at FROM attempts WHERE status IN ('leased', 'uploading')`,
      )
      .one().at ?? undefined
  );
}

export function isLive(attempt: AttemptRow): boolean {
  return LIVE_STATUSES.has(attempt.status);
}

function liveLeaseOf(sql: SqlStorage, entryId: string, now: number): AttemptRow | undefined {
  return sql
    .exec<AttemptRow>(
      `SELECT * FROM attempts
       WHERE entry_id = ? AND status IN ('leased', 'uploading') AND lease_expires_at > ?
       ORDER BY fencing_token DESC LIMIT 1`,
      entryId,
      now,
    )
    .toArray()[0];
}

/**
 * The attempt an entry in backoff is held back by: its latest, whose failure set the backoff, or
 * one leased past it by hand that has ended since. Kept for as long as the history is, past any
 * backoff of a few minutes; `undefined` where it has aged out all the same.
 */
function latestAttemptOf(sql: SqlStorage, entryId: string): string | undefined {
  return sql
    .exec<{ attempt_id: string }>(
      `SELECT attempt_id FROM attempts WHERE entry_id = ? ORDER BY started_at DESC LIMIT 1`,
      entryId,
    )
    .toArray()[0]?.attempt_id;
}

function expiredLeases(sql: SqlStorage, now: number): AttemptRow[] {
  return sql
    .exec<AttemptRow>(
      `SELECT * FROM attempts WHERE status IN ('leased', 'uploading') AND lease_expires_at <= ?
       ORDER BY lease_expires_at LIMIT ?`,
      now,
      LEASE_SWEEP_BATCH,
    )
    .toArray();
}

/** The attempt is over; the entry's regeneration axis follows if it was this attempt's. */
export function endAttempt(
  input: TxInput,
  attempt: AttemptRow,
  end: { status: 'expired' | 'superseded'; regeneration: 'idle' | 'queued' },
  events: EventInput[],
): void {
  const { sql, scopeId, now, revision } = input;
  sql.exec(
    `UPDATE attempts SET status = ?, finished_at = ? WHERE attempt_id = ?`,
    end.status,
    now,
    attempt.attempt_id,
  );
  const entry = requireEntry(sql, attempt.entry_id);
  if (entry.regeneration_attempt_id === attempt.attempt_id) {
    setRegeneration(sql, {
      entryId: entry.entry_id,
      regeneration: end.regeneration,
      attemptId: null,
      failedCount: entry.failed_count,
      nextRetryAt: entry.next_retry_at,
      revision,
      now,
    });
    events.push(entryStateEvent(sql, entry.entry_id));
  }
  const ended = findAttempt(sql, attempt.attempt_id) ?? attempt;
  events.push({
    entityType: 'attempt',
    entityId: attempt.attempt_id,
    kind: end.status === 'expired' ? 'attempt.expired' : 'attempt.superseded',
    payload: { attempt: toAttempt(scopeId, ended) },
  });
}

export function entryStateEvent(sql: SqlStorage, entryId: string): EventInput {
  return {
    entityType: 'entry',
    entityId: entryId,
    kind: 'entry.state.changed',
    payload: { entryState: toEntryState(requireEntry(sql, entryId)) },
  };
}

/** One bounded page of leases past their time, ended; the count of them. */
export function expireLeases(input: TxInput): number {
  const events: EventInput[] = [];
  const expired = expiredLeases(input.sql, input.now);
  for (const attempt of expired) {
    endAttempt(input, attempt, { status: 'expired', regeneration: 'idle' }, events);
  }
  if (expired.length > 0) {
    record(input, events);
  }
  return expired.length;
}

function currentSummary(sql: SqlStorage, entry: EntryRow): StartAttemptResponse['current'] {
  if (entry.current_generation_id === null) {
    return null;
  }
  const generation = findGeneration(sql, entry.current_generation_id);
  return generation === undefined ? null : summaryOf(generation);
}

/** Only this entry's holder is ended before it can be leased again; the alarm drains the rest. */
function expireEntryLease(input: TxInput, entry: EntryRow | undefined, events: EventInput[]): void {
  const attemptId = entry?.regeneration_attempt_id;
  if (attemptId === undefined || attemptId === null) {
    return;
  }
  const attempt = findAttempt(input.sql, attemptId);
  if (attempt !== undefined && isLive(attempt) && attempt.lease_expires_at <= input.now) {
    endAttempt(input, attempt, { status: 'expired', regeneration: 'idle' }, events);
  }
}

interface StartPlan {
  readonly identity: EntryIdentity;
  readonly attemptId: string;
  readonly request: StartAttemptRequest;
}

export async function planStartAttempt(
  input: TxInput,
  request: StartAttemptRequest,
): Promise<Apply<StartAttemptResponse | Refusal>> {
  const identity = await identifyEntry(input.scopeId, request.entry, request.allowQuery);
  const attemptId = createId(ATTEMPT_ID_PREFIX);
  return () => applyStartAttempt(input, { identity, attemptId, request });
}

/** The entry, made if the render is the first anyone asked for; a new one is an event. */
function entryFor(input: TxInput, plan: StartPlan, events: EventInput[]): EntryRow | Refusal {
  const { sql, limits, now, revision, scopeId } = input;
  const existing = findEntry(sql, plan.identity.entryId);
  if (existing !== undefined) {
    return existing;
  }
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  if (scope.entry_count >= limits.entriesPerScope) {
    return refuse('quota_exceeded', 'the scope holds as many entries as it may');
  }
  const entry = insertEntry(sql, { identity: plan.identity, groupInstanceId: null, revision, now });
  events.push({
    entityType: 'entry',
    entityId: entry.entry_id,
    kind: 'entry.created',
    payload: { entry: toEntry(scopeId, entry) },
  });
  return entry;
}

function lease(input: TxInput, plan: StartPlan, entry: EntryRow, events: EventInput[]): void {
  const { sql, now, revision, limits, scopeId, history } = input;
  const fencingToken = entry.fencing_max + 1;
  const { request, attemptId } = plan;
  sql.exec(
    `INSERT INTO attempts (
       attempt_id, entry_id, reason, status, fencing_token, dependency_revision, lease_expires_at,
       started_at, finished_at, generation_id, error, producer, observation
     ) VALUES (?, ?, ?, 'leased', ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
    attemptId,
    entry.entry_id,
    request.reason,
    fencingToken,
    revision,
    now + limits.leaseMs,
    now,
    request.producer === undefined ? null : JSON.stringify(request.producer),
    // What the edge served when it asked is for the history alone (`ScopeHistory.records`).
    request.observation === undefined || !history.records(sql)
      ? null
      : JSON.stringify(request.observation),
  );
  setFencingMax(sql, entry.entry_id, fencingToken);
  setRegeneration(sql, {
    entryId: entry.entry_id,
    regeneration: 'running',
    attemptId,
    failedCount: entry.failed_count,
    nextRetryAt: null,
    revision,
    now,
  });
  const inserted = findAttempt(sql, attemptId);
  if (inserted !== undefined) {
    events.push({
      entityType: 'attempt',
      entityId: attemptId,
      kind: 'attempt.started',
      payload: { attempt: toAttempt(scopeId, inserted) },
    });
  }
  events.push(entryStateEvent(sql, entry.entry_id));
}

function applyStartAttempt(input: TxInput, plan: StartPlan): StartAttemptResponse | Refusal {
  const { sql, now, revision, limits } = input;
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  const events: EventInput[] = [];
  const existing = findEntry(sql, plan.identity.entryId);
  // Serialized starts keep one holder per entry. End only this holder here, so its next lease
  // moves the fencing token without making a request drain unrelated expired leases.
  expireEntryLease(input, existing, events);
  if (existing === undefined && scope.entry_count >= limits.entriesPerScope) {
    finish(input, events);
    return refuse('quota_exceeded', 'the scope holds as many entries as it may');
  }
  if (existing === undefined && !takeAttemptSlot(sql, now, limits.attemptsPerMinute)) {
    finish(input, events);
    return refuse(
      'quota_exceeded',
      'the scope has started as many regenerations this minute as it may',
    );
  }
  const entry = entryFor(input, plan, events);
  if (isRefusal(entry)) {
    return entry;
  }
  const current = currentSummary(sql, entry);
  const holder = liveLeaseOf(sql, entry.entry_id, now);
  if (holder !== undefined) {
    finish(input, events);
    return {
      kind: 'busy',
      entryId: entry.entry_id,
      attemptId: holder.attempt_id,
      leaseExpiresAt: holder.lease_expires_at,
      current,
    };
  }
  if (
    entry.next_retry_at !== null &&
    entry.next_retry_at > now &&
    plan.request.reason !== 'manual'
  ) {
    finish(input, events);
    // No lease stands to name: the attempt the backoff is for, a recorded one, rather than the id
    // this start was planned with, which nothing ever recorded.
    return {
      kind: 'busy',
      entryId: entry.entry_id,
      attemptId:
        entry.regeneration_attempt_id ?? latestAttemptOf(sql, entry.entry_id) ?? plan.attemptId,
      leaseExpiresAt: entry.next_retry_at,
      current,
    };
  }
  if (existing !== undefined && !takeAttemptSlot(sql, now, limits.attemptsPerMinute)) {
    finish(input, events);
    return refuse(
      'quota_exceeded',
      'the scope has started as many regenerations this minute as it may',
    );
  }
  lease(input, plan, entry, events);
  record(input, events);
  return {
    kind: 'leased',
    attemptId: plan.attemptId,
    entryId: entry.entry_id,
    fencingToken: entry.fencing_max + 1,
    dependencyRevision: revision,
    leaseExpiresAt: now + limits.leaseMs,
    current,
  };
}

/** Commit the revision only when something was recorded on the way to a refusal or a `busy`. */
function finish(input: TxInput, events: readonly EventInput[]): void {
  if (events.length > 0) {
    record(input, events);
  }
}

interface LeaseCheck {
  readonly attempt: AttemptRow;
}

/**
 * The attempt, if it may still act: live, with the fencing token it was given, within its lease.
 * One past its lease is ended on the spot, and that is recorded. None of a retired scope may: its
 * authority refuses a heartbeat or the end of an attempt as it refuses a new one.
 */
function checkLease(input: TxInput, attemptId: string, fencingToken: number): LeaseCheck | Refusal {
  const scope = requireActiveScope(input.sql);
  if (isRefusal(scope)) {
    return scope;
  }
  const attempt = findAttempt(input.sql, attemptId);
  if (attempt === undefined) {
    return refuse('not_found', 'no such attempt');
  }
  if (attempt.fencing_token !== fencingToken) {
    return refuse('superseded', 'the fencing token is not this attempt’s');
  }
  if (!isLive(attempt)) {
    return refuse(
      attempt.status === 'expired' ? 'lease_expired' : 'superseded',
      `the attempt is ${attempt.status}`,
    );
  }
  if (attempt.lease_expires_at <= input.now) {
    if (input.deferExpiredLease === true) return refuse('lease_expired', 'the lease has expired');
    const events: EventInput[] = [];
    endAttempt(input, attempt, { status: 'expired', regeneration: 'idle' }, events);
    record(input, events);
    return refuse('lease_expired', 'the lease has expired');
  }
  return { attempt };
}

export function applyHeartbeat(
  input: TxInput,
  attemptId: string,
  fencingToken: number,
): Refusal | { readonly leaseExpiresAt: number } {
  const checked = checkLease(input, attemptId, fencingToken);
  if (isRefusal(checked)) {
    return checked;
  }
  const leaseExpiresAt = input.now + input.limits.leaseMs;
  input.sql.exec(
    `UPDATE attempts SET lease_expires_at = ? WHERE attempt_id = ?`,
    leaseExpiresAt,
    attemptId,
  );
  return { leaseExpiresAt };
}

export interface UploadedArtifact {
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly encoding: 'identity' | 'gzip' | 'br';
  readonly role: string;
  readonly storageRef: string;
  /** A conditional create found an unrelated object; rotate only this current reservation. */
  readonly avoidStorageRef?: string;
}

/** A known broken canonical location needs the already verified upload stored again. */
export interface RecordedArtifact {
  readonly ok: true;
  readonly replace?: true;
  readonly fresh?: true;
  readonly storageRef?: string;
}

/**
 * The bytes already uploaded for attempts that have not committed, counted once per blob and
 * without the one being asked about.
 *
 * `scope.body_bytes` only moves at commit, so a quota asked about one artifact at a time lets a
 * generation with several outputs — or several attempts at once — each fit the remaining
 * allowance and together exceed it, with no check left by the time `publish` adds them all.
 */
export function reservedBytes(sql: SqlStorage, sha256: string): number {
  return sql
    .exec<{ bytes: number }>(
      `SELECT COALESCE(SUM(byte_length), 0) AS bytes FROM (
         SELECT aa.sha256, MAX(aa.byte_length) AS byte_length
         FROM attempt_artifacts aa
         JOIN attempts a ON a.attempt_id = aa.attempt_id
         WHERE a.status IN ('leased', 'uploading')
           AND aa.sha256 <> ?
           AND aa.sha256 NOT IN (SELECT sha256 FROM artifacts WHERE ${HELD_WITHOUT_CHARGE})
         GROUP BY aa.sha256
       )`,
      sha256,
    )
    .one().bytes;
}

/** An artifact the gateway is about to store for the attempt: counted against the scope first. */
export function applyRecordArtifact(
  input: TxInput,
  attemptId: string,
  upload: UploadedArtifact & { readonly fencingToken: number },
): Refusal | RecordedArtifact {
  const { sql, now, limits } = input;
  const checked = checkLease(input, attemptId, upload.fencingToken);
  if (isRefusal(checked)) {
    return checked;
  }
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  const {
    addedBytes: added,
    replace,
    storageRef: held,
  } = ownedUploadOf(sql, upload.sha256, upload.byteLength);
  if (
    added > 0 &&
    scope.body_bytes + reservedBytes(sql, upload.sha256) + added > limits.bodyBytesPerScope
  ) {
    return refuse('quota_exceeded', 'the scope holds as many bytes as it may');
  }
  const namespace = scope.repair_namespace;
  const fresh = replace && scope.pack_schema_version === 2 && typeof namespace === 'string';
  let storageRef = held ?? upload.storageRef;
  if (fresh) storageRef = freshUploadStorageRef(sql, attemptId, upload, namespace);
  else if (replace) storageRef = repairStorageRef(input.scopeId, upload.sha256, attemptId);
  sql.exec(
    `INSERT OR REPLACE INTO attempt_artifacts (attempt_id, sha256, role, byte_length, content_type, encoding, storage_ref, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    attemptId,
    upload.sha256,
    upload.role,
    upload.byteLength,
    upload.contentType,
    upload.encoding,
    storageRef,
    now,
  );
  sql.exec(`DELETE FROM pending_deletions WHERE storage_ref = ?`, storageRef);
  sql.exec(`UPDATE attempts SET status = 'uploading' WHERE attempt_id = ?`, attemptId);
  if (fresh) return { ok: true, replace: true, fresh: true, storageRef };
  if (replace) return { ok: true, replace: true, storageRef };
  return storageRef === upload.storageRef ? { ok: true } : { ok: true, storageRef };
}

export function applyFail(
  input: TxInput,
  attemptId: string,
  request: FailRequest,
): FailResponse | Refusal {
  const { sql, scopeId, now, revision } = input;
  // Before anything of the attempt is looked at: a retired scope's answer is that, whatever the
  // attempt came to.
  const scope = requireActiveScope(sql);
  if (isRefusal(scope)) {
    return scope;
  }
  const attempt = findAttempt(sql, attemptId);
  if (attempt === undefined) {
    return refuse('not_found', 'no such attempt');
  }
  const entry = findEntry(sql, attempt.entry_id);
  if (entry === undefined) {
    return refuse('not_found', 'the entry has been evicted');
  }
  if (!isLive(attempt)) {
    return { regeneration: toEntryState(entry).regeneration, nextRetryAt: entry.next_retry_at };
  }
  if (attempt.fencing_token !== request.fencingToken) {
    return refuse('superseded', 'the fencing token is not this attempt’s');
  }
  const checked = checkLease(input, attemptId, request.fencingToken);
  if (isRefusal(checked)) {
    return checked;
  }
  const failed = request.outcome === 'failed';
  const failedCount = failed ? entry.failed_count + 1 : 0;
  const nextRetryAt = failed ? now + (request.retryAfterMs ?? backoffMs(failedCount)) : null;
  sql.exec(
    `UPDATE attempts SET status = ?, finished_at = ?, error = ? WHERE attempt_id = ?`,
    failed ? 'failed' : 'skipped',
    now,
    retainedError(request.error),
    attemptId,
  );
  setRegeneration(sql, {
    entryId: entry.entry_id,
    regeneration: failed ? 'failed' : 'idle',
    attemptId: null,
    failedCount,
    nextRetryAt,
    revision,
    now,
  });
  const ended = findAttempt(sql, attemptId) ?? attempt;
  record(input, [
    {
      entityType: 'attempt',
      entityId: attemptId,
      kind: failed ? 'attempt.failed' : 'attempt.skipped',
      payload: { attempt: toAttempt(scopeId, ended) },
    },
    entryStateEvent(sql, entry.entry_id),
  ]);
  return { regeneration: failed ? 'failed' : 'idle', nextRetryAt };
}
