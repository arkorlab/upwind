import { MAX_TAG_LENGTH, policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope, planSeedEntries } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';
import type { TxInput } from '../src/scope/tx.ts';

const NOW = 1_800_000_000_000;
const COLLISION = 'the build generation id is already in use';

function entry(pathname: string, generationId: string): SeedEntryInput {
  return {
    descriptor: { kind: 'app-page', route: pathname, pathname },
    groupInstanceId: null,
    generation: {
      generationId,
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: {},
      tags: [],
      dependencyCoverage: 'complete',
      outputs: [
        {
          representationKey: 'html',
          pathname,
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: null,
          artifacts: [],
        },
      ],
    },
  };
}

function distinctEntries(count: number): SeedEntryInput[] {
  return Array.from({ length: count }, (_, index) => entry(`/p${index}`, `gen${index}`));
}

function inScope<T>(action: (tx: TxInput, storage: DurableObjectStorage) => T | Promise<T>) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
    applySchema(state.storage.sql, []);
    const tx: TxInput = {
      sql: state.storage.sql,
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
    return action({ ...tx, revision: 2 }, state.storage);
  });
}

async function seed(
  tx: TxInput,
  storage: DurableObjectStorage,
  entries: readonly SeedEntryInput[],
) {
  const apply = await planSeedEntries(tx, {
    scopeId: tx.scopeId,
    batchIndex: 0,
    entries: [...entries],
  });
  const result = storage.transactionSync(apply);
  if (!('inserted' in result)) throw new Error('the fixture seed was unexpectedly refused');
  return result;
}

function current(tx: TxInput) {
  return tx.sql
    .exec<{ pathname: string; generation: string }>(
      `SELECT pathname, current_generation_id AS generation FROM entries ORDER BY pathname`,
    )
    .toArray();
}

function stateOf(tx: TxInput) {
  return tx.sql
    .exec<{ revision: number; entry_count: number; body_bytes: number }>(
      `SELECT revision, entry_count, body_bytes FROM scope`,
    )
    .toArray()[0];
}

describe('scope-wide build generation identities', () => {
  it('refuses a later collision without rolling back unrelated entries', async () => {
    await inScope(async (tx, storage) => {
      const a = entry('/a', 'shared');
      const b = entry('/b', 'shared');
      const c = entry('/c', 'independent');
      const result = await seed(tx, storage, [a, b, c]);

      expect(result).toStrictEqual({
        inserted: 2,
        skipped: 0,
        refused: [{ descriptor: b.descriptor, reason: COLLISION }],
        revision: 2,
      });
      expect(current(tx)).toStrictEqual([
        { pathname: '/a', generation: 'shared' },
        { pathname: '/c', generation: 'independent' },
      ]);
      expect(stateOf(tx)).toStrictEqual({ revision: 2, entry_count: 2, body_bytes: 0 });
    });
  });

  it('makes the same colliding batch retry stable', async () => {
    await inScope(async (tx, storage) => {
      const entries = [entry('/a', 'shared'), entry('/b', 'shared'), entry('/c', 'independent')];
      await seed(tx, storage, entries);
      const result = await seed({ ...tx, revision: 3 }, storage, entries);

      expect(result).toMatchObject({
        inserted: 0,
        skipped: 2,
        refused: [{ descriptor: entries[1]?.descriptor, reason: COLLISION }],
        revision: 2,
      });
      expect(current(tx)).toHaveLength(2);
      expect(stateOf(tx)).toStrictEqual({ revision: 2, entry_count: 2, body_bytes: 0 });
    });
  });

  it('protects an earlier batch while another new entry proceeds', async () => {
    await inScope(async (tx, storage) => {
      await seed(tx, storage, [entry('/a', 'shared')]);
      const b = entry('/b', 'shared');
      const result = await seed({ ...tx, revision: 3 }, storage, [b, entry('/c', 'independent')]);

      expect(result).toMatchObject({
        inserted: 1,
        skipped: 0,
        refused: [{ descriptor: b.descriptor, reason: COLLISION }],
        revision: 3,
      });
      expect(current(tx)).toStrictEqual([
        { pathname: '/a', generation: 'shared' },
        { pathname: '/c', generation: 'independent' },
      ]);
      expect(stateOf(tx)?.entry_count).toBe(2);
    });
  });

  it('does not advance a revision when every new entry collides', async () => {
    await inScope(async (tx, storage) => {
      await seed(tx, storage, [entry('/a', 'shared')]);
      const b = entry('/b', 'shared');
      const result = await seed({ ...tx, revision: 3 }, storage, [b]);

      expect(result).toStrictEqual({
        inserted: 0,
        skipped: 0,
        refused: [{ descriptor: b.descriptor, reason: COLLISION }],
        revision: 2,
      });
      expect(current(tx)).toStrictEqual([{ pathname: '/a', generation: 'shared' }]);
      expect(stateOf(tx)).toStrictEqual({ revision: 2, entry_count: 1, body_bytes: 0 });
    });
  });

  it('does not reserve the id of an already refused entry', async () => {
    await inScope(async (tx, storage) => {
      const first = entry('/invalid', 'shared');
      const invalid: SeedEntryInput = {
        ...first,
        generation: {
          ...first.generation,
          tags: [{ kind: 'next-explicit', value: 'x'.repeat(MAX_TAG_LENGTH + 1) }],
        },
      };
      const result = await seed(tx, storage, [invalid, entry('/valid', 'shared')]);

      expect(result.inserted).toBe(1);
      expect(result.refused).toHaveLength(1);
      expect(result.refused[0]?.descriptor).toStrictEqual(invalid.descriptor);
      expect(result.refused[0]?.reason).toContain('longer than');
      expect(current(tx)).toStrictEqual([{ pathname: '/valid', generation: 'shared' }]);
    });
  });

  it('keeps duplicate-entry skipping separate from generation reservations', async () => {
    await inScope(async (tx, storage) => {
      const result = await seed(tx, storage, [entry('/a', 'first'), entry('/a', 'unused')]);
      const later = await seed({ ...tx, revision: 3 }, storage, [entry('/b', 'unused')]);

      expect(result).toMatchObject({ inserted: 1, skipped: 1, refused: [] });
      expect(later).toMatchObject({ inserted: 1, skipped: 0, refused: [] });
      expect(current(tx)).toStrictEqual([
        { pathname: '/a', generation: 'first' },
        { pathname: '/b', generation: 'unused' },
      ]);
    });
  });

  it('keeps the existing all-or-none entry quota and a batch above 100 ids', async () => {
    await inScope(async (tx, storage) => {
      const entries = distinctEntries(101);
      const limited = { ...tx, limits: { ...tx.limits, entriesPerScope: 1 } };
      const apply = await planSeedEntries(limited, {
        scopeId: tx.scopeId,
        batchIndex: 0,
        entries,
      });

      expect(storage.transactionSync(apply)).toMatchObject({ code: 'quota_exceeded' });
      expect(current(tx)).toStrictEqual([]);
      expect(stateOf(tx)).toStrictEqual({ revision: 1, entry_count: 0, body_bytes: 0 });

      const result = await seed(tx, storage, entries);

      expect(result).toMatchObject({ inserted: 101, skipped: 0, refused: [], revision: 2 });
      expect(current(tx)).toHaveLength(101);
      expect(stateOf(tx)).toStrictEqual({ revision: 2, entry_count: 101, body_bytes: 0 });
    });
  });
});
