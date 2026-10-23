import { createId } from '@stayingupwind/core/util';
import type { ScopePackReaders, SeedScopeInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import {
  compactRepairLocatorsEnabled,
  firstPackSchemaVersion,
} from '../src/scope/pack-capability.ts';
import { applySchema } from '../src/scope/schema.ts';
import { ScopeContext } from '../src/scope/scope-context.ts';
import { applySeedScope } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
function seed(scopeId: string): SeedScopeInput {
  return {
    scope: {
      scopeId,
      organizationId: 'owner',
      projectId: 'site',
      environmentId: 'production',
      deploymentId: scopeId,
      keySchemaVersion: 1,
      buildId: 'build',
    },
  };
}
function approval(scopeId: string): ScopePackReaders {
  const platformReader = { versionId: 'released-dual-reader', moduleSha256: 'f'.repeat(64) };
  return {
    schemaVersion: 2,
    rolloutId: 'audited-all-traffic-release',
    deploymentId: scopeId,
    buildId: 'build',
    platform: {
      edge: platformReader,
      authority: platformReader,
      gateway: platformReader,
      readGateway: platformReader,
    },
    consumers: [
      {
        name: 'app',
        mainModule: 'index.mjs',
        mainModuleSha256: 'a'.repeat(64),
        hostIdentity: 'reviewed-first-party-host',
        hostModuleSha256: 'f'.repeat(64),
      },
    ],
  };
}

function approvedSeed(scopeId: string): SeedScopeInput {
  return { ...seed(scopeId), generationPackReaders: JSON.stringify(approval(scopeId)) };
}

describe('immutable scope pack capability', () => {
  it('seals a verified new scope and hydrates it through the existing scope identity', async () => {
    const scopeId = createId('dpl');
    await runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
      const { sql } = state.storage;
      applySchema(sql, []);
      const tx = {
        sql,
        scopeId,
        now: NOW,
        revision: 1,
        limits: limitsOf(parseVars({})),
        history: NO_HISTORY,
      };

      expect(applySeedScope(tx, approvedSeed(scopeId)).kind).toBe('seeded');
      expect(compactRepairLocatorsEnabled(sql)).toBe(true);

      const context = new ScopeContext(state, NO_HISTORY);

      expect(context.buildId).toBe('build');
      expect(context.packSchemaVersion).toBe(2);
      expect(context.repairNamespace).toMatch(/^[0-9a-f]{32}$/u);
      expect(applySeedScope({ ...tx, revision: 2 }, seed(scopeId)).kind).toBe('already-seeded');
      expect(compactRepairLocatorsEnabled(sql)).toBe(true);
      expect(new ScopeContext(state, NO_HISTORY).repairNamespace).toBe(context.repairNamespace);
    });
  });

  it('never upgrades an already-seeded legacy scope after new readers are deployed', async () => {
    const scopeId = createId('dpl');
    await runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
      const { sql } = state.storage;
      applySchema(sql, []);
      const tx = {
        sql,
        scopeId,
        now: NOW,
        revision: 1,
        limits: limitsOf(parseVars({})),
        history: NO_HISTORY,
      };
      applySeedScope(tx, seed(scopeId));
      sql.exec('ALTER TABLE scope DROP COLUMN pack_schema_version');
      sql.exec('ALTER TABLE scope DROP COLUMN repair_namespace');

      expect(applySeedScope({ ...tx, revision: 2 }, approvedSeed(scopeId)).kind).toBe(
        'already-seeded',
      );
      expect(compactRepairLocatorsEnabled(sql)).toBe(false);
      expect(new ScopeContext(state, NO_HISTORY).packSchemaVersion).toBe(1);
    });
  });

  it('migrates only an empty old table on its first seed write', async () => {
    const scopeId = createId('dpl');
    await runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
      const { sql } = state.storage;
      applySchema(sql, []);
      sql.exec('ALTER TABLE scope DROP COLUMN pack_schema_version');
      sql.exec('ALTER TABLE scope DROP COLUMN repair_namespace');
      const tx = {
        sql,
        scopeId,
        now: NOW,
        revision: 1,
        limits: limitsOf(parseVars({})),
        history: NO_HISTORY,
      };

      expect(applySeedScope(tx, approvedSeed(scopeId)).kind).toBe('seeded');
      expect(compactRepairLocatorsEnabled(sql)).toBe(true);
    });
  });

  it.each([undefined, '', 'not JSON', '{}', 'true'])(
    'keeps legacy seeds for unverified metadata %j',
    (generationPackReaders) => {
      expect(firstPackSchemaVersion({ ...seed('deployment'), generationPackReaders })).toBe(1);
    },
  );

  it('requires the same deployment/build and an unambiguous consumer inventory', () => {
    const value = approval('other-deployment');

    expect(
      firstPackSchemaVersion({
        ...seed('deployment'),
        generationPackReaders: JSON.stringify(value),
      }),
    ).toBe(1);

    value.deploymentId = 'deployment';
    value.buildId = 'other-build';

    expect(
      firstPackSchemaVersion({
        ...seed('deployment'),
        generationPackReaders: JSON.stringify(value),
      }),
    ).toBe(1);

    value.buildId = 'build';
    value.consumers.push(value.consumers[0]!);

    expect(
      firstPackSchemaVersion({
        ...seed('deployment'),
        generationPackReaders: JSON.stringify(value),
      }),
    ).toBe(1);
  });
});
