import type { Prerender } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { seedRouteFor } from '@stayingupwind/host/bundle';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line import-x/no-relative-packages -- Tests share this fixture without publishing it.
import { SHARED_SHELL, shellBundle, taggedShell } from '../../host/test/shared-shell-fixture.ts';
import { limitsOf, parseVars } from '../src/env.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope, planSeedEntries } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;

async function inputFor(scopeId: string, prerender: Prerender) {
  const seeded = await seedRouteFor(shellBundle(prerender), prerender, {
    scopeId,
    generatedAt: NOW,
  });
  if (seeded === undefined) throw new Error('the output must seed');
  return seeded.input;
}

describe('a shared identity within the existing seed tag quota', () => {
  it.each([
    { tags: 1023, inserted: 2, refused: [], associations: 1024 },
    {
      tags: 1024,
      inserted: 1,
      refused: [
        {
          descriptor: {
            kind: 'app-page',
            route: SHARED_SHELL.route,
            pathname: SHARED_SHELL.pathname,
          },
          reason: 'the build left 1025 cache tags on the entry; a generation may carry 1024',
        },
      ],
      associations: 0,
    },
  ])('keeps $tags old tags and applies the existing per-entry result', async (example) => {
    const scopeId = createId('dpl');
    const snapshot = await runInDurableObject(scopeStub(env, scopeId), async (_instance, state) => {
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
      const primary = taggedShell(example.tags);
      const ordinary = {
        ...SHARED_SHELL,
        route: '/ordinary',
        pathname: '/ordinary',
        postponed: undefined,
        compute: 'static' as const,
        response: 'complete' as const,
      };
      const first = await inputFor(scopeId, primary);
      const second = await inputFor(scopeId, ordinary);
      const apply = await planSeedEntries(
        { ...tx, revision: 2 },
        { scopeId, batchIndex: 0, entries: [first, second] },
      );
      const outcome = state.storage.transactionSync(apply);
      return {
        outcome,
        associations: sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM entry_tags t JOIN entries e ON e.entry_id = t.entry_id WHERE e.pathname = ?`,
            primary.pathname,
          )
          .one().count,
        ordinary: sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM entries WHERE pathname = '/ordinary'`,
          )
          .one().count,
      };
    });

    expect(snapshot).toHaveProperty('outcome.inserted', example.inserted);
    expect(snapshot).toHaveProperty('outcome.refused', example.refused);
    expect(snapshot.associations).toBe(example.associations);
    expect(snapshot.ordinary).toBe(1);
  });
});
