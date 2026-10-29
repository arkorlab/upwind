import { kvTagKey, tagIdFor } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { CacheScope } from '../src/scope/cache-scope.ts';
import { NO_HISTORY, NOTHING_PUBLISHED } from '../src/scope/history.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;

function watched(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise
    .finally(() => {
      state.settled = true;
    })
    .catch(() => {
      // This observer also records rejection; the caller checks its outcome separately.
    });
  return state;
}

describe('a scope whose host records history', () => {
  it('acknowledges a later invalidation after KV publication while prior history still runs', async () => {
    const scopeId = createId('dpl');
    await runInDurableObject(scopeStub(env, scopeId), async (_instance, state) => {
      const publish = vi.fn(() => Promise.resolve(NOTHING_PUBLISHED));
      const history = { ...NO_HISTORY, publish };
      class RecordingScope extends CacheScope {
        static override readonly historyOf = () => history;
      }
      const scope = new RecordingScope(state, { ...env, ARKOR_TEST_HOOKS: '1' });
      await scope.seedScope(
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
        NOW,
      );
      await scope.testSettled();
      publish.mockClear();

      const releaseHistory = Promise.withResolvers<undefined>();
      const historyStarted = Promise.withResolvers<undefined>();
      publish.mockImplementationOnce(async () => {
        historyStarted.resolve(undefined);
        await releaseHistory.promise;
        return NOTHING_PUBLISHED;
      });

      try {
        await scope.invalidate({ tags: [{ value: 'first' }], cause: { source: 'control' } }, NOW);
        await historyStarted.promise;
        await scope.invalidate(
          { tags: [{ value: 'next' }], cause: { source: 'control' } },
          NOW + 1,
        );

        const tagId = await tagIdFor(scopeId, 'next-explicit', 'next');
        const published = await env.CACHE_STATE.get(kvTagKey(scopeId, tagId));

        expect(published).not.toBeNull();
        expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scopeId }));

        const draining = scope.testSettled();
        const drained = watched(draining);
        for (let turn = 0; turn < 12; turn += 1) {
          await Promise.resolve();
        }

        expect(drained.settled).toBe(false);

        releaseHistory.resolve(undefined);
        await draining;

        expect(publish).toHaveBeenCalledTimes(2);
      } finally {
        releaseHistory.resolve(undefined);
        await scope.testSettled();
      }
    });
  });
});
