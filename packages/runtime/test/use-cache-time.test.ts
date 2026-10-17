import { setImmediate } from 'node:timers/promises';

import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asRegeneration, requestContextFor } from '../src/cache/context.ts';
import { configureCacheHandlers, useCacheHandler } from '../src/cache/handlers.ts';
import type { CacheHost, DataRead } from '../src/cache/host.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';

const NOW = 1_800_000_000_000;
const SECOND = 1000;
const HOLD_MS = 5000;
const ENTRIES = 64;
const KEY = 'time-stale';
const FRESH_KEY = 'unrelated-fresh';
const background: Promise<unknown>[] = [];

function frozen(): number {
  return NOW;
}

function unasked(): Promise<never> {
  return Promise.reject(new Error('not asked by a time-based use cache read'));
}

function value(body: string, revision: number, timestamp = NOW, kind = 'default'): DataRead {
  return {
    entryId: 'entry',
    generationId: `generation-${String(revision)}`,
    dependencyRevision: revision,
    entry: {
      kind: 'data:use-cache',
      handler: kind,
      tags: [],
      stale: 0,
      timestamp,
      revalidate: 1,
      expire: 60,
    },
    value: { kind: 'inline', base64: btoa(body) },
  };
}

function scenario(newer: CacheHost['getNewerData'], kind = 'default', ageMs = 2 * SECOND) {
  const requests: ReturnType<typeof requestContextFor>[] = [];
  const getData = vi.fn<CacheHost['getData']>((request) => {
    return Promise.resolve(
      request.key === FRESH_KEY ? value('fresh', 1, NOW, kind) : value('A', 1, NOW - ageMs, kind),
    );
  });
  const setData = vi.fn<CacheHost['setData']>().mockResolvedValue({
    entryId: 'entry',
    generationId: 'generation-3',
    revision: 3,
  });
  const host: CacheHost = {
    startAttempt: unasked,
    uploadArtifact: unasked,
    heartbeat: unasked,
    commit: unasked,
    fail: unasked,
    readRecord: unasked,
    readArtifact: unasked,
    getData,
    ...(newer !== undefined && { getNewerData: newer }),
    setData,
    getTags: unasked,
    tagsDelta: unasked,
    invalidate: unasked,
  };
  const runtime: CacheRuntime = {
    scopeId: 'use-cache-time',
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
  const request = (clock: number | 'wall' = NOW) => {
    const context = requestContextFor({
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime,
      request: new Request('https://example.test/'),
      startedAt: NOW,
      waitUntil: (work) => {
        background.push(work);
      },
      clock: clock === 'wall' ? undefined : clock,
    });
    requests.push(context);
    return context;
  };
  configureCacheHandlers(runtime);
  const handler = useCacheHandler(kind);
  const read = (key = KEY) => {
    return request().run(async () => {
      const entry = await handler.get(key, []);
      return entry === undefined ? undefined : new Response(entry.value).text();
    });
  };
  const endResponses = async () => {
    await Promise.all(requests.splice(0).map((context) => context.writes.landed(0)));
    await vi.advanceTimersByTimeAsync(0);
  };
  return { handler, read, request, getData, setData, endResponses };
}

describe('production use cache lifetime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    configureCacheHandlers(undefined);
    await vi.runAllTimersAsync();
    await Promise.allSettled(background.splice(0));
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['default', 'remote'])(
    'misses an age-stale %s entry during regeneration while retaining unrelated fresh data',
    async (kind) => {
      const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockResolvedValue(undefined);
      const { handler, request, read, getData } = scenario(newer, kind);

      await expect(read(FRESH_KEY)).resolves.toBe('fresh');
      await expect(
        request().run(() => asRegeneration(() => handler.get(KEY, []))),
      ).resolves.toBeUndefined();
      await expect(read(FRESH_KEY)).resolves.toBe('fresh');
      expect(getData).toHaveBeenCalledTimes(2);
      expect(newer).not.toHaveBeenCalled();
      expect(background).toHaveLength(0);
    },
  );

  it.each([
    { ageMs: 0, expected: 'A' },
    { ageMs: SECOND, expected: 'A' },
    { ageMs: SECOND + 1, expected: undefined },
  ])(
    'uses the strict revalidate boundary during regeneration at age $ageMs',
    async ({ ageMs, expected }) => {
      const { handler, request } = scenario(undefined, 'default', ageMs);
      const entry = await request().run(() => asRegeneration(() => handler.get(KEY, [])));
      const body = entry === undefined ? undefined : await new Response(entry.value).text();

      expect(body).toBe(expected);
      expect(background).toHaveLength(0);
    },
  );

  it('misses during regeneration when the read itself passes the revalidate deadline', async () => {
    const base = performance.now();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(base);
    const timestamp = Math.round(performance.timeOrigin + base) - SECOND + 1;
    const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockResolvedValue(undefined);
    const { handler, request, getData } = scenario(newer);
    getData.mockImplementationOnce(() => {
      clock.mockReturnValue(base + 2);
      return Promise.resolve(value('A', 1, timestamp));
    });

    await expect(
      request('wall').run(() => asRegeneration(() => handler.get(KEY, []))),
    ).resolves.toBeUndefined();
    expect(newer).not.toHaveBeenCalled();
    expect(background).toHaveLength(0);
  });

  it.each(['default', 'remote'])(
    'retains the fresh %s value written by a regeneration instead of reusing the old entry',
    async (kind) => {
      const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockResolvedValue(undefined);
      const { handler, request, read, getData, setData } = scenario(newer, kind);
      const result = await request().run(() => {
        return asRegeneration(async () => {
          const before = await handler.get(KEY, []);
          await before?.value.cancel();
          const entry = value('B', 3, NOW, kind).entry;
          await handler.set(
            KEY,
            Promise.resolve({
              ...entry,
              tags: [...entry.tags],
              value: new Blob(['B']).stream(),
            }),
          );
          const after = await handler.get(KEY, []);
          return {
            missed: before === undefined,
            body: after === undefined ? undefined : await new Response(after.value).text(),
          };
        });
      });

      expect(result).toStrictEqual({ missed: true, body: 'B' });
      await expect(read()).resolves.toBe('B');
      expect(getData).toHaveBeenCalledTimes(1);
      expect(setData).toHaveBeenCalledTimes(1);
      expect(newer).not.toHaveBeenCalled();
      expect(background).toHaveLength(0);
    },
  );

  it.each(['default', 'remote'])(
    'misses an ordinary age-stale %s read without starting a refresh or discarding unrelated fresh data',
    async (kind) => {
      const newer = vi
        .fn<NonNullable<CacheHost['getNewerData']>>()
        .mockResolvedValue(value('B', 2));
      const { read, getData, endResponses } = scenario(newer, kind);

      await expect(read(FRESH_KEY)).resolves.toBe('fresh');
      await expect(read()).resolves.toBeUndefined();
      await expect(read(FRESH_KEY)).resolves.toBe('fresh');

      await endResponses();

      expect(getData).toHaveBeenCalledTimes(2);
      expect(newer).not.toHaveBeenCalled();
      expect(background).toHaveLength(0);
    },
  );

  it.each(
    ['default', 'remote'].flatMap((kind) => {
      return [
        { kind, ageMs: 0, expected: 'A' },
        { kind, ageMs: SECOND, expected: 'A' },
        { kind, ageMs: SECOND + 1, expected: undefined },
      ];
    }),
  )(
    'uses the strict $kind revalidate boundary for ordinary reads at age $ageMs',
    async ({ kind, ageMs, expected }) => {
      const { read } = scenario(undefined, kind, ageMs);

      await expect(read()).resolves.toBe(expected);
      expect(background).toHaveLength(0);
    },
  );

  it.each(['default', 'remote'])(
    'misses an ordinary %s read that crosses its revalidate deadline',
    async (kind) => {
      const base = performance.now();
      const clock = vi.spyOn(performance, 'now').mockReturnValue(base);
      const timestamp = Math.round(performance.timeOrigin + base) - SECOND + 1;
      const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockResolvedValue(undefined);
      const { handler, request, getData } = scenario(newer, kind);
      getData.mockImplementationOnce(() => {
        clock.mockReturnValue(base + 2);
        return Promise.resolve(value('A', 1, timestamp, kind));
      });

      await expect(request('wall').run(() => handler.get(KEY, []))).resolves.toBeUndefined();
      expect(newer).not.toHaveBeenCalled();
      expect(background).toHaveLength(0);
    },
  );

  it.each(['default', 'remote'])(
    'keeps a tag-stale %s response alive until its background revalidation lands',
    async (kind) => {
      const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockResolvedValue(undefined);
      const { handler, request, read, getData, endResponses } = scenario(newer, kind);
      getData.mockResolvedValueOnce({
        ...value('A', 1, NOW - SECOND / 2, kind),
        invalidation: { revision: 1, staleAt: NOW - 1 },
      });
      const context = request();
      const entry = await context.run(() => handler.get(KEY, []));

      expect(entry?.revalidate).toBe(-1);
      await expect(new Response(entry?.value).text()).resolves.toBe('A');
      expect(background.length).toBeGreaterThan(0);

      const held = (async () => {
        await Promise.all(background);
        return true;
      })();

      await expect(Promise.race([held, setImmediate(false)])).resolves.toBe(false);

      const fresh = value('B', 3, NOW, kind).entry;
      await context.run(() => {
        return handler.set(
          KEY,
          Promise.resolve({ ...fresh, tags: [...fresh.tags], value: new Blob(['B']).stream() }),
        );
      });
      await endResponses();

      await expect(held).resolves.toBe(true);
      await expect(read()).resolves.toBe('B');
    },
  );

  it.each(['default', 'remote'])(
    'retains fresh %s data written after an ordinary TTL miss',
    async (kind) => {
      const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockResolvedValue(undefined);
      const { handler, request, read, getData, setData, endResponses } = scenario(newer, kind);

      await expect(read(FRESH_KEY)).resolves.toBe('fresh');
      await expect(read()).resolves.toBeUndefined();

      const entry = value('B', 3, NOW, kind).entry;
      await request().run(() => {
        return handler.set(
          KEY,
          Promise.resolve({ ...entry, tags: [...entry.tags], value: new Blob(['B']).stream() }),
        );
      });
      await endResponses();
      await Promise.all(background);

      await expect(read()).resolves.toBe('B');
      await expect(read(FRESH_KEY)).resolves.toBe('fresh');
      expect(getData).toHaveBeenCalledTimes(2);
      expect(setData).toHaveBeenCalledTimes(1);
      expect(newer).not.toHaveBeenCalled();
    },
  );
});
