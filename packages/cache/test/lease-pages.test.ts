import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { applyHeartbeat, expireLeases, planStartAttempt } from '../src/scope/attempts.ts';
import type { CacheScope } from '../src/scope/cache-scope.ts';
import { type EventInput, NO_HISTORY, type ScopeHistory } from '../src/scope/history.ts';
import { readRevision, writeMeta } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const SECOND = 1000;
const LIMITS = limitsOf(parseVars({}));
const STARTED = NOW - LIMITS.leaseMs;
const ROOT: RouteEntryDescriptor = { kind: 'app-page', route: '/', pathname: '/' };
const BACKLOG = 401;

interface Fixture {
  readonly instance: CacheScope;
  readonly scopeId: string;
  readonly sql: SqlStorage;
  readonly storage: DurableObjectStorage;
}

async function inScope<T>(action: (fixture: Fixture) => T | Promise<T>) {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await stub.seedScope(
    {
      scope: {
        scopeId,
        organizationId: 'owner',
        projectId: 'site',
        environmentId: 'production',
        deploymentId: scopeId,
        keySchemaVersion: 1,
        buildId: 'build',
      },
    },
    STARTED,
  );
  return runInDurableObject(stub, (instance, state) => {
    const fixture = { instance, scopeId, sql: state.storage.sql, storage: state.storage };
    return action(fixture);
  });
}

/** Existing leases accumulated before their common expiry, without hundreds of RPCs or digests. */
function addLeases(fixture: Fixture, count: number, live = false): void {
  const prefix = live ? 'live' : 'old';
  const rows = Array.from({ length: count }, (_, index) => {
    const id = `${prefix}-${String(index).padStart(4, '0')}`;
    return { id, status: index % 2 === 0 ? 'leased' : 'uploading' };
  });
  const json = JSON.stringify(rows);
  fixture.storage.transactionSync(() => {
    fixture.sql.exec(
      `INSERT INTO entries (entry_id, kind, route, pathname, cache_key_digest, group_instance_id,
       key_descriptor, handler, created_at, created_revision, revision, record_revision,
       kv_revision, current_generation_id, publication, regeneration, regeneration_attempt_id,
       failed_count, next_retry_at, tombstone_revision, committed_at, updated_at, fencing_max,
       seq_max)
       SELECT 'ent_' || json_extract(value, '$.id'), 'app-page', '/bulk/[id]',
         '/bulk/' || json_extract(value, '$.id'), json_extract(value, '$.id'), NULL, '{}', NULL,
         ?, 1, 1, 1, 1, NULL, 'none', 'running', 'att_' || json_extract(value, '$.id'),
         0, NULL, NULL, NULL, ?, 1, 0 FROM json_each(?)`,
      STARTED,
      STARTED,
      json,
    );
    fixture.sql.exec(
      `INSERT INTO attempts (attempt_id, entry_id, reason, status, fencing_token,
       dependency_revision, lease_expires_at, started_at, finished_at)
       SELECT 'att_' || json_extract(value, '$.id'), 'ent_' || json_extract(value, '$.id'),
         'stale', json_extract(value, '$.status'), 1, 1, ?, ?, NULL FROM json_each(?)`,
      live ? NOW + 10 * SECOND : NOW,
      STARTED,
      json,
    );
    fixture.sql.exec(`UPDATE scope SET entry_count = entry_count + ?`, count);
  });
}

function input(fixture: Fixture, history = NO_HISTORY) {
  return {
    sql: fixture.sql,
    scopeId: fixture.scopeId,
    limits: LIMITS,
    now: NOW,
    revision: readRevision(fixture.sql) + 1,
    history,
  };
}

async function start(fixture: Fixture, history = NO_HISTORY) {
  const apply = await planStartAttempt(input(fixture, history), { entry: ROOT, reason: 'stale' });
  return fixture.storage.transactionSync(apply);
}

function requireLease(answer: Awaited<ReturnType<CacheScope['startAttempt']>>) {
  if (answer.kind !== 'leased') throw new Error('the first request must hold the entry');
  return answer;
}

async function alarmPage(fixture: Fixture, earlier: number | undefined) {
  // A fired alarm is no longer set. An independent earlier retry must still keep its time.
  await fixture.storage.deleteAlarm();
  if (earlier !== undefined) await fixture.storage.setAlarm(earlier);
  await fixture.instance.tick(NOW);
  return { ...counts(fixture.sql), alarm: await fixture.storage.getAlarm() };
}

function counts(sql: SqlStorage) {
  return sql
    .exec<{ old: number; expired: number; live: number }>(
      `SELECT
         COUNT(CASE WHEN attempt_id LIKE 'att_old-%' AND status IN ('leased', 'uploading')
           THEN 1 END) AS old,
         COUNT(CASE WHEN attempt_id LIKE 'att_old-%' AND status = 'expired' THEN 1 END) AS expired,
         COUNT(CASE WHEN attempt_id LIKE 'att_live-%' AND status IN ('leased', 'uploading')
           THEN 1 END) AS live
       FROM attempts`,
    )
    .one();
}

function capturing(events: EventInput[]): ScopeHistory {
  return {
    ...NO_HISTORY,
    append(_context, event) {
      events.push(event);
    },
  };
}

function expire(fixture: Fixture, history = NO_HISTORY): number {
  return fixture.storage.transactionSync(() => expireLeases(input(fixture, history)));
}

describe('lease expiry pages', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expires only the requested holder before moving its fencing token and recording its final state', async () => {
    const result = await inScope(async (fixture) => {
      vi.mocked(Date.now).mockReturnValue(STARTED);
      const first = requireLease(
        await fixture.instance.startAttempt({ entry: ROOT, reason: 'stale' }, STARTED),
      );
      vi.mocked(Date.now).mockReturnValue(NOW);
      addLeases(fixture, BACKLOG);
      const events: EventInput[] = [];
      const second = requireLease(await start(fixture, capturing(events)));
      const late = fixture.storage.transactionSync(() => {
        const tx = input(fixture);
        return applyHeartbeat(tx, first.attemptId, first.fencingToken);
      });
      return {
        second,
        late,
        counts: counts(fixture.sql),
        events: events.map((event) => ({ kind: event.kind, entityId: event.entityId })),
        entryId: first.entryId,
        oldId: first.attemptId,
      };
    });

    expect(result.second).toMatchObject({ kind: 'leased', fencingToken: 2 });
    expect(result.late).toMatchObject({ kind: 'refused', code: 'lease_expired' });
    expect(result.counts).toStrictEqual({ old: BACKLOG, expired: 0, live: 0 });
    expect(result.events).toStrictEqual([
      { kind: 'entry.state.changed', entityId: result.entryId },
      { kind: 'attempt.expired', entityId: result.oldId },
      { kind: 'attempt.started', entityId: result.second.attemptId },
    ]);
  });

  it('starts a previously unseen entry without draining unrelated overdue leases', async () => {
    const result = await inScope(async (fixture) => {
      addLeases(fixture, BACKLOG);
      const answer = await start(fixture);
      return { answer, counts: counts(fixture.sql) };
    });

    expect(result.answer).toMatchObject({ kind: 'leased', fencingToken: 1 });
    expect(result.counts).toStrictEqual({ old: BACKLOG, expired: 0, live: 0 });
  });

  it('keeps the requested unexpired holder busy without expiring it or unrelated leases', async () => {
    const result = await inScope(async (fixture) => {
      const first = requireLease(
        await fixture.instance.startAttempt({ entry: ROOT, reason: 'stale' }, NOW),
      );
      addLeases(fixture, BACKLOG);
      const events: EventInput[] = [];
      const answer = await start(fixture, capturing(events));
      return { first, answer, counts: counts(fixture.sql), events };
    });

    expect(result.answer).toMatchObject({ kind: 'busy', attemptId: result.first.attemptId });
    expect(result.events).toStrictEqual([]);
    expect(result.counts).toStrictEqual({ old: BACKLOG, expired: 0, live: 0 });
  });

  it('drains tied leased and uploading deadlines across alarms without postponing an earlier alarm', async () => {
    const pages = await inScope(async (fixture) => {
      addLeases(fixture, BACKLOG);
      addLeases(fixture, 2, true);
      writeMeta(fixture.sql, 'last_retention_at', String(NOW));
      return [
        await alarmPage(fixture, undefined),
        await alarmPage(fixture, NOW + 250),
        await alarmPage(fixture, undefined),
      ];
    });

    expect(pages).toStrictEqual([
      { old: 201, expired: 200, live: 2, alarm: NOW + SECOND },
      { old: 1, expired: 400, live: 2, alarm: NOW + 250 },
      { old: 0, expired: BACKLOG, live: 2, alarm: NOW + 11 * SECOND },
    ]);
  });

  it('rolls back a failed page and retries without losing leases, revisions or expiry events', async () => {
    const result = await inScope((fixture) => {
      addLeases(fixture, BACKLOG);
      fixture.sql.exec(`CREATE TRIGGER refuse_expiry BEFORE UPDATE OF status ON attempts
        WHEN new.status = 'expired' BEGIN SELECT RAISE(ABORT, 'expiry failed'); END`);
      const revision = readRevision(fixture.sql);
      const events: EventInput[] = [];
      const history = capturing(events);

      expect(() => expire(fixture, history)).toThrow('expiry failed');

      const failed = { ...counts(fixture.sql), revision: readRevision(fixture.sql) };
      fixture.sql.exec(`DROP TRIGGER refuse_expiry`);
      const ended = expire(fixture, history);
      return {
        revision,
        failed,
        ended,
        retried: { ...counts(fixture.sql), revision: readRevision(fixture.sql) },
        expiredEvents: events.filter((event) => event.kind === 'attempt.expired').length,
      };
    });

    expect(result.failed).toStrictEqual({
      old: BACKLOG,
      expired: 0,
      live: 0,
      revision: result.revision,
    });
    expect(result.ended).toBe(200);
    expect(result.retried).toStrictEqual({
      old: 201,
      expired: 200,
      live: 0,
      revision: result.revision + 1,
    });
    expect(result.expiredEvents).toBe(200);
  });
});
