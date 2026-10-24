import { deriveEntry, NEXT_ONE_YEAR_SECONDS } from '@stayingupwind/core/cache';
import {
  DEFAULT_D1_CACHE_TAG,
  formatResourcesManifest,
  publishFunctionEnv,
  RESOURCE_CHANGES_SERVICE_BINDING,
  RESOURCES_MANIFEST_BINDING,
} from '@stayingupwind/core/paas';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';

import {
  beginResourceChange,
  hasResourceReceipt,
  recordResourceReceipt,
  withRequestContext,
} from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { reportResourceChange } from '../src/resource-changes.ts';
import { INVALIDATIONS_RECORDED_WITHIN_MS } from '../src/serve.ts';
import { requestKeeping } from './request-context.ts';

// Nothing here renders; the bridge's own module needs workerd.
vi.mock(import('../src/node-bridge.ts'), () => {
  return {
    invokeNodeHandler: () => {
      throw new Error('unexpected Node render');
    },
  };
});

const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-test',
};

describe('d1 durable resource reporting', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    publishFunctionEnv({});
  });

  it('awaits durable ACK, marks local SWR, and coalesces native max fanout without hard edge invalidation', async () => {
    const accepted = Promise.withResolvers<{ v: 1; kind: 'accepted'; revision: number }>();
    const reporter = vi.fn<
      (report: { eventId: string; type: 'd1'; bindingName: string }) => typeof accepted.promise
    >(() => accepted.promise);
    const invalidations: Request[] = [];
    const runtime = createCacheRuntime({
      env: ENV,
      now: Date.now,
      fetchImpl: (request) => {
        invalidations.push(request);
        return Promise.resolve(
          Response.json({
            ok: true,
            result: { revision: 2, affectedEntryIds: [], invalidations: [] },
          }),
        );
      },
    });
    assert(runtime !== undefined);
    configureCacheHandlers(runtime);
    const context = requestKeeping(runtime, []);
    const timestamp = Date.now() - 1000;
    await withRequestContext(context, async () => {
      let settled = false;
      const report = (async () => {
        await reportResourceChange(
          { [RESOURCE_CHANGES_SERVICE_BINDING]: { reportResourceChange: reporter } },
          'ORDERS',
        );
        settled = true;
      })();
      const eventId: unknown = expect.any(String);
      await vi.waitFor(() => {
        expect(reporter).toHaveBeenCalledExactlyOnceWith({
          eventId,
          type: 'd1',
          bindingName: 'ORDERS',
        });
      });

      expect({
        settled,
        received: hasResourceReceipt(context, DEFAULT_D1_CACHE_TAG),
      }).toStrictEqual({
        settled: false,
        received: false,
      });

      accepted.resolve({ v: 1, kind: 'accepted', revision: 7 });
      await report;

      expect(reporter.mock.calls[0]?.[0]).toMatchObject({
        type: 'd1',
        bindingName: 'ORDERS',
        eventId,
      });
      expect({
        received: hasResourceReceipt(context, DEFAULT_D1_CACHE_TAG),
        validity: runtime.tags.validityOf([DEFAULT_D1_CACHE_TAG], timestamp, Date.now()),
        hardInvalidations: context.invalidated.tags.size,
      }).toStrictEqual({ received: true, validity: 'stale', hardInvalidations: 0 });

      await Promise.all([
        useCacheHandler('default').updateTags([DEFAULT_D1_CACHE_TAG], {
          expire: NEXT_ONE_YEAR_SECONDS,
        }),
        useCacheHandler('remote').updateTags([DEFAULT_D1_CACHE_TAG], {
          expire: NEXT_ONE_YEAR_SECONDS,
        }),
        new PlatformFetchCache().revalidateTag([DEFAULT_D1_CACHE_TAG], {
          expire: NEXT_ONE_YEAR_SECONDS,
        }),
      ]);

      expect(invalidations).toHaveLength(0);

      await useCacheHandler('default').updateTags([DEFAULT_D1_CACHE_TAG]);
      // Answered once it is in force here; the request's response waits for the host.
      await context.invalidated.recorded(INVALIDATIONS_RECORDED_WITHIN_MS);

      expect(invalidations).toHaveLength(1);
      expect(context.invalidated.tags.has(DEFAULT_D1_CACHE_TAG)).toBe(true);
    });
  });

  /**
   * The report's own mark is known at no revision once the service has received it — the receipt
   * counts the service's own events, not the scope's — and leaves nothing of this isolate's out: a
   * later invalidation of the tag the host answers is known at the host's revision.
   */
  it('leaves nothing of its own invalidation out once the report is received', async () => {
    const reporter = vi.fn<
      (report: {
        eventId: string;
        type: 'd1';
        bindingName: string;
      }) => Promise<{ v: 1; kind: 'accepted'; revision: number }>
    >(() => Promise.resolve({ v: 1, kind: 'accepted', revision: 7 }));
    const runtime = createCacheRuntime({
      env: ENV,
      now: Date.now,
      fetchImpl: () => {
        return Promise.resolve(
          Response.json({
            ok: true,
            result: { revision: 2, affectedEntryIds: [], invalidations: [] },
          }),
        );
      },
    });
    assert(runtime !== undefined);
    configureCacheHandlers(runtime);

    await withRequestContext(requestKeeping(runtime, []), () => {
      return reportResourceChange(
        { [RESOURCE_CHANGES_SERVICE_BINDING]: { reportResourceChange: reporter } },
        'ORDERS',
      );
    });
    const reported = Date.now();
    const later = { staleAt: reported + 1000, hardExpireAt: reported + 1000 };
    runtime.tags.confirmLocal(
      DEFAULT_D1_CACHE_TAG,
      { ...later, revision: 5 },
      runtime.tags.applyLocal([DEFAULT_D1_CACHE_TAG], later),
    );

    // An entry made between the two: the clock the runtime reads may stand a little apart from this.
    expect(
      runtime.tags.validityOf([DEFAULT_D1_CACHE_TAG], reported + 500, reported + 2000, 5),
    ).toBe('fresh');
  });

  /**
   * A delivery that fails is handed behind the answer, and given up on at once where the request
   * can hand nothing more: the report's mark is settled once all the same, and another invalidation
   * of the tag this isolate has out stays in force.
   */
  it('settles its own mark once, though its delivery is given up on and handed behind the answer both', async () => {
    let calls = 0;
    const reporter = vi.fn<
      (report: {
        eventId: string;
        type: 'd1';
        bindingName: string;
      }) => Promise<{ v: 1; kind: 'accepted'; revision: number }>
    >(() => {
      calls += 1;
      return calls <= 2
        ? Promise.reject(new Error('the transport failed'))
        : Promise.resolve({ v: 1, kind: 'accepted', revision: 7 });
    });
    const runtime = createCacheRuntime({
      env: ENV,
      now: Date.now,
      fetchImpl: () => {
        return Promise.resolve(
          Response.json({
            ok: true,
            result: { revision: 2, affectedEntryIds: [], invalidations: [] },
          }),
        );
      },
    });
    assert(runtime !== undefined);
    configureCacheHandlers(runtime);
    vi.spyOn(runtime, 'log').mockImplementation(vi.fn());
    const madeAt = Date.now();
    // Another invalidation of the tag, out with the host as the report is made.
    runtime.tags.applyLocal([DEFAULT_D1_CACHE_TAG], {
      staleAt: madeAt + 1000,
      hardExpireAt: madeAt + 1000,
    });
    const ending = {
      ...requestKeeping(runtime, []),
      waitUntil: () => {
        throw new Error('the request is over');
      },
    };

    await withRequestContext(ending, () => {
      return reportResourceChange(
        { [RESOURCE_CHANGES_SERVICE_BINDING]: { reportResourceChange: reporter } },
        'ORDERS',
      );
    });
    await vi.waitFor(() => {
      expect(reporter).toHaveBeenCalledTimes(3);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(runtime.tags.validityOf([DEFAULT_D1_CACHE_TAG], madeAt, madeAt + 2000)).toBe('expired');
  });

  it('retries ambiguous transport failure using the same event id and records missing durable ACK without failing SQL', async () => {
    const reporter = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost reply'))
      .mockResolvedValueOnce({ v: 1, kind: 'accepted', revision: 2 });
    await reportResourceChange(
      { [RESOURCE_CHANGES_SERVICE_BINDING]: { reportResourceChange: reporter } },
      'ORDERS',
    );

    expect(reporter).toHaveBeenCalledTimes(2);
    expect(reporter.mock.calls[0]?.[0]).toStrictEqual(reporter.mock.calls[1]?.[0]);

    const rejected = vi.fn(() => Promise.resolve({ v: 1, kind: 'unaccepted', revision: 0 }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(vi.fn());

    await expect(
      reportResourceChange(
        { [RESOURCE_CHANGES_SERVICE_BINDING]: { reportResourceChange: rejected } },
        'ORDERS',
      ),
    ).resolves.toBeUndefined();
    expect(rejected).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls[0]?.[0]).toContain('acknowledgement');

    warning.mockRestore();
  });

  it('forwards native max invalidation after an accepted mutation followed by a failed report', async () => {
    const behind = Promise.withResolvers<{ v: 1; kind: 'accepted'; revision: number }>();
    const reporter = vi
      .fn()
      .mockResolvedValueOnce({ v: 1, kind: 'accepted', revision: 1 })
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockImplementation(() => behind.promise);
    const invalidations: Request[] = [];
    const runtime = createCacheRuntime({
      env: ENV,
      now: Date.now,
      fetchImpl: (request) => {
        invalidations.push(request);
        return Promise.resolve(
          Response.json({
            ok: true,
            result: { revision: 2, affectedEntryIds: [], invalidations: [] },
          }),
        );
      },
    });
    assert(runtime !== undefined);
    configureCacheHandlers(runtime);
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);
    const env = { [RESOURCE_CHANGES_SERVICE_BINDING]: { reportResourceChange: reporter } };
    await withRequestContext(context, async () => {
      await reportResourceChange(env, 'ORDERS');

      expect(hasResourceReceipt(context, DEFAULT_D1_CACHE_TAG)).toBe(true);

      await reportResourceChange(env, 'ORDERS');

      expect(hasResourceReceipt(context, DEFAULT_D1_CACHE_TAG)).toBe(false);

      await Promise.all([
        useCacheHandler('default').updateTags([DEFAULT_D1_CACHE_TAG], {
          expire: NEXT_ONE_YEAR_SECONDS,
        }),
        useCacheHandler('remote').updateTags([DEFAULT_D1_CACHE_TAG], {
          expire: NEXT_ONE_YEAR_SECONDS,
        }),
        new PlatformFetchCache().revalidateTag([DEFAULT_D1_CACHE_TAG], {
          expire: NEXT_ONE_YEAR_SECONDS,
        }),
      ]);

      expect(invalidations).toHaveLength(1);
      expect(context.invalidated.tags.size).toBe(0);
    });
    behind.resolve({ v: 1, kind: 'accepted', revision: 2 });
    await Promise.all(kept);

    expect(hasResourceReceipt(context, DEFAULT_D1_CACHE_TAG)).toBe(true);
  });

  it('requires every concurrent mutation receipt and captures its request for out-of-order background ACKs', async () => {
    const context = requestKeeping(undefined, []);
    const changes = await withRequestContext(context, () => {
      const earlier = beginResourceChange(DEFAULT_D1_CACHE_TAG);
      recordResourceReceipt(earlier, 1);
      const failed = beginResourceChange(DEFAULT_D1_CACHE_TAG);
      const later = beginResourceChange(DEFAULT_D1_CACHE_TAG);
      return Promise.resolve({ earlier, failed, later });
    });
    recordResourceReceipt(changes.later, 3);
    recordResourceReceipt(changes.earlier, 1);

    expect(hasResourceReceipt(context, DEFAULT_D1_CACHE_TAG)).toBe(false);

    recordResourceReceipt(changes.failed, 2);

    expect(hasResourceReceipt(context, DEFAULT_D1_CACHE_TAG)).toBe(true);
    expect(hasResourceReceipt(requestKeeping(undefined, []), DEFAULT_D1_CACHE_TAG)).toBe(false);
  });

  it('bounds a hung service, retries the same event id and records the failure', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(vi.fn());
    try {
      const pending = Promise.withResolvers<never>();
      const hung = vi.fn<(report: { eventId: string }) => Promise<never>>(() => pending.promise);
      let settled = false;
      const call = (async () => {
        await reportResourceChange(
          { [RESOURCE_CHANGES_SERVICE_BINDING]: { reportResourceChange: hung } },
          'ORDERS',
        );
        settled = true;
      })();
      await vi.advanceTimersByTimeAsync(749);

      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(751);
      await call;

      expect(hung).toHaveBeenCalledTimes(2);
      expect(hung.mock.calls[0]?.[0]).toStrictEqual(hung.mock.calls[1]?.[0]);
      expect(warning.mock.calls[0]?.[0]).toContain('timed out');
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it('syncs the known D1 tag concurrently with a cold cache value, without a second serial tag lookup', async () => {
    const { entryId } = await deriveEntry(ENV.NEXT_DEPLOYMENT_ID, {
      kind: 'data:use-cache',
      handler: 'default',
      key: 'orders',
    });
    publishFunctionEnv({
      ...ENV,
      ORDERS: {},
      [RESOURCES_MANIFEST_BINDING]: formatResourcesManifest([
        { name: 'ORDERS', type: 'd1' },
        { name: 'ORDERS', type: 'd1' },
        { name: 'MISSING', type: 'd1' },
      ]),
    });
    const calls: Request[] = [];
    const tags = Promise.withResolvers<Response>();
    const runtime = createCacheRuntime({
      env: ENV,
      now: Date.now,
      fetchImpl: async (request) => {
        calls.push(request);
        if (request.url.endsWith('/tags/get')) return tags.promise;
        return Response.json({
          ok: true,
          result: {
            entryId,
            generationId: 'generation',
            dependencyRevision: 0,
            entry: {
              kind: 'data:use-cache',
              handler: 'default',
              tags: [DEFAULT_D1_CACHE_TAG],
              stale: 60,
              timestamp: Date.now() - 1000,
              expire: 600,
              revalidate: 60,
              dependencyCoverage: 'complete',
            },
            value: { kind: 'inline', base64: btoa('cached') },
          },
        });
      },
    });
    configureCacheHandlers(runtime);
    const read = useCacheHandler('default').get('orders', []);
    await vi.waitFor(() => {
      expect(calls).toHaveLength(2);
    });

    expect(calls.map((call) => new URL(call.url).pathname)).toStrictEqual(
      expect.arrayContaining([
        expect.stringMatching(/\/data\/get$/u),
        expect.stringMatching(/\/tags\/get$/u),
      ]),
    );

    tags.resolve(Response.json({ ok: true, result: { tags: [] } }));

    await expect(read).resolves.toMatchObject({ tags: [DEFAULT_D1_CACHE_TAG] });
    expect(calls).toHaveLength(2);
  });
});
