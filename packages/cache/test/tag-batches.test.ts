import { deriveEntry, type GenerationTag, policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { planInvalidate } from '../src/scope/invalidations.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope, planSeedEntries } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { replaceEntryTags, type TagRef } from '../src/scope/tags.ts';

const NOW = 1_800_000_000_000;
const MAX_TAGS = 1024;
const ROWS_PER_INSERT = 50;
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function refsFor(count: number): TagRef[] {
  return Array.from({ length: count }, (_, index) => {
    const value = `tag_${String(index).padStart(4, '0')}`;
    return { tagId: value, kind: 'next-explicit', value };
  });
}

function inScope<T>(action: (storage: DurableObjectStorage, scopeId: string) => T | Promise<T>) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
    applySchema(state.storage.sql, []);
    return action(state.storage, scopeId);
  });
}

function tagsOf(sql: SqlStorage, entryId: string): string[] {
  return Array.from(
    sql.exec<{ tag_id: string }>(
      `SELECT tag_id FROM entry_tags WHERE entry_id = ? ORDER BY tag_id`,
      entryId,
    ),
    (row) => row.tag_id,
  );
}

function countedReplace(sql: SqlStorage, refs: readonly TagRef[]) {
  const exec = sql.exec.bind(sql);
  const bindingsPerStatement: number[] = [];
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query: string, ...bindings) => {
    bindingsPerStatement.push(bindings.length);
    return exec(query, ...(bindings as SqlStorageValue[]));
  });
  try {
    replaceEntryTags(sql, 'entry', refs);
    return bindingsPerStatement;
  } finally {
    spy.mockRestore();
  }
}

function seedOf(pathname: string, tags: readonly GenerationTag[]): SeedEntryInput {
  return {
    descriptor: { kind: 'app-page', route: pathname, pathname },
    groupInstanceId: null,
    generation: {
      generationId: createId('gen'),
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: {},
      tags: [...tags],
      dependencyCoverage: 'complete',
      outputs: [
        {
          representationKey: 'html',
          pathname,
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: 0,
          artifacts: [
            {
              role: 'html',
              sha256: EMPTY_SHA,
              byteLength: 0,
              contentType: 'text/html',
              encoding: 'identity',
              storageRef: 'build/empty',
            },
          ],
        },
      ],
    },
  };
}

describe('replacing the tags of a current generation', () => {
  it.each([0, 1, 49, 50, 51, MAX_TAGS])(
    'stores %i tags within SQLite parameter and statement bounds',
    async (count) => {
      const refs = refsFor(count);
      const result = await inScope((storage) => {
        const { sql } = storage;
        sql.exec(
          `INSERT INTO entry_tags (tag_id,entry_id) VALUES ('old','entry'),('shared','other')`,
        );
        const bindings = storage.transactionSync(() => countedReplace(sql, refs));
        return { bindings, current: tagsOf(sql, 'entry'), other: tagsOf(sql, 'other') };
      });

      expect(result.current).toStrictEqual(refs.map((ref) => ref.tagId));
      expect(result.other).toStrictEqual(['shared']);
      expect(result.bindings).toHaveLength(1 + Math.ceil(count / ROWS_PER_INSERT));
      expect(Math.max(...result.bindings)).toBeLessThanOrEqual(100);
    },
  );

  it('keeps shared and duplicate references once across insert boundaries', async () => {
    const refs = refsFor(101);
    const repeated = [...refs, ...refs.slice(0, 2)];
    const result = await inScope((storage) => {
      const { sql } = storage;
      replaceEntryTags(sql, 'other', refs.slice(0, 2));
      const bindings = storage.transactionSync(() => countedReplace(sql, repeated));
      return { bindings, current: tagsOf(sql, 'entry'), other: tagsOf(sql, 'other') };
    });

    expect(result.current).toStrictEqual(refs.map((ref) => ref.tagId));
    expect(result.other).toStrictEqual(refs.slice(0, 2).map((ref) => ref.tagId));
    expect(result.bindings).toHaveLength(4);
  });

  it('rolls the delete and earlier inserts back if a later insert fails', async () => {
    const result = await inScope((storage) => {
      const { sql } = storage;
      sql.exec(
        `INSERT INTO entry_tags (tag_id,entry_id) VALUES ('old','entry'),('shared','other')`,
      );
      sql.exec(`CREATE TRIGGER reject_tag BEFORE INSERT ON entry_tags
        WHEN NEW.tag_id = 'tag_0050' BEGIN SELECT RAISE(ABORT,'refused tag'); END`);

      expect(() => {
        storage.transactionSync(() => {
          replaceEntryTags(sql, 'entry', refsFor(MAX_TAGS));
        });
      }).toThrow('refused tag');

      return { current: tagsOf(sql, 'entry'), other: tagsOf(sql, 'other') };
    });

    expect(result).toStrictEqual({ current: ['old'], other: ['shared'] });
  });

  it('invalidates every current entry sharing a tag from the final batch, at one revision', async () => {
    const tags = refsFor(MAX_TAGS).map(({ kind, value }) => ({ kind, value }));
    const shared = tags.slice(-1);
    const result = await inScope(async (storage, scopeId) => {
      const { sql } = storage;
      const tx = {
        sql,
        scopeId,
        now: NOW,
        revision: 1,
        limits: limitsOf(parseVars({})),
        history: NO_HISTORY,
      };
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
      const entries = [
        seedOf('/a', tags),
        seedOf('/b', shared),
        seedOf('/c', [{ kind: 'next-explicit', value: 'other' }]),
      ];
      const apply = await planSeedEntries(
        { ...tx, revision: 2 },
        { scopeId, batchIndex: 0, entries },
      );
      const seeded = storage.transactionSync(apply);
      const expectedIds = await Promise.all(
        entries.slice(0, 2).map((entry) => deriveEntry(scopeId, entry.descriptor)),
      );
      const invalidate = await planInvalidate(
        { ...tx, revision: 3 },
        { tags: shared.map(({ value }) => ({ value })), cause: { source: 'control' } },
      );
      const invalidated = storage.transactionSync(invalidate);
      return {
        seeded,
        invalidated,
        expectedIds: expectedIds.map((entry) => entry.entryId),
        entries: sql
          .exec<{
            pathname: string;
            record_revision: number;
            tombstone_revision: number | null;
            regeneration: string;
          }>(
            `SELECT pathname,record_revision,tombstone_revision,regeneration FROM entries ORDER BY pathname`,
          )
          .toArray(),
        revision: sql.exec<{ revision: number }>(`SELECT revision FROM scope`).one().revision,
      };
    });

    expect(result.seeded).toMatchObject({ inserted: 3, skipped: 0, refused: [], revision: 2 });
    expect(result.invalidated).toMatchObject({
      revision: 3,
      affectedEntryIds: expect.arrayContaining(result.expectedIds),
    });
    expect(result.revision).toBe(3);
    expect(result.entries).toStrictEqual([
      { pathname: '/a', record_revision: 3, tombstone_revision: 3, regeneration: 'queued' },
      { pathname: '/b', record_revision: 3, tombstone_revision: 3, regeneration: 'queued' },
      { pathname: '/c', record_revision: 2, tombstone_revision: null, regeneration: 'idle' },
    ]);
  });
});
