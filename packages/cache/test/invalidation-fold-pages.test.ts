import { createId } from '@stayingupwind/core/util';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { foldInvalidations } from '../src/scope/invalidation-fold.ts';
import { applySchema } from '../src/scope/schema.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const OLD = 100;
const HEADS = 401;
const LIMITS = limitsOf(parseVars({}));

async function scopeForTest() {
  const stub = scopeStub(env, createId('dpl'));
  await runInDurableObject(stub, (_instance, state) => {
    const { sql } = state.storage;
    applySchema(sql, []);
    sql.exec(
      `INSERT INTO tags (tag_id, kind, value, revision, stale_at, hard_expire_at, meaning)
       VALUES ('shared', 'next-explicit', 'shared', 1000, ?, ?, 'immediate')`,
      OLD,
      OLD,
    );
    for (let revision = 1; revision <= HEADS; revision += 1) {
      const id = `protected-${String(revision).padStart(4, '0')}`;
      sql.exec(
        `INSERT INTO resource_heads (resource_id, event_id, version, tag, tag_revision, applied_at)
         VALUES (?, ?, 1, 'shared', ?, ?)`,
        id,
        id,
        revision,
        OLD,
      );
      sql.exec(
        `INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
           target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
         VALUES (?, ?, 'tag', 'shared', NULL, ?, ?, 'immediate', NULL, '{}', ?)`,
        id,
        revision,
        OLD,
        OLD,
        OLD,
      );
    }
    sql.exec(
      `INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
         target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
       VALUES ('unprotected', 900, 'tag', 'shared', NULL, ?, ?, 'immediate', NULL, '{}', ?)`,
      OLD + 1,
      OLD + 1,
      OLD + 1,
    );
  });
  return stub;
}

type Stub = Awaited<ReturnType<typeof scopeForTest>>;

async function fold(stub: Stub, now = NOW) {
  return runInDurableObject(stub, (_instance, state) => {
    const { sql } = state.storage;
    return state.storage.transactionSync(() => {
      const exec = sql.exec.bind(sql);
      const scans: { query: string; read: number }[] = [];
      const spy = vi.spyOn(sql, 'exec').mockImplementation((query: string, ...bindings) => {
        const cursor = exec(query, ...(bindings as SqlStorageValue[]));
        // Reading is synchronous; rowsRead is final once foldInvalidations consumes its cursor.
        if (query.includes('ORDER BY') && query.includes('FROM invalidations')) {
          scans.push({
            query,
            get read() {
              return cursor.rowsRead;
            },
          });
        }
        return cursor;
      });
      try {
        const more = foldInvalidations({ sql, limits: LIMITS, now });
        return {
          more,
          folded: sql
            .exec<{ count: number }>(
              `SELECT COALESCE(SUM(folded), 0) AS count FROM folded_invalidations`,
            )
            .one().count,
          kept: sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM invalidations`).one()
            .count,
          scans: scans.map((scan) => ({ ...scan })),
        };
      } finally {
        spy.mockRestore();
      }
    });
  });
}

describe('retention behind protected resource revisions', () => {
  it('builds its indexes only during retention, and rolls its position back with a failed transaction', async () => {
    const stub = await scopeForTest();
    const rolledBack = await runInDurableObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      const indexes = () => {
        return sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE name IN ('invalidations_to_fold', 'resource_heads_by_tag_revision')`,
          )
          .one().count;
      };
      const initial = indexes();
      const failure = new Error('an aborted retention transaction');
      try {
        state.storage.transactionSync(() => {
          foldInvalidations({ sql, limits: LIMITS, now: NOW });
          throw failure;
        });
      } catch (error) {
        if (error !== failure) throw error;
      }
      return {
        initial,
        after: indexes(),
        cursor: sql
          .exec(`SELECT value FROM meta WHERE key = 'invalidations_fold_cursor'`)
          .toArray(),
      };
    });
    const first = await fold(stub);
    const indexes = await runInDurableObject(stub, (_instance, state) => {
      return state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE name IN ('invalidations_to_fold', 'resource_heads_by_tag_revision')`,
        )
        .one().count;
    });

    expect(rolledBack).toStrictEqual({ initial: 0, after: 0, cursor: [] });
    expect(first).toMatchObject({ more: true, folded: 0, kept: HEADS + 1 });
    expect(indexes).toBe(2);
  });

  it('bounds each candidate page and resumes equal timestamps across an object restart', async () => {
    const stub = await scopeForTest();
    const first = await fold(stub);
    await evictDurableObject(stub);
    const second = await fold(stub);
    const last = await fold(stub);

    expect(first).toMatchObject({ more: true, folded: 0, kept: HEADS + 1 });
    expect(second).toMatchObject({ more: true, folded: 0, kept: HEADS + 1 });
    expect(last).toMatchObject({ more: false, folded: 1, kept: HEADS });

    // The candidate lookup itself includes the indexed head check, independently of fold/history reads.
    for (const page of [first, second, last]) {
      const candidates = page.scans.find((scan) => scan.query.includes('at_resource_head'));

      expect(candidates?.read).toBeLessThanOrEqual(401);
    }
  });

  it('revisits released heads and backdated insertions after the bounded pass wraps', async () => {
    const stub = await scopeForTest();
    await fold(stub);
    await runInDurableObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      sql.exec(
        `UPDATE resource_heads SET tag_revision = 1000 WHERE resource_id = 'protected-0001'`,
      );
      sql.exec(
        `INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
           target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
         VALUES ('backdated', 901, 'tag', 'shared', NULL, 1, 1, 'immediate', NULL, '{}', 1),
           ('new-head', 1000, 'tag', 'shared', NULL, 1, 1, 'immediate', NULL, '{}', 1)`,
      );
    });
    await fold(stub);
    const wrapped = await fold(stub);
    const revisited = await fold(stub);
    await fold(stub);
    const finished = await fold(stub);

    expect(wrapped).toMatchObject({ more: false, folded: 1 });
    expect(revisited).toMatchObject({ more: true, folded: 3 });
    expect(finished).toMatchObject({ more: false, folded: 3, kept: HEADS });

    const held = await runInDurableObject(stub, (_instance, state) => {
      return state.storage.sql
        .exec<{ invalidation_id: string }>(
          `SELECT invalidation_id FROM invalidations WHERE revision IN (1, 901, 1000)`,
        )
        .toArray();
    });

    expect(held).toStrictEqual([{ invalidation_id: 'new-head' }]);
  });

  it('finishes the original history window before starting on rows that aged into it', async () => {
    const stub = await scopeForTest();
    await fold(stub);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id,
           target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
         VALUES ('newly-old', 902, 'tag', 'shared', NULL, ?, ?, 'immediate', NULL, '{}', ?)`,
        NOW - LIMITS.retainHistoryMs + 1,
        NOW - LIMITS.retainHistoryMs + 1,
        NOW - LIMITS.retainHistoryMs + 1,
      );
    });
    await fold(stub, NOW + 10);
    const wrapped = await fold(stub, NOW + 10);
    await fold(stub, NOW + 10);
    await fold(stub, NOW + 10);
    const next = await fold(stub, NOW + 10);

    expect(wrapped).toMatchObject({ more: false, folded: 1, kept: HEADS + 1 });
    expect(next).toMatchObject({ more: false, folded: 2, kept: HEADS });
  });
});
