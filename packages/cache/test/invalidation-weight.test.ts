import { policyFromBuild, tagIdFor } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { controlFenceFloorInvalidations, queueControlFence } from '../src/scope/control-fences.ts';
import { foldsPast, raiseFoldedThrough } from '../src/scope/folded-invalidations.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { type CondemnationQuery, weighInvalidations } from '../src/scope/invalidation-weight.ts';
import type { InvalidationRow } from '../src/scope/rows.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope, planSeedEntries } from '../src/scope/seed.ts';
import { writeMeta } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { condemnationOf, viewHeld } from '../src/scope/tags.ts';

const NOW = 1_800_000_000_000;
const LARGE_HISTORY = 150_000;
const UNRELATED = 10_000;
const LIMITS = limitsOf(parseVars({}));
const QUERY: CondemnationQuery = { entryId: 'entry', tagIds: ['a', 'b'], afterRevision: 0 };

function inScope<T>(action: (storage: DurableObjectStorage, scopeId: string) => T | Promise<T>) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
    applySchema(state.storage.sql, []);
    return action(state.storage, scopeId);
  });
}

function row(revision: number, targetId: string, meaning = 'swr'): InvalidationRow {
  return {
    invalidation_id: `inv-${targetId}-${revision}`,
    revision,
    target_kind: 'tag',
    target_id: targetId,
    target_value: targetId,
    stale_at: 100 - revision,
    hard_expire_at: null,
    meaning,
    expire_seconds: null,
    cause: '{}',
    recorded_at: NOW,
  };
}

function insert(sql: SqlStorage, rows: readonly InvalidationRow[]): void {
  for (const item of rows) {
    sql.exec(
      `INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
        target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      item.invalidation_id,
      item.revision,
      item.target_kind,
      item.target_id,
      item.target_value,
      item.stale_at,
      item.hard_expire_at,
      item.meaning,
      item.expire_seconds,
      item.cause,
      item.recorded_at,
    );
  }
}

function inView(item: InvalidationRow, held: ReadonlyMap<string, number>): boolean {
  return item.target_kind === 'tag' && item.revision <= (held.get(item.target_id) ?? 0);
}

/** The previous small-row algorithm, including the original raw-row SQL predicate. */
function oldWeight(sql: SqlStorage, query: CondemnationQuery) {
  const retained = sql
    .exec<InvalidationRow>(
      `SELECT * FROM invalidations WHERE revision > ?
      AND ((target_kind = 'tag' AND target_id IN (SELECT value FROM json_each(?)))
        OR (target_kind = 'entry' AND target_id = ?)) ORDER BY revision`,
      query.afterRevision,
      JSON.stringify(query.tagIds),
      query.entryId,
    )
    .toArray();
  const persistent = [...foldsPast(sql, query.tagIds, query.afterRevision), ...retained];
  const held = query.held ?? new Map<string, number>();
  const afresh = new Map<string, number>();
  for (const item of persistent) {
    if (inView(item, held) && item.meaning === 'immediate') {
      afresh.set(
        item.target_id,
        Math.max(afresh.get(item.target_id) ?? item.revision, item.revision),
      );
    }
  }
  const condemning: InvalidationRow[] = [];
  let heldThrough = 0;
  for (const item of persistent) {
    const excused =
      inView(item, held) &&
      (item.meaning === 'immediate' ||
        (afresh.get(item.target_id) ?? item.revision) > item.revision);
    if (excused) heldThrough = Math.max(heldThrough, item.revision);
    else condemning.push(item);
  }
  return {
    condemned: condemnationOf(condemning),
    immediate: condemning.some((item) => item.meaning === 'immediate'),
    heldThrough,
  };
}

function weight(sql: SqlStorage, query: CondemnationQuery) {
  const result = weighInvalidations(sql, query);
  return {
    condemned: condemnationOf(result.condemning),
    immediate: result.condemning.some((item) => item.meaning === 'immediate'),
    heldThrough: result.heldThrough,
  };
}

function mixedRows(): InvalidationRow[] {
  return [
    row(2, 'a'),
    row(5, 'a', 'immediate'),
    row(8, 'a'),
    { ...row(10, 'b', 'immediate'), hard_expire_at: 0 },
    { ...row(12, 'entry'), target_kind: 'entry' },
    row(99, 'unrelated', 'immediate'),
  ];
}

function fold(sql: SqlStorage): void {
  sql.exec(
    `INSERT INTO folded_invalidations (tag_id, revision, meaning, latest_immediate_revision,
      earliest_stale_at, latest_stale_at, earliest_hard_expire_at, folded)
     VALUES ('a', 12, 'swr', 6, 3, 30, 7, 9)`,
  );
  raiseFoldedThrough(sql, { revision: 12, staleAt: 30 });
}

/** SQL generates distinct rows without serializing or allocating a JavaScript row graph. */
function bulk(sql: SqlStorage, tagId: string, count: number): void {
  sql.exec(
    `WITH digit(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
     numbers(n) AS (
       SELECT a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n + 100000*f.n
       FROM digit a, digit b, digit c, digit d, digit e, digit f LIMIT ?
     )
     INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
       target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
     SELECT ? || n, 1, 'tag', ?, NULL, 40, NULL, 'swr', NULL, '{}', ? FROM numbers`,
    count,
    `bulk-${tagId}-`,
    tagId,
    NOW,
  );
}

function observedWeight(sql: SqlStorage, query: CondemnationQuery) {
  const exec = sql.exec.bind(sql);
  const scans: { query: string; bindings: SqlStorageValue[]; read: number }[] = [];
  const spy = vi
    .spyOn(sql, 'exec')
    .mockImplementation((statement: string, ...bindings: SqlStorageValue[]) => {
      const cursor = exec(statement, ...bindings);
      if (statement.startsWith('WITH input(after_revision')) {
        scans.push({
          query: statement,
          bindings,
          get read() {
            return cursor.rowsRead;
          },
        });
      }
      return cursor;
    });
  try {
    const result = weighInvalidations(sql, query);
    return { result, scans: scans.map((scan) => ({ ...scan })) };
  } finally {
    spy.mockRestore();
  }
}

function revisions(rows: readonly Pick<InvalidationRow, 'revision'>[]): number[] {
  return rows.map((item) => item.revision);
}

function queryPlan(
  sql: SqlStorage,
  scan: { query: string; bindings: SqlStorageValue[] },
): string[] {
  return Array.from(
    sql.exec<{ detail: string }>(`EXPLAIN QUERY PLAN ${scan.query}`, ...scan.bindings),
    (item) => item.detail,
  );
}

function readCounts(scans: readonly { read: number }[]): number[] {
  return scans.map((item) => item.read);
}

function seed(scopeId: string): SeedEntryInput {
  return {
    descriptor: { kind: 'app-page', route: '/', pathname: '/' },
    groupInstanceId: null,
    generation: {
      generationId: createId('gen'),
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: {},
      tags: [{ kind: 'next-explicit', value: scopeId }],
      dependencyCoverage: 'complete',
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
    },
  };
}

describe('weighing retained invalidations inside SQLite', () => {
  it.each([
    { entries: undefined },
    { entries: [] },
    { entries: [['a', 2]] },
    { entries: [['a', 5]] },
    { entries: [['a', 8]] },
    {
      entries: [
        ['a', 8],
        ['b', 10],
      ],
    },
  ] as const)(
    'preserves the old mixed tag and entry verdict for held view $entries',
    async ({ entries }) => {
      const result = await inScope((storage) => {
        const { sql } = storage;
        insert(sql, mixedRows());
        const query = {
          ...QUERY,
          held: entries === undefined ? undefined : new Map<string, number>(entries),
        };
        return { actual: weight(sql, query), previous: oldWeight(sql, query) };
      });

      expect(result.actual).toStrictEqual(result.previous);
      expect(result.actual.condemned?.revision).toBe(12);
    },
  );

  it('returns an empty summary without creating a zero deadline', async () => {
    const result = await inScope((storage) => weight(storage.sql, QUERY));

    expect(result).toStrictEqual({ condemned: null, immediate: false, heldThrough: 0 });
  });

  it.each([null, 0])(
    'preserves the %j hard deadline independently of the maximum revision',
    async (hard) => {
      const result = await inScope((storage) => {
        insert(storage.sql, [
          { ...row(2, 'a', 'immediate'), stale_at: 1, hard_expire_at: hard },
          row(20, 'a'),
        ]);
        return weight(storage.sql, QUERY);
      });

      expect(result).toStrictEqual({
        condemned: { revision: 20, staleAt: 1, ...(hard !== null && { hardExpireAt: 0 }) },
        immediate: true,
        heldThrough: 0,
      });
    },
  );

  it('clips the held view and leaves its latest SWR condemning', async () => {
    const result = await inScope((storage) => {
      insert(storage.sql, mixedRows());
      const held = viewHeld({ observedTagRevision: 5, heldTagRevisions: { shared: 8 } }, [
        { tagId: 'a', kind: 'next-explicit', value: 'shared' },
      ]);
      return weight(storage.sql, { ...QUERY, entryId: 'none', tagIds: ['a'], held });
    });

    expect(result).toStrictEqual({
      condemned: { revision: 8, staleAt: 92 },
      immediate: false,
      heldThrough: 5,
    });
  });

  it.each([undefined, 5, 6, 12, 15])(
    'weighs the fold latest immediate beside later raw history at held revision %j',
    async (revision) => {
      const result = await inScope((storage) => {
        fold(storage.sql);
        insert(storage.sql, [row(15, 'a', 'immediate')]);
        const query = {
          ...QUERY,
          tagIds: ['a'],
          held: revision === undefined ? undefined : new Map([['a', revision]]),
        };
        return {
          folds: revisions(foldsPast(storage.sql, ['a'], 0)),
          actual: weight(storage.sql, query),
          previous: oldWeight(storage.sql, query),
        };
      });

      expect(result.folds).toStrictEqual([12, 6]);
      expect(result.actual).toStrictEqual(result.previous);
    },
  );

  it.each([5, 6, 12, 15])(
    'excludes raw and folded revisions through %i before judging the held view',
    async (afterRevision) => {
      const result = await inScope((storage) => {
        fold(storage.sql);
        insert(storage.sql, [
          row(5, 'a', 'immediate'),
          row(15, 'a', 'immediate'),
          { ...row(13, 'entry'), target_kind: 'entry' },
        ]);
        const query = { ...QUERY, tagIds: ['a'], afterRevision, held: new Map([['a', 6]]) };
        return { actual: weight(storage.sql, query), previous: oldWeight(storage.sql, query) };
      });

      expect(result.actual).toStrictEqual(result.previous);
      expect(result.actual.heldThrough).toBe(afterRevision === 5 ? 6 : 0);
      expect(result.actual.condemned?.revision ?? null).toBe(afterRevision === 15 ? null : 15);
    },
  );

  it('keeps the conservative fold deadline when its synthetic immediate is held', async () => {
    const result = await inScope((storage) => {
      fold(storage.sql);
      return weight(storage.sql, { ...QUERY, tagIds: ['a'], held: new Map([['a', 12]]) });
    });

    expect(result).toStrictEqual({
      condemned: { revision: 12, staleAt: 3, hardExpireAt: 7 },
      immediate: false,
      heldThrough: 6,
    });
  });

  it('lets a held raw immediate excuse an earlier folded SWR', async () => {
    const result = await inScope((storage) => {
      fold(storage.sql);
      insert(storage.sql, [row(15, 'a', 'immediate')]);
      return weight(storage.sql, { ...QUERY, tagIds: ['a'], held: new Map([['a', 15]]) });
    });

    expect(result).toStrictEqual({ condemned: null, immediate: false, heldThrough: 15 });
  });

  it('appends private fences after held excusal and keeps the collected floor refusing admission', async () => {
    const result = await inScope((storage) => {
      const item = { ...row(5, 'a', 'immediate'), hard_expire_at: 0 };
      insert(storage.sql, [item]);
      queueControlFence(
        storage.sql,
        {
          tagId: 'a',
          kind: 'next-explicit',
          value: 'a',
          revision: 7,
          staleAt: 2,
          hardExpireAt: 0,
          meaning: 'immediate',
        },
        { ...item, revision: 7 },
      );
      const query = { ...QUERY, tagIds: ['a'], held: new Map([['a', 10]]) };
      const fenced = weight(storage.sql, query);
      writeMeta(
        storage.sql,
        'control_tag_fence_floor',
        JSON.stringify({ revision: 9, timestamp: 1 }),
      );
      return {
        fenced,
        floor: revisions(controlFenceFloorInvalidations(storage.sql, query)),
        afterFloor: weight(storage.sql, query),
      };
    });

    expect(result).toStrictEqual({
      fenced: {
        condemned: { revision: 7, staleAt: 2, hardExpireAt: 0 },
        immediate: true,
        heldThrough: 5,
      },
      floor: [9],
      afterFloor: {
        condemned: { revision: 9, staleAt: 1, hardExpireAt: 0 },
        immediate: true,
        heldThrough: 5,
      },
    });
  });

  it.each([false, true])(
    'uses target predicates for unrelated retained history, held=%j',
    async (held) => {
      const result = await inScope((storage) => {
        const { sql } = storage;
        insert(sql, mixedRows());
        bulk(sql, 'other-target', UNRELATED);
        const query = { ...QUERY, held: held ? new Map([['a', 5]]) : undefined };
        const observed = observedWeight(sql, query);
        const scan = observed.scans[0];
        if (scan === undefined) throw new Error('the real aggregate must be observed');
        const plan = queryPlan(sql, scan);
        return {
          scans: readCounts(observed.scans),
          plan,
          verdict: weight(sql, query),
          previous: oldWeight(sql, query),
        };
      });

      expect(result.scans).toHaveLength(1);
      expect(result.scans[0]).toBeLessThan(UNRELATED);
      expect(result.plan.some((detail) => detail.includes('invalidations_by_target'))).toBe(true);
      expect(result.verdict).toStrictEqual(result.previous);
    },
  );

  it('publishes a real build seed under all retained history without a JavaScript history array', async () => {
    const result = await inScope(async (storage, scopeId) => {
      const { sql } = storage;
      const tx = { sql, scopeId, limits: LIMITS, now: NOW, revision: 1, history: NO_HISTORY };
      applySeedScope(tx, {
        scope: {
          scopeId,
          organizationId: 'owner',
          projectId: 'site',
          environmentId: 'production',
          deploymentId: scopeId,
          keySchemaVersion: 1,
          buildId: 'build',
        },
      });
      const tagId = await tagIdFor(scopeId, 'next-explicit', scopeId);
      bulk(sql, tagId, LARGE_HISTORY);
      insert(sql, [{ ...row(20, tagId), stale_at: 1, hard_expire_at: 0 }]);
      const apply = await planSeedEntries(
        { ...tx, revision: 21 },
        { scopeId, batchIndex: 0, entries: [seed(scopeId)] },
      );
      const answer = storage.transactionSync(apply);
      return {
        answer,
        generation: sql
          .exec<{ condemned: string; source: string }>('SELECT condemned, source FROM generations')
          .one(),
        retained: sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM invalidations').one()
          .count,
      };
    });

    expect(result.answer).toMatchObject({ inserted: 1, refused: [] });
    expect(result.generation).toStrictEqual({
      source: 'build',
      condemned: JSON.stringify({ revision: 20, staleAt: 1, hardExpireAt: 0 }),
    });
    expect(result.retained).toBe(LARGE_HISTORY + 1);
  }, 120_000);
});
