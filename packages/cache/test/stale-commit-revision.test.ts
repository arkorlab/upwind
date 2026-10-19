import { policyFromBuild, tagIdFor } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { commitRequestSchema } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { applyHeartbeat, planStartAttempt } from '../src/scope/attempts.ts';
import { planCommit } from '../src/scope/commit.ts';
import { type EventInput, NO_HISTORY } from '../src/scope/history.ts';
import { blobStore } from '../src/scope/io.ts';
import { readRevision } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import type { TxInput } from '../src/scope/tx.ts';

const NOW = 1_800_000_000_000;
const HEARTBEAT_AT = NOW + 1000;
const COMMIT_AT = NOW + 2000;
const LARGE_HISTORY = 150_000;
const LIMITS = limitsOf(parseVars({}));
const ROOT = { kind: 'app-page', route: '/', pathname: '/' } as const;

function requestFor(fencingToken: number) {
  return commitRequestSchema.parse({
    fencingToken,
    observedTagRevision: 0,
    generation: {
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: {},
      tags: [{ kind: 'next-explicit', value: 'shared' }],
      outputs: [
        {
          representationKey: 'html',
          pathname: '/',
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: 0,
          artifacts: [],
        },
      ],
      dependencies: [],
      dependencyCoverage: 'complete',
    },
  });
}

function insertHistory(sql: SqlStorage, tagId: string, count: number): void {
  sql.exec(
    `INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
       target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
     VALUES ('immediate-first', 7, 'tag', ?, 'shared', ?, ?, 'immediate', NULL, '{}', ?),
       ('immediate-last', 11, 'tag', ?, 'shared', ?, ?, 'immediate', NULL, '{}', ?),
       ('latest-window', 20, 'tag', ?, 'shared', ?, NULL, 'swr', NULL, '{}', ?)`,
    tagId,
    NOW,
    NOW,
    NOW,
    tagId,
    NOW,
    NOW,
    NOW,
    tagId,
    NOW,
    NOW,
  );
  // Build distinct retained rows inside SQLite, without a 150k-object JavaScript fixture graph.
  sql.exec(
    `WITH digit(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     numbers(n) AS (
       SELECT a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n + 100000*f.n
       FROM digit a, digit b, digit c, digit d, digit e, digit f LIMIT ?
     )
     INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
       target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
     SELECT 'retained-' || n, 1, 'tag', ?, 'shared', ?, NULL, 'swr', NULL, '{}', ?
     FROM numbers`,
    count - 3,
    tagId,
    NOW,
    NOW,
  );
  sql.exec(`UPDATE scope SET revision = 20`);
}

/** Observe the real native aggregate's one-row result, without replacing its rows or bindings. */
function observedHistory(sql: SqlStorage) {
  const exec = sql.exec.bind(sql);
  const restores: (() => void)[] = [];
  const reads: {
    bindings: readonly SqlStorageValue[];
    summary: Record<string, SqlStorageValue>;
  }[] = [];
  const reading = vi
    .spyOn(sql, 'exec')
    .mockImplementation((query: string, ...bindings: SqlStorageValue[]) => {
      const cursor = exec(query, ...bindings);
      if (query.startsWith('WITH input(after_revision')) {
        const one = cursor.one.bind(cursor);
        const result = vi.spyOn(cursor, 'one').mockImplementation(() => {
          const summary = one();
          reads.push({ bindings, summary });
          return summary;
        });
        restores.push(() => {
          result.mockRestore();
        });
      }
      return cursor;
    });
  return {
    reads,
    restore() {
      reading.mockRestore();
      for (const restore of restores) restore();
    },
  };
}

function leaseState(sql: SqlStorage, attemptId: string) {
  return sql
    .exec<{ dependency_revision: number; lease_expires_at: number }>(
      `SELECT dependency_revision, lease_expires_at FROM attempts WHERE attempt_id = ?`,
      attemptId,
    )
    .one();
}

async function commitWithHistory(count: number) {
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
    NOW,
  );
  const tagId = await tagIdFor(scopeId, 'next-explicit', 'shared');
  return runInDurableObject(stub, async (instance, state) => {
    const leased = await instance.startAttempt({ entry: ROOT, reason: 'stale' }, NOW);
    if (leased.kind !== 'leased') throw new Error('the render must hold a lease');
    const { sql } = state.storage;
    const initialLease = leaseState(sql, leased.attemptId);
    insertHistory(sql, tagId, count);
    const events: EventInput[] = [];
    const tx: TxInput = {
      sql,
      scopeId,
      limits: LIMITS,
      now: COMMIT_AT,
      revision: readRevision(sql) + 1,
      history: {
        ...NO_HISTORY,
        append(_context, event) {
          events.push(event);
        },
      },
    };
    const apply = await planCommit(
      tx,
      leased.attemptId,
      requestFor(leased.fencingToken),
      blobStore(env.ARTIFACTS, () => ({})),
    );
    const heartbeat = state.storage.transactionSync(() => {
      const result = applyHeartbeat(
        { ...tx, now: HEARTBEAT_AT },
        leased.attemptId,
        leased.fencingToken,
      );
      return result;
    });
    const dependency = leaseState(sql, leased.attemptId);
    const retained = sql
      .exec<{ count: number }>('SELECT COUNT(*) AS count FROM invalidations')
      .one().count;
    const history = observedHistory(sql);
    try {
      const answer = state.storage.transactionSync(apply);
      const attempt = sql
        .exec<{ status: string; finished_at: number; error: string }>(
          `SELECT status, finished_at, error FROM attempts WHERE attempt_id = ?`,
          leased.attemptId,
        )
        .one();
      const entry = sql
        .exec<{ regeneration: string; regeneration_attempt_id: string | null }>(
          `SELECT regeneration, regeneration_attempt_id FROM entries WHERE entry_id = ?`,
          leased.entryId,
        )
        .one();
      const next = await planStartAttempt(
        { ...tx, revision: readRevision(sql) + 1, history: NO_HISTORY },
        { entry: ROOT, reason: 'stale' },
      );
      return {
        answer,
        heartbeat,
        dependency,
        initialDependencyRevision: initialLease.dependency_revision,
        initialLeaseExpiresAt: initialLease.lease_expires_at,
        retained,
        attempt,
        entry,
        retry: state.storage.transactionSync(next),
        events: events.map((event) => ({ kind: event.kind, entityId: event.entityId })),
        reads: history.reads,
        tagId,
        entryId: leased.entryId,
        attemptId: leased.attemptId,
      };
    } finally {
      history.restore();
    }
  });
}

describe('refusing a render after retained invalidations', () => {
  it.each([3, LARGE_HISTORY])(
    'ends the lease and queues another attempt after %i matching invalidations',
    async (count) => {
      const result = await commitWithHistory(count);

      expect(result.answer).toStrictEqual({ kind: 'stale-dependencies', invalidationRevision: 20 });
      expect(result.attempt).toStrictEqual({
        status: 'failed',
        finished_at: COMMIT_AT,
        error: JSON.stringify({
          code: 'stale_dependencies',
          message: 'an immediate invalidation at revision 20 touched what the render read',
        }),
      });
      expect(result.entry).toStrictEqual({
        regeneration: 'queued',
        regeneration_attempt_id: null,
      });
      expect(result.retry).toMatchObject({ kind: 'leased', fencingToken: 2 });
      expect(result.events).toStrictEqual([
        { kind: 'attempt.failed', entityId: result.attemptId },
        { kind: 'entry.state.changed', entityId: result.entryId },
      ]);
      expect(result.reads).toStrictEqual([
        {
          bindings: [0, JSON.stringify([result.tagId]), result.entryId, '[]', '{}'],
          summary: {
            revision: 20,
            stale_at: NOW,
            hard_expire_at: NOW,
            immediate: 1,
            held_through: 0,
          },
        },
      ]);
      expect({
        heartbeat: result.heartbeat,
        dependency: result.dependency,
        retained: result.retained,
        initialLeaseExpiresAt: result.initialLeaseExpiresAt,
      }).toStrictEqual({
        heartbeat: { leaseExpiresAt: HEARTBEAT_AT + LIMITS.leaseMs },
        dependency: {
          dependency_revision: result.initialDependencyRevision,
          lease_expires_at: HEARTBEAT_AT + LIMITS.leaseMs,
        },
        retained: count,
        initialLeaseExpiresAt: NOW + LIMITS.leaseMs,
      });
    },
    120_000,
  );
});
