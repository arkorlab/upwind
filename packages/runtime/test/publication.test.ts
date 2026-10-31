import { AsyncLocalStorage } from 'node:async_hooks';

import { publicationTagOf, publicationDeadline } from '@stayingupwind/core/cache';
import {
  installNextCacheRegistry,
  type NextCacheStore,
  type NextStorage,
  observePublicationGrant,
} from '@stayingupwind/core/paas';
import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NEXT_CACHE_STORAGE_SYMBOL_KEY } from '../../core/src/paas/next-cache-registry.ts';
import { withClock } from '../src/cache/clock.ts';
import { requestContextFor } from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import type { CacheHost } from '../src/cache/host.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';
const NOW = 1_800_000_000_000;
const HOLD_MS = 5000;
const ENTRIES = 64;

function frozen(): number {
  return NOW;
}

function unasked(): Promise<never> {
  return Promise.reject(new Error('not asked by a use cache write'));
}

function hostOf(setData: CacheHost['setData']): CacheHost {
  return {
    startAttempt: unasked,
    uploadArtifact: unasked,
    heartbeat: unasked,
    commit: unasked,
    fail: unasked,
    readRecord: unasked,
    readArtifact: unasked,
    getData: () => Promise.resolve(undefined),
    setData,
    getTags: () => Promise.resolve({ tags: [] }),
    tagsDelta: () => Promise.resolve({ revision: 0, truncated: false, tags: [] }),
    invalidate: unasked,
  };
}

function runtimeOf(host: CacheHost): CacheRuntime {
  return {
    scopeId: 'use-cache-write',
    host,
    tags: new TagState({ holdMs: HOLD_MS }),
    holdMs: HOLD_MS,
    clockOf: frozen,
    dataMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    dataStates: new TtlCache(Infinity, ENTRIES, frozen),
    dataWrites: new Map(),
    entryIds: new TtlCache(Infinity, ENTRIES, frozen),
    recordMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    recordReads: new Map(),
    regenerationMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    publishing: new TtlCache(HOLD_MS, ENTRIES, frozen),
    letGo: new WeakSet(),
    givenBack: new TtlCache(HOLD_MS, ENTRIES, frozen),
    artifactMemo: new TtlCache(Infinity, ENTRIES, frozen),
    log: vi.fn(),
  };
}

function requestOf(runtime: CacheRuntime, behind: Promise<unknown>[]) {
  return requestContextFor({
    tables: { app: { entries: {} }, edge: { entries: {} } },
    runtime,
    request: new Request('https://example.test/'),
    startedAt: NOW,
    waitUntil: (write) => {
      behind.push(write);
    },
    clock: NOW,
  });
}

const grant = {
  scope: 'records',
  dataGeneration: 'generation-1',
  publicationEpoch: 1,
  release: { id: 'release-1', digest: 'b'.repeat(64) },
  validUntil: NOW + 60_000,
};

describe('publication-aware Next cache handlers', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'records declared cold fetch bounds before a miss can hand out streaming values (storage=%s)',
    async (configured) => {
      const tag = await publicationTagOf(grant);
      const runtime = runtimeOf(hostOf(unasked));
      configureCacheHandlers(configured ? runtime : undefined);
      const request = requestOf(runtime, []);
      const pending = request.run(() =>
        new PlatformFetchCache().get('cold', { kind: 'FETCH', tags: [tag] }),
      );

      expect(request.publication).toContain(tag);
      await expect(pending).resolves.toBeNull();
    },
  );

  it('refuses an expired declared fetch bound before any host read or response body', async () => {
    const tag = await publicationTagOf({ ...grant, validUntil: NOW });
    const host = hostOf(unasked);
    const read = vi.spyOn(host, 'getData');
    const runtime = runtimeOf(host);
    configureCacheHandlers(runtime);
    const request = requestOf(runtime, []);

    await expect(
      request.run(() => new PlatformFetchCache().get('cold', { kind: 'FETCH', tags: [tag] })),
    ).rejects.toThrow('Publication unavailable');
    expect(read).not.toHaveBeenCalled();
    expect(request.publication).toContain(tag);
  });

  it('records a fresh tagged fetch before final admission even when its cache write is still pending', async () => {
    const tag = await publicationTagOf(grant);
    const blocked = Promise.withResolvers<{
      entryId: string;
      generationId: string;
      revision: number;
    }>();
    const host = hostOf(vi.fn<CacheHost['setData']>(() => blocked.promise));
    const runtime = runtimeOf(host);
    configureCacheHandlers(runtime);
    const behind: Promise<unknown>[] = [];
    const request = requestOf(runtime, behind);
    const cache = new PlatformFetchCache();
    await request.run(() => {
      return cache.set(
        'cold',
        {
          kind: 'FETCH',
          data: { headers: {}, body: '', status: 200, url: 'https://source.test' },
          revalidate: 60,
          tags: [tag],
        },
        { fetchCache: true, tags: [] },
      );
    });

    expect(request.publication).toContain(tag);

    blocked.resolve({ entryId: 'entry', generationId: 'generation', revision: 1 });
    await Promise.all(behind);
  });

  it('retains a read child deadline when a parent is written under a renewed grant', async () => {
    installNextCacheRegistry();
    const stores = new AsyncLocalStorage<NextCacheStore>();
    const register = Reflect.get(globalThis, Symbol.for(NEXT_CACHE_STORAGE_SYMBOL_KEY)) as (
      storage: NextStorage<NextCacheStore>,
    ) => void;
    register(stores);
    const parentStore: NextCacheStore = { type: 'cache', tags: [] };
    const original = await publicationTagOf(grant);
    const setData = vi
      .fn<CacheHost['setData']>()
      .mockResolvedValue({ entryId: 'entry', generationId: 'generation', revision: 2 });
    const host = hostOf(setData);
    vi.spyOn(host, 'getData').mockResolvedValue({
      entryId: 'entry',
      generationId: 'generation',
      dependencyRevision: 1,
      entry: {
        kind: 'data:use-cache',
        handler: 'default',
        tags: [original],
        stale: 30,
        timestamp: NOW,
        expire: 86_400,
        revalidate: 3600,
      },
      value: { kind: 'inline', base64: btoa('child') },
    });
    const runtime = runtimeOf(host);
    configureCacheHandlers(runtime);
    const behind: Promise<unknown>[] = [];
    const request = requestOf(runtime, behind);
    await stores.run(parentStore, () => {
      return request.run(async () => {
        const cached = await useCacheHandler('default').get('child', []);

        expect(cached).toBeDefined();

        await observePublicationGrant({ ...grant, validUntil: NOW + 90_000 });
        await useCacheHandler('default').set(
          'parent',
          Promise.resolve({
            value: new Blob(['parent']).stream(),
            tags: [...(parentStore.tags ?? [])],
            stale: 30,
            timestamp: NOW,
            expire: 86_400,
            revalidate: 3600,
          }),
        );
      });
    });
    await Promise.all(behind);

    expect(setData).toHaveBeenCalledTimes(1);
    expect(publicationDeadline(setData.mock.calls[0]![0].entry.tags)).toBe(grant.validUntil);
  });

  it('misses an expired entry even if Next freshness and local invalidations permit it', async () => {
    const expired = await publicationTagOf({ ...grant, validUntil: NOW });
    const host = hostOf(vi.fn<CacheHost['setData']>());
    const getData = vi.spyOn(host, 'getData').mockResolvedValue({
      entryId: 'entry',
      generationId: 'generation',
      dependencyRevision: 1,
      entry: {
        kind: 'data:use-cache',
        handler: 'default',
        tags: [expired],
        stale: 30,
        timestamp: NOW,
        expire: 86_400,
        revalidate: 3600,
      },
      value: { kind: 'inline', base64: btoa('old') },
    });
    const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockResolvedValue(undefined);
    Object.assign(host, { getNewerData: newer });
    const runtime = runtimeOf(host);
    configureCacheHandlers(runtime);
    const request = requestOf(runtime, []);

    await expect(
      request.run(() => useCacheHandler('default').get('old', [])),
    ).resolves.toBeUndefined();
    expect(getData).toHaveBeenCalledTimes(1);
    expect(newer).not.toHaveBeenCalled();
  });

  it('keeps unrelated static component cache entries independent of a request grant', async () => {
    const setData = vi
      .fn<CacheHost['setData']>()
      .mockResolvedValue({ entryId: 'entry', generationId: 'generation', revision: 2 });
    const runtime = runtimeOf(hostOf(setData));
    configureCacheHandlers(runtime);
    const behind: Promise<unknown>[] = [];
    await requestOf(runtime, behind).run(async () => {
      await observePublicationGrant(grant);
      await useCacheHandler('default').set(
        'static',
        Promise.resolve({
          value: new Blob(['static']).stream(),
          tags: [],
          stale: 30,
          timestamp: NOW,
          expire: 86_400,
          revalidate: 3600,
        }),
      );
    });
    await Promise.all(behind);

    expect(setData.mock.calls[0]?.[0].entry.tags).toStrictEqual([]);
    expect(setData.mock.calls[0]?.[0].entry.expire).toBe(86_400);
  });

  it('cannot resurrect a cached grant after its runtime clock rolls back', async () => {
    const tag = await publicationTagOf(grant);
    const state = new TagState({ holdMs: HOLD_MS });
    const clock = vi
      .spyOn(performance, 'now')
      .mockReturnValue(grant.validUntil - 1 - performance.timeOrigin);

    expect(state.validityOf([tag], NOW, grant.validUntil - 1)).toBe('fresh');

    clock.mockReturnValue(grant.validUntil - performance.timeOrigin);

    expect(state.validityOf([tag], NOW, grant.validUntil)).toBe('expired');

    clock.mockReturnValue(grant.validUntil - 1 - performance.timeOrigin);

    expect(state.validityOf([tag], NOW, grant.validUntil - 1)).toBe('expired');
  });

  it('does not confuse an overlapping historical read with a live clock rollback', async () => {
    const tag = await publicationTagOf(grant);
    const state = new TagState({ holdMs: HOLD_MS });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(NOW + 10 - performance.timeOrigin);

    expect(state.validityOf([tag], NOW, NOW + 2)).toBe('fresh');

    clock.mockReturnValue(NOW + 11 - performance.timeOrigin);

    await expect(
      withClock(NOW, () => Promise.resolve(state.validityOf([tag], NOW, NOW + 1))),
    ).resolves.toBe('fresh');
    expect(state.validityOf([tag], NOW, NOW + 3)).toBe('fresh');
  });
});
