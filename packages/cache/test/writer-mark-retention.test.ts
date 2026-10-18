import { createId } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { createLogger } from '../src/logger.ts';
import { planSetData, WRITER_MARK_WINDOW_MS } from '../src/scope/data.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { blobStore } from '../src/scope/io.ts';
import { nextRetentionAt, runRetention } from '../src/scope/retention-run.ts';
import { applyRetention } from '../src/scope/retention.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope } from '../src/scope/seed.ts';
import { readRevision } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const LIMITS = limitsOf(parseVars({}));
const CUTOFF = NOW - WRITER_MARK_WINDOW_MS;

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
      mark(sql, `old-${index}`, CUTOFF - 1);
    }
    mark(sql, 'at-cutoff', CUTOFF);
    mark(sql, 'future', NOW + 1);
    for (let index = 0; index < 1200; index += 1) {
      mark(sql, `live-${index}`, NOW);
    }
  });
  return { stub, scopeId };
}

/** Marks outlive their entry, including an entry retention already reclaimed. */
function mark(sql: SqlStorage, writer: string, at: number): void {
  sql.exec(
    `INSERT INTO writer_marks (entry_id, writer, seq, generation_id, revision, marked_at)
     VALUES ('reclaimed-entry', ?, 2, 'later-generation', 1, ?)`,
    writer,
    at,
  );
}

function remaining(sql: SqlStorage) {
  return {
    old: sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM writer_marks WHERE marked_at < ?`, CUTOFF)
      .one().n,
    kept: sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM writer_marks WHERE marked_at >= ?`, CUTOFF)
      .one().n,
  };
}

function page(storage: DurableObjectStorage) {
  const { sql } = storage;
  const exec = sql.exec.bind(sql);
  const reads: (() => number)[] = [];
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query: string, ...bindings) => {
    const cursor = exec(query, ...(bindings as SqlStorageValue[]));
    if (query.startsWith('DELETE FROM writer_marks')) reads.push(() => cursor.rowsRead);
    return cursor;
  });
  try {
    const plan = storage.transactionSync(() =>
      applyRetention({ sql, limits: LIMITS, now: NOW, history: NO_HISTORY }),
    );
    return { more: plan.more, reads: reads.map((read) => read()), ...remaining(sql) };
  } finally {
    spy.mockRestore();
  }
}

describe('writer-order mark retention', () => {
  it.each([0, 1, 199, 200, 201])('deletes only one expired page from %i marks', async (count) => {
    const { stub } = await scopeForTest(count);
    const result = await runInDurableObject(stub, (_instance, state) => page(state.storage));

    expect(result.old).toBe(Math.max(0, count - 200));
    expect(result.kept).toBe(1202);
    expect(result.more).toBe(count >= 200);
    // The expiry index bounds work even with many marks still in the ordering window.
    expect(result.reads.reduce((sum, read) => sum + read, 0)).toBeLessThan(result.kept);
  });

  it('drains tied expiry pages through the existing one-second backlog alarm', async () => {
    const { stub, scopeId } = await scopeForTest(401);
    const pages = [];
    for (let index = 0; index < 3; index += 1) {
      pages.push(
        await runInDurableObject(stub, async (_instance, state) => {
          const { sql } = state.storage;
          await runRetention(
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
          return { next: nextRetentionAt(sql, NOW, WRITER_MARK_WINDOW_MS), ...remaining(sql) };
        }),
      );
    }

    expect(pages.map((result) => result.old)).toStrictEqual([201, 1, 0]);
    expect(pages.map((result) => result.next)).toStrictEqual([
      NOW + 1000,
      NOW + 1000,
      NOW + WRITER_MARK_WINDOW_MS,
    ]);
    expect(pages.map((result) => result.kept)).toStrictEqual([1202, 1202, 1202]);
  });

  it('keeps a live writer fencing its earlier write while expired marks drain', async () => {
    const { stub, scopeId } = await scopeForTest(401);
    await runInDurableObject(stub, async (_instance, state) => {
      const { sql } = state.storage;
      const input = {
        key: 'ordered',
        entry: {
          kind: 'data:fetch' as const,
          tags: [],
          stale: 60,
          timestamp: NOW,
          expire: 31_536_000,
          revalidate: 60,
          dependencyCoverage: 'complete' as const,
        },
        value: {
          sha256: 'a'.repeat(64),
          byteLength: 1,
          contentType: 'text/plain',
          storageRef: 'body/a',
        },
        order: { writer: 'current-writer', seq: 2 },
      };
      const tx = { sql, scopeId, limits: LIMITS, now: NOW, revision: 2, history: NO_HISTORY };
      const first = (await planSetData(tx, input))();

      expect(first).not.toHaveProperty('kind', 'refused');

      if (!('entryId' in first)) throw new Error('the data write was refused');
      page(state.storage);

      const earlier = (
        await planSetData(
          { ...tx, revision: 3 },
          {
            ...input,
            value: { ...input.value, sha256: 'b'.repeat(64), storageRef: 'body/b' },
            order: { writer: 'current-writer', seq: 1 },
          },
        )
      )();

      expect(earlier).toMatchObject({
        entryId: first.entryId,
        generationId: first.generationId,
        revision: 2,
        superseded: true,
      });
      expect(readRevision(sql)).toBe(2);
    });
  });

  it('rolls back an interrupted page and retries the same expired marks', async () => {
    const { stub } = await scopeForTest(201);
    await runInDurableObject(stub, (_instance, state) => {
      const { sql } = state.storage;
      sql.exec(`CREATE TRIGGER refuse_writer_delete BEFORE DELETE ON writer_marks
        BEGIN SELECT RAISE(ABORT, 'writer deletion failed'); END`);

      expect(() => page(state.storage)).toThrow('writer deletion failed');
      expect(remaining(sql)).toStrictEqual({ old: 201, kept: 1202 });

      sql.exec(`DROP TRIGGER refuse_writer_delete`);

      expect(page(state.storage)).toMatchObject({ old: 1, kept: 1202, more: true });
    });
  });
});
