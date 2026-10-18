import { policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { identifyEntry, insertEntry, publishEntry } from '../src/scope/entries.ts';
import { insertGeneration } from '../src/scope/generations.ts';
import { type EventInput, NO_HISTORY } from '../src/scope/history.ts';
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
