import { policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { insertGeneration } from '../src/scope/generations.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { applyRetention } from '../src/scope/retention.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const LIMITS = limitsOf(parseVars({}));
const CUTOFF = NOW - LIMITS.retainHistoryUnrecordedMs;

function addGeneration(sql: SqlStorage, id: string, prunedAt: number | null, published = false) {
  insertGeneration(sql, {
    generationId: id,
    entryId: 'entry',
    seq: 1,
    source: 'runtime',
    attemptId: null,
    cacheTimestamp: NOW,
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
  if (prunedAt !== null) {
    sql.exec(
      `UPDATE generations SET storage = 'pruned', pruned_at = ? WHERE generation_id = ?`,
      prunedAt,
      id,
    );
  }
  if (!published) {
    sql.exec(`UPDATE generations SET publication = 'superseded' WHERE generation_id = ?`, id);
  }
  for (const target of ['one', 'two']) {
    sql.exec(
      `INSERT INTO dependencies (owner_generation_id, target_kind, target_id, evidence, usage)
       VALUES (?, 'tag', ?, 'observed', 'body')`,
      id,
      target,
    );
  }
}

async function scopeForTest(count: number) {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await runInDurableObject(stub, (_instance, state) => {
    const { sql } = state.storage;
    applySchema(sql, []);
    applySeedScope(
      { sql, scopeId, limits: LIMITS, now: NOW, revision: 1, history: NO_HISTORY },
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
    for (let index = 0; index < count; index += 1) {
      addGeneration(sql, `old-${String(index).padStart(5, '0')}`, CUTOFF - 1);
    }
    addGeneration(sql, 'at-cutoff', CUTOFF);
    addGeneration(sql, 'recent', NOW);
    addGeneration(sql, 'published', CUTOFF - 1, true);
    for (let index = 0; index < 600; index += 1) {
      addGeneration(sql, `live-${index}`, null, true);
    }
  });
  return stub;
}

function remaining(sql: SqlStorage) {
  return {
    old: sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM generations WHERE generation_id LIKE 'old-%'`)
      .one().n,
    oldDependencies: sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM dependencies WHERE owner_generation_id LIKE 'old-%'`,
      )
      .one().n,
    controls: sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM dependencies WHERE owner_generation_id NOT LIKE 'old-%'`,
      )
      .one().n,
    orphans: sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM dependencies d WHERE NOT EXISTS (SELECT 1 FROM generations g WHERE g.generation_id = d.owner_generation_id)`,
      )
      .one().n,
  };
}

function page(storage: DurableObjectStorage) {
  const { sql } = storage;
  const exec = sql.exec.bind(sql);
  const reads: (() => number)[] = [];
  const bindingCounts: number[] = [];
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query: string, ...bindings) => {
    const cursor = exec(query, ...(bindings as SqlStorageValue[]));
    if (query.startsWith('DELETE FROM dependencies')) {
      reads.push(() => cursor.rowsRead);
      bindingCounts.push(bindings.length);
    }
    return cursor;
  });
  try {
    const plan = storage.transactionSync(() =>
      applyRetention({ sql, limits: LIMITS, now: NOW, history: NO_HISTORY }),
    );
    return {
      more: plan.more,
      reads: reads.map((read) => read()),
      bindingCounts,
      ...remaining(sql),
    };
  } finally {
    spy.mockRestore();
  }
}

describe('generation-owned dependency retention', () => {
  it.each([0, 1, 199, 200, 201])(
    'ages out one page from %i generations without scanning live owners',
    async (count) => {
      const stub = await scopeForTest(count);
      const result = await runInDurableObject(stub, (_instance, state) => page(state.storage));

      expect(result.old).toBe(Math.max(0, count - 200));
      expect(result.oldDependencies).toBe(result.old * 2);
      expect(result.controls).toBe(1206);
      expect(result.orphans).toBe(0);
      expect(result.more).toBe(count >= 200);
      expect(result.reads).toHaveLength(count === 0 ? 0 : Math.ceil(Math.min(count, 200) / 100));
      // Index/table work for the selected owners stays below even one scan of the retained rows.
      expect(result.reads.reduce((sum, value) => sum + value, 0)).toBeLessThan(result.controls);

      for (const bindings of result.bindingCounts) {
        expect(bindings).toBeLessThanOrEqual(100);
      }
    },
  );

  it('drains tied timestamps and then stops dependency cleanup on idle passes', async () => {
    const stub = await scopeForTest(401);
    const results = [];
    for (let index = 0; index < 4; index += 1) {
      results.push(await runInDurableObject(stub, (_instance, state) => page(state.storage)));
    }

    expect(results.map((result) => result.old)).toStrictEqual([201, 1, 0, 0]);
    expect(results.map((result) => result.more)).toStrictEqual([true, true, false, false]);
    expect(results.map((result) => result.reads.length)).toStrictEqual([2, 2, 1, 0]);

    for (const result of results) {
      expect(result.orphans).toBe(0);
      expect(result.controls).toBe(1206);
    }
  });

  it('rolls back generation deletion with a failed dependency cleanup and retries the same page', async () => {
    const stub = await scopeForTest(201);
    const result = await runInDurableObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      sql.exec(`CREATE TRIGGER refuse_dependency_delete BEFORE DELETE ON dependencies
        BEGIN SELECT RAISE(ABORT, 'dependency delete failed'); END`);

      expect(() => page(state.storage)).toThrow('dependency delete failed');

      const afterFailure = remaining(sql);
      sql.exec(`DROP TRIGGER refuse_dependency_delete`);
      return { afterFailure, afterRetry: page(state.storage) };
    });

    expect(result.afterFailure.old).toBe(201);
    expect(result.afterFailure.oldDependencies).toBe(402);
    expect(result.afterFailure.orphans).toBe(0);
    expect(result.afterRetry.old).toBe(1);
    expect(result.afterRetry.oldDependencies).toBe(2);
    expect(result.afterRetry.orphans).toBe(0);
    expect(result.afterRetry.controls).toBe(1206);
  });
});
