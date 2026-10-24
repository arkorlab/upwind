import { MAX_TAGS_PER_CALL, NEXT_ONE_YEAR_SECONDS } from '@stayingupwind/core/cache';
import {
  DEFAULT_D1_CACHE_TAG,
  installNextCacheRegistry,
  type NextRevalidationProvider,
  observeD1,
  RESOURCE_CHANGES_SERVICE_BINDING,
} from '@stayingupwind/core/paas';
import {
  type WorkStore,
  workAsyncStorage,
} from 'next/dist/server/app-render/work-async-storage.external.js';
import {
  workUnitAsyncStorage,
  type WorkUnitStore,
} from 'next/dist/server/app-render/work-unit-async-storage.external.js';
import { executeRevalidates } from 'next/dist/server/revalidation-utils.js';
import { revalidateTag } from 'next/dist/server/web/spec-extension/revalidate.js';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import { type InvalidateRequest, invalidateRequestSchema } from '../../host/src/cache/index.ts';
import { hasResourceReceipt, withRequestContext } from '../src/cache/context.ts';
import { configureCacheHandlers, PlatformFetchCache } from '../src/cache/handlers.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { reportResourceChange } from '../src/resource-changes.ts';
import { createCacheHost } from './function-cache-host.ts';
import { requestKeeping } from './request-context.ts';

// The time each test had where this suite ran before.
vi.setConfig({ testTimeout: 60_000 });

// The native Next stores see the same ALS implementation the Function publishes before Next loads.
await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
});

const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://authority.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-test',
};
const NOW = Date.now();

function tagsWithResource(): string[] {
  return [
    ...Array.from({ length: MAX_TAGS_PER_CALL }, (_value, index) => `manual-${index}`),
    DEFAULT_D1_CACHE_TAG,
  ];
}

function gateway(failLast = false) {
  const requests: InvalidateRequest[] = [];
  return {
    requests,
    fetchImpl: async (request: Request): Promise<Response> => {
      expect(new URL(request.url).pathname).toBe('/v1/scopes/scope-test/invalidations');

      const body = invalidateRequestSchema.parse(await request.json());
      requests.push(body);
      if (failLast && requests.length === 2) {
        return Response.json(
          { ok: false, error: { code: 'internal', message: 'last chunk failed' } },
          { status: 503 },
        );
      }
      return Response.json({
        ok: true,
        result: {
          revision: 10 + requests.length,
          affectedEntryIds: ['shared-entry', `entry-${requests.length}`],
          invalidations: body.tags.map(({ value }, index) => {
            return {
              invalidationId: `invalidation-${requests.length}-${index}`,
              tagId: `tag-${value}`,
              value,
              staleAt: NOW,
              hardExpireAt: body.expire === undefined ? NOW : NOW + body.expire * 1000,
              meaning: body.expire === undefined ? 'immediate' : 'swr',
            };
          }),
        },
      });
    },
  };
}

describe('bounded cache invalidation requests', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    vi.restoreAllMocks();
  });

  it('keeps a group of 128 unique tags in one request, including repeated tag values', async () => {
    const transport = gateway();
    const host = createCacheHost({ env: ENV, fetchImpl: transport.fetchImpl })?.host;
    const tags = tagsWithResource().slice(0, MAX_TAGS_PER_CALL);
    const outcome = await host?.invalidate({
      tags: [...tags, 'manual-0'],
      expire: NEXT_ONE_YEAR_SECONDS,
      api: 'revalidateTag',
    });

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]?.tags.map(({ value }) => value)).toStrictEqual(tags);
    expect(transport.requests[0]?.more).toBeUndefined();
    expect(outcome?.invalidations).toHaveLength(MAX_TAGS_PER_CALL);
  });

  it('combines 128/1 requests into all marks, the latest revision and distinct affected entries', async () => {
    const transport = gateway();
    const host = createCacheHost({ env: ENV, fetchImpl: transport.fetchImpl })?.host;
    const tags = tagsWithResource();
    const outcome = await host?.invalidate({
      tags: [...tags, DEFAULT_D1_CACHE_TAG],
      expire: NEXT_ONE_YEAR_SECONDS,
      api: 'revalidateTag',
    });

    expect(transport.requests.map((request) => request.tags.length)).toStrictEqual([128, 1]);
    // The response waits for the host's telling on the last chunk alone.
    expect(transport.requests.map((request) => request.more)).toStrictEqual([true, undefined]);
    expect(transport.requests[1]).toMatchObject({
      tags: [{ value: DEFAULT_D1_CACHE_TAG }],
      expire: NEXT_ONE_YEAR_SECONDS,
      cause: { source: 'app-worker', api: 'revalidateTag' },
    });
    expect(outcome).toMatchObject({
      revision: 12,
      affectedEntryIds: ['shared-entry', 'entry-1', 'entry-2'],
    });
    expect(outcome?.invalidations.map(({ value }) => value)).toStrictEqual(tags);
  });

  it('rejects a failed chunk instead of claiming the whole group was invalidated', async () => {
    const transport = gateway(true);
    const host = createCacheHost({ env: ENV, fetchImpl: transport.fetchImpl })?.host;

    await expect(host?.invalidate({ tags: tagsWithResource(), api: 'updateTag' })).rejects.toThrow(
      'last chunk failed',
    );
    expect(transport.requests.map((request) => request.tags.length)).toStrictEqual([128, 1]);
  });

  it.each([
    { failLast: false, failures: [] },
    { failLast: true, failures: ['last chunk failed'] },
  ])(
    'handles native max grouping after a failed D1 receipt without SQL replay (last chunk fails: $failLast)',
    async ({ failLast, failures }) => {
      const transport = gateway(failLast);
      const runtime = createCacheRuntime({
        env: ENV,
        now: () => NOW,
        fetchImpl: transport.fetchImpl,
      });
      assert(runtime !== undefined);
      configureCacheHandlers(runtime);
      const log = vi.spyOn(runtime, 'log').mockImplementation(vi.fn());
      const reporter = vi.fn(() => Promise.reject(new Error('resource report unavailable')));
      const nativeRun = vi.fn(() => Promise.resolve({ success: true, meta: { changed_db: true } }));
      const database = observeD1({ prepare: () => ({ run: nativeRun }) }, 'DB', {
        changed: () => {
          return reportResourceChange(
            { [RESOURCE_CHANGES_SERVICE_BINDING]: { reportResourceChange: reporter } },
            'DB',
          );
        },
      });
      installNextCacheRegistry();
      const register = (globalThis as Record<symbol, unknown>)[
        Symbol.for('upwind.next-revalidation@1')
      ] as (provider: NextRevalidationProvider) => void;
      register({
        workStorage: workAsyncStorage as unknown as NextRevalidationProvider['workStorage'],
        unitStorage: workUnitAsyncStorage,
        revalidateTag,
      });
      const store = {
        incrementalCache: new PlatformFetchCache(),
        cacheLifeProfiles: { max: { expire: NEXT_ONE_YEAR_SECONDS } },
      } as unknown as WorkStore;
      const kept: Promise<unknown>[] = [];
      const context = requestKeeping(runtime, kept);
      await withRequestContext(context, () => {
        return workAsyncStorage.run(store, () => {
          return workUnitAsyncStorage.run(
            { type: 'request', phase: 'action' } as WorkUnitStore,
            async () => {
              for (const tag of tagsWithResource().slice(0, MAX_TAGS_PER_CALL)) {
                revalidateTag(tag, 'max');
              }

              await expect(database.prepare('UPDATE items SET id=1').run()).resolves.toMatchObject({
                success: true,
              });

              expect(hasResourceReceipt(context, DEFAULT_D1_CACHE_TAG)).toBe(false);
              expect(store.pendingRevalidatedTags).toHaveLength(129);

              await executeRevalidates(store);
            },
          );
        });
      });
      await Promise.all(kept);

      expect(nativeRun).toHaveBeenCalledExactlyOnceWith();
      expect(reporter).toHaveBeenCalledTimes(4);
      expect(transport.requests.map((request) => request.tags.length)).toStrictEqual([128, 1]);
      expect(context.invalidated.tags.size).toBe(0);
      expect(
        log.mock.calls
          .filter(([message]) => message === 'tag invalidation failed')
          .map(([, fields]) => fields?.['detail']),
      ).toStrictEqual(failures);
    },
  );
});
