import { policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { createLogger } from '../src/logger.ts';
import { identifyEntry, insertEntry, publishEntry } from '../src/scope/entries.ts';
import { insertGeneration } from '../src/scope/generations.ts';
import { type EventInput, NO_HISTORY } from '../src/scope/history.ts';
import { blobStore } from '../src/scope/io.ts';
import { nextRetentionAt, runRetention } from '../src/scope/retention-run.ts';
import { applyRetention, type RetentionInput } from '../src/scope/retention.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const PRESENT = 401;
const HISTORY = 1200;
const LIMITS = limitsOf(parseVars({}));

async function scopeForTest() {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await runInDurableObject(stub, (_instance, state) => {
    applySchema(state.storage.sql, []);
    applySeedScope(
      {
        sql: state.storage.sql,
        scopeId,
        limits: LIMITS,
        now: NOW,
        revision: 1,
        history: NO_HISTORY,
      },
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
    );
  });
  return { stub, scopeId };
}

async function dataHistory(sql: SqlStorage, scopeId: string, expired = true) {
  const identity = await identifyEntry(scopeId, { kind: 'data:fetch', key: 'busy-key' });
  insertEntry(sql, { identity, groupInstanceId: null, revision: 2, now: NOW });
  for (let index = 1; index <= HISTORY + PRESENT; index += 1) {
    insertGeneration(sql, {
      generationId: `generation-${String(index).padStart(5, '0')}`,
      entryId: identity.entryId,
      seq: index,
      source: 'runtime',
      attemptId: null,
      cacheTimestamp: expired ? NOW - 2000 : NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 1, initialExpiration: 1 }),
      status: 200,
      headers: {},
      tags: [],
      dependencyCoverage: 'complete',
      dependencyRevision: 2,
      publishedRevision: 2,
      condemned: null,
      bodyBytes: 0,
      producer: null,
      outputs: [],
      committedAt: NOW,
    });
  }
  sql.exec(
    `UPDATE generations SET publication = 'superseded', superseded_revision = 2
    WHERE seq < ?`,
    HISTORY + PRESENT,
  );
  sql.exec(`UPDATE generations SET storage = 'pruned', pruned_at = ? WHERE seq <= ?`, NOW, HISTORY);
  publishEntry(sql, {
    entryId: identity.entryId,
    generationId: `generation-${String(HISTORY + PRESENT).padStart(5, '0')}`,
    seq: HISTORY + PRESENT,
    revision: 2,
    now: NOW,
  });
  return identity.entryId;
}

function retained(sql: SqlStorage) {
  return {
    present: sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM generations WHERE storage = 'present'`)
      .one().n,
    entries: sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM entries`).one().n,
    published: sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM generations WHERE publication = 'published'`)
      .one().n,
  };
}

function expirePage(input: RetentionInput, storage: DurableObjectStorage) {
  const { sql } = input;
  const exec = sql.exec.bind(sql);
  let directRetirementWrites = 0;
  const scans: (() => number)[] = [];
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query: string, ...bindings) => {
    const cursor = exec(query, ...(bindings as SqlStorageValue[]));
    if (query.includes("UPDATE generations SET publication = 'retired'")) {
      directRetirementWrites += cursor.rowsWritten;
    }
    if (query.includes('FROM generations AS former')) {
      scans.push(() => cursor.rowsRead);
    }
    return cursor;
  });
  try {
    const plan = storage.transactionSync(() => applyRetention(input));
    return { plan, directRetirementWrites, scans: scans.map((read) => read()), ...retained(sql) };
  } finally {
    spy.mockRestore();
  }
}

describe('retention of a frequently replaced data key', () => {
  it('retires only its published generation before pruning a bounded history page', async () => {
    const { stub, scopeId } = await scopeForTest();
    const result = await runInDurableObject(stub, async (_instance, state) => {
      await dataHistory(state.storage.sql, scopeId);
      return expirePage(
        { sql: state.storage.sql, limits: LIMITS, now: NOW, history: NO_HISTORY },
        state.storage,
      );
    });

    expect(result.directRetirementWrites).toBeLessThanOrEqual(4);
    expect(Math.max(...result.scans)).toBeLessThan(2000);
    expect(result).toMatchObject({
      present: PRESENT - 200,
      entries: 1,
      published: 0,
      plan: { more: true },
    });
  });

  it('drains every expired generation and reclaims the withdrawn entry with any keep windows', async () => {
    const { stub, scopeId } = await scopeForTest();
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const { sql } = state.storage;
      await dataHistory(sql, scopeId);
      const events: EventInput[] = [];
      const input = {
        sql,
        now: NOW,
        limits: { ...LIMITS, retainNoncurrentUnrecordedMs: LIMITS.retainHistoryUnrecordedMs * 10 },
        history: {
          ...NO_HISTORY,
          append: (_context, event) => {
            events.push(event);
          },
        },
      } satisfies RetentionInput;
      const first = expirePage(input, state.storage);
      sql.exec(`UPDATE entries SET kv_revision = record_revision`);
      const second = expirePage(input, state.storage);
      const third = expirePage(input, state.storage);
      return {
        pages: [first, second, third],
        retired: events.filter((e) => e.kind === 'entry.retired').length,
        pruned: events.filter((e) => e.kind === 'generation.pruned').length,
      };
    });

    expect(result.pages.map((page) => page.present)).toStrictEqual([201, 1, 0]);
    expect(result.pages.map((page) => page.plan.more)).toStrictEqual([true, true, false]);
    expect(result.pages.at(-1)?.entries).toBe(0);
    expect(result.retired).toBe(1);
    expect(result.pruned).toBe(PRESENT);
  });

  it('preserves an unexpired current value and its rollback copy', async () => {
    const { stub, scopeId } = await scopeForTest();
    const result = await runInDurableObject(stub, async (_instance, state) => {
      await dataHistory(state.storage.sql, scopeId, false);
      return expirePage(
        { sql: state.storage.sql, limits: LIMITS, now: NOW, history: NO_HISTORY },
        state.storage,
      );
    });

    expect(result.directRetirementWrites).toBe(0);
    expect(result.entries).toBe(1);
    expect(result.published).toBe(1);
    expect(result.present).toBeGreaterThan(1);
  });
});

const CUTOFF = NOW - LIMITS.retainHistoryUnrecordedMs;

async function attemptHistory(sql: SqlStorage, scopeId: string, count: number) {
  const identity = await identifyEntry(scopeId, { kind: 'data:fetch', key: 'attempt-key' });
  insertEntry(sql, { identity, groupInstanceId: null, revision: 2, now: NOW });
  const add = (id: string, status: string, finished: number | null): void => {
    sql.exec(
      `INSERT INTO attempts (attempt_id, entry_id, reason, status, fencing_token,
      dependency_revision, lease_expires_at, started_at, finished_at)
      VALUES (?, ?, 'stale', ?, 1, 2, ?, ?, ?)`,
      id,
      identity.entryId,
      status,
      NOW + 10_000,
      CUTOFF - 2000,
      finished,
    );
  };
  for (let index = 0; index < count; index += 1) {
    add(
      `old-${String(index).padStart(5, '0')}`,
      index % 2 === 0 ? 'failed' : 'committed',
      CUTOFF - 1,
    );
  }
  add('at-cutoff', 'committed', CUTOFF);
  add('recent', 'failed', NOW);
  add('leased', 'leased', null);
  add('uploading', 'uploading', null);
  add('unfinished', 'failed', null);
  // Preserve even an inconsistent live row, as the old status predicate did.
  add('old-live', 'leased', CUTOFF - 1);
}

function remainingAttempts(sql: SqlStorage) {
  return {
    old: sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM attempts
      WHERE attempt_id LIKE 'old-%' AND status NOT IN ('leased', 'uploading')`)
      .one().n,
    controls: Array.from(
      sql.exec<{ attempt_id: string }>(`SELECT attempt_id FROM attempts
      WHERE attempt_id NOT LIKE 'old-%' OR status = 'leased' ORDER BY attempt_id`),
      (row) => row.attempt_id,
    ),
  };
}

const KEPT_ATTEMPTS = ['at-cutoff', 'leased', 'old-live', 'recent', 'unfinished', 'uploading'];

describe('finished attempt retention pages', () => {
  it.each([0, 1, 199, 200, 201, 401, 1001])(
    'deletes at most one page from %i old attempts',
    async (count) => {
      const { stub, scopeId } = await scopeForTest();
      const result = await runInDurableObject(stub, async (_instance, state) => {
        const { sql } = state.storage;
        await attemptHistory(sql, scopeId, count);
        const plan = state.storage.transactionSync(() => {
          return applyRetention({
            sql,
            limits: LIMITS,
            now: NOW,
            history: NO_HISTORY,
          });
        });
        return { more: plan.more, ...remainingAttempts(sql) };
      });

      expect(result.old).toBe(Math.max(0, count - 200));
      expect(result.more).toBe(count >= 200);
      expect(result.controls).toStrictEqual(KEPT_ATTEMPTS);
    },
  );

  it('drains equal-timestamp pages across calls and uses the existing one-second backlog alarm', async () => {
    const { stub, scopeId } = await scopeForTest();
    await runInDurableObject(stub, async (_instance, state) => {
      await attemptHistory(state.storage.sql, scopeId, 401);
    });
    const pages = [];
    for (let index = 0; index < 3; index += 1) {
      pages.push(
        await runInDurableObject(stub, async (_instance, state) => {
          const { sql } = state.storage;
          const erased = await runRetention(
            {
              sql,
              scopeId,
              limits: LIMITS,
              history: NO_HISTORY,
              blobs: blobStore(env.ARTIFACTS, () => ({})),
              log: createLogger(),
              transaction: (body) => state.storage.transactionSync(body),
            },
            NOW,
            undefined,
          );
          return { erased, next: nextRetentionAt(sql, NOW, 3_600_000), ...remainingAttempts(sql) };
        }),
      );
    }

    expect(pages.map((page) => page.old)).toStrictEqual([201, 1, 0]);
    expect(pages.map((page) => page.next)).toStrictEqual([NOW + 1000, NOW + 1000, NOW + 3_600_000]);

    for (const page of pages) {
      expect(page.erased).toBe(false);
      expect(page.controls).toStrictEqual(KEPT_ATTEMPTS);
    }
  });

  it('rolls back a failed page and can retry it without losing or skipping attempts', async () => {
    const { stub, scopeId } = await scopeForTest();
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const { sql } = state.storage;
      await attemptHistory(sql, scopeId, 401);
      sql.exec(`CREATE TRIGGER refuse_attempt_delete BEFORE DELETE ON attempts
        WHEN old.attempt_id = 'old-00150' BEGIN SELECT RAISE(ABORT, 'attempt delete failed'); END`);
      const run = () => {
        return state.storage.transactionSync(() => {
          return applyRetention({
            sql,
            limits: LIMITS,
            now: NOW,
            history: NO_HISTORY,
          });
        });
      };

      expect(run).toThrow('attempt delete failed');

      const afterFailure = remainingAttempts(sql);
      sql.exec(`DROP TRIGGER refuse_attempt_delete`);
      const plan = run();
      return { afterFailure, afterRetry: remainingAttempts(sql), more: plan.more };
    });

    expect(result.afterFailure.old).toBe(401);
    expect(result.afterFailure.controls).toStrictEqual(KEPT_ATTEMPTS);
    expect(result.afterRetry.old).toBe(201);
    expect(result.afterRetry.controls).toStrictEqual(KEPT_ATTEMPTS);
    expect(result.more).toBe(true);
  });
});
