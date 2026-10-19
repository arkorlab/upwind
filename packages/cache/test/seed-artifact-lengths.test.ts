import { MAX_TAG_LENGTH, policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { SeedArtifact, SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { referenceArtifact } from '../src/scope/artifacts.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope, planSeedEntries } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';
import type { TxInput } from '../src/scope/tx.ts';

const NOW = 1_800_000_000_000;
const LENGTH_CONFLICT = 'the build gives different byte lengths for the same artifact SHA';

function artifact(index: number, byteLength: number): SeedArtifact {
  return {
    sha256: index.toString(16).padStart(64, '0'),
    byteLength,
    role: 'rsc',
    contentType: 'text/x-component',
    encoding: 'identity',
    storageRef: `blob/${index}`,
  };
}

function entry(
  pathname: string,
  generationId: string,
  artifacts: readonly SeedArtifact[],
): SeedEntryInput {
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
          artifacts: [...artifacts],
        },
      ],
    },
  };
}

function inScope<T>(
  action: (tx: TxInput, storage: DurableObjectStorage, events: string[]) => T | Promise<T>,
) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
    applySchema(state.storage.sql, []);
    const events: string[] = [];
    const tx: TxInput = {
      sql: state.storage.sql,
      scopeId,
      now: NOW,
      revision: 1,
      limits: limitsOf(parseVars({})),
      history: {
        ...NO_HISTORY,
        append(_context, event) {
          events.push(event.kind);
        },
      },
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
    events.length = 0;
    return action({ ...tx, revision: 2 }, state.storage, events);
  });
}

async function seed(tx: TxInput, storage: DurableObjectStorage, entries: SeedEntryInput[]) {
  const apply = await planSeedEntries(tx, { scopeId: tx.scopeId, batchIndex: 0, entries });
  const result = storage.transactionSync(apply);
  if (!('inserted' in result)) throw new Error('the fixture seed was unexpectedly refused');
  return result;
}

function artifactsOf(tx: TxInput) {
  return tx.sql
    .exec<{ sha256: string; byte_length: number; refs: number; owned: number }>(
      `SELECT sha256,byte_length,refs,owned FROM artifacts ORDER BY sha256`,
    )
    .toArray();
}

function current(tx: TxInput) {
  return tx.sql
    .exec<{ pathname: string; generation: string }>(
      `SELECT pathname,current_generation_id AS generation FROM entries ORDER BY pathname`,
    )
    .toArray();
}

function scopeOf(tx: TxInput) {
  return tx.sql
    .exec<{ revision: number; entry_count: number; body_bytes: number }>(
      `SELECT revision,entry_count,body_bytes FROM scope`,
    )
    .one();
}

describe('canonical artifact lengths during fresh build seeds', () => {
  it('refuses a conflicting entry while unrelated entries and their history progress', async () => {
    await inScope(async (tx, storage, events) => {
      const first = entry('/first', 'first', [artifact(1, 3)]);
      const bad = entry('/conflict', 'bad', [artifact(1, 9)]);
      const other = entry('/other', 'other', [artifact(2, 1)]);
      const result = await seed(tx, storage, [first, bad, other]);

      expect(result).toStrictEqual({
        inserted: 2,
        skipped: 0,
        refused: [{ descriptor: bad.descriptor, reason: LENGTH_CONFLICT }],
        revision: 2,
      });
      expect(current(tx)).toStrictEqual([
        { pathname: '/first', generation: 'first' },
        { pathname: '/other', generation: 'other' },
      ]);
      expect(artifactsOf(tx)).toStrictEqual([
        { sha256: artifact(1, 3).sha256, byte_length: 3, refs: 1, owned: 0 },
        { sha256: artifact(2, 1).sha256, byte_length: 1, refs: 1, owned: 0 },
      ]);
      expect(events).toStrictEqual([
        'entry.created',
        'generation.committed',
        'entry.created',
        'generation.committed',
      ]);
    });
  });

  it.each([false, true])(
    'protects an existing canonical length even with zero refs, owned=%s',
    async (owned) => {
      await inScope(async (tx, storage, events) => {
        const canonical = { ...artifact(1, 3), artifactId: 'canonical', owned };
        referenceArtifact(tx.sql, canonical, NOW);
        tx.sql.exec(`UPDATE artifacts SET refs=0 WHERE sha256=?`, canonical.sha256);
        const bad = entry('/conflict', 'bad', [artifact(1, 9)]);
        const before = artifactsOf(tx);
        const result = await seed(tx, storage, [bad]);

        expect(result).toStrictEqual({
          inserted: 0,
          skipped: 0,
          refused: [{ descriptor: bad.descriptor, reason: LENGTH_CONFLICT }],
          revision: 1,
        });
        expect(artifactsOf(tx)).toStrictEqual(before);
        expect(current(tx)).toStrictEqual([]);
        expect(scopeOf(tx)).toStrictEqual({ revision: 1, entry_count: 0, body_bytes: 0 });
        expect(events).toStrictEqual([]);
      });
    },
  );

  it('keeps a prior batch canonical while a matching new entry proceeds', async () => {
    await inScope(async (tx, storage) => {
      await seed(tx, storage, [entry('/first', 'first', [artifact(1, 3)])]);
      const bad = entry('/bad', 'bad', [artifact(1, 9)]);
      const result = await seed({ ...tx, revision: 3 }, storage, [
        bad,
        entry('/matching', 'matching', [artifact(1, 3)]),
      ]);

      expect(result).toStrictEqual({
        inserted: 1,
        skipped: 0,
        refused: [{ descriptor: bad.descriptor, reason: LENGTH_CONFLICT }],
        revision: 3,
      });
      expect(current(tx)).toStrictEqual([
        { pathname: '/first', generation: 'first' },
        { pathname: '/matching', generation: 'matching' },
      ]);
      expect(artifactsOf(tx)).toStrictEqual([
        { sha256: artifact(1, 3).sha256, byte_length: 3, refs: 2, owned: 0 },
      ]);
    });
  });

  it('does not reserve a digest or generation id from a conflicting plan', async () => {
    await inScope(async (tx, storage) => {
      const bad = entry('/bad', 'shared', [artifact(1, 3), artifact(1, 9), artifact(2, 7)]);
      const good = entry('/good', 'shared', [artifact(1, 9), artifact(2, 1)]);
      const result = await seed(tx, storage, [bad, good]);

      expect(result).toStrictEqual({
        inserted: 1,
        skipped: 0,
        refused: [{ descriptor: bad.descriptor, reason: LENGTH_CONFLICT }],
        revision: 2,
      });
      expect(current(tx)).toStrictEqual([{ pathname: '/good', generation: 'shared' }]);
      expect(artifactsOf(tx)).toStrictEqual([
        { sha256: artifact(1, 9).sha256, byte_length: 9, refs: 1, owned: 0 },
        { sha256: artifact(2, 1).sha256, byte_length: 1, refs: 1, owned: 0 },
      ]);
    });
  });

  it('retains tag refusal priority and reserves none of its proposed lengths', async () => {
    await inScope(async (tx, storage) => {
      const proposed = entry('/bad-tag', 'shared', [artifact(1, 3)]);
      const bad: SeedEntryInput = {
        ...proposed,
        generation: {
          ...proposed.generation,
          tags: [{ kind: 'next-explicit', value: 'x'.repeat(MAX_TAG_LENGTH + 1) }],
        },
      };
      const result = await seed(tx, storage, [bad, entry('/good', 'shared', [artifact(1, 9)])]);

      expect(result).toMatchObject({ inserted: 1, skipped: 0, revision: 2 });
      expect(result.refused).toHaveLength(1);
      expect(result.refused[0]?.reason).toContain('longer than');
      expect(artifactsOf(tx)).toStrictEqual([
        { sha256: artifact(1, 9).sha256, byte_length: 9, refs: 1, owned: 0 },
      ]);
    });
  });

  it("retains generation collision priority without reserving that plan's digest", async () => {
    await inScope(async (tx, storage) => {
      const bad = entry('/collision', 'shared', [artifact(1, 3), artifact(1, 9)]);
      const result = await seed(tx, storage, [
        entry('/first', 'shared', []),
        bad,
        entry('/good', 'good', [artifact(1, 9)]),
      ]);

      expect(result.refused).toStrictEqual([
        {
          descriptor: bad.descriptor,
          reason: 'the build generation id is already in use',
        },
      ]);
      expect(result.inserted).toBe(2);
      expect(artifactsOf(tx)).toStrictEqual([
        { sha256: artifact(1, 9).sha256, byte_length: 9, refs: 1, owned: 0 },
      ]);
    });
  });

  it('keeps equal lengths legal across roles, types, locations and a zero-byte artifact', async () => {
    await inScope(async (tx, storage) => {
      const first = artifact(1, 0);
      const later: SeedArtifact = {
        ...first,
        role: 'html',
        contentType: 'text/html',
        storageRef: 'elsewhere',
      };
      const result = await seed(tx, storage, [
        entry('/a', 'a', [first]),
        entry('/b', 'b', [later]),
      ]);

      expect(result).toMatchObject({ inserted: 2, refused: [] });
      expect(artifactsOf(tx)).toStrictEqual([
        { sha256: first.sha256, byte_length: 0, refs: 2, owned: 0 },
      ]);
    });
  });

  it('leaves the whole batch unchanged when the existing entry quota refuses it', async () => {
    await inScope(async (tx, storage, events) => {
      const limited = { ...tx, limits: { ...tx.limits, entriesPerScope: 1 } };
      const apply = await planSeedEntries(limited, {
        scopeId: tx.scopeId,
        batchIndex: 0,
        entries: [entry('/a', 'a', [artifact(1, 3)]), entry('/b', 'b', [artifact(2, 1)])],
      });
      const result = storage.transactionSync(apply);

      expect(result).toMatchObject({ kind: 'refused', code: 'quota_exceeded' });
      expect(current(tx)).toStrictEqual([]);
      expect(artifactsOf(tx)).toStrictEqual([]);
      expect(events).toStrictEqual([]);
      expect(scopeOf(tx)).toStrictEqual({ revision: 1, entry_count: 0, body_bytes: 0 });
    });
  });
});
