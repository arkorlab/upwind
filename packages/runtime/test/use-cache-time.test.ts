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

describe('time-based use cache refresh', () => {
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

  it('answers the stale value before starting a lookup and adopts the result after response end', async () => {
    const pending = Promise.withResolvers<DataRead | undefined>();
    const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockReturnValue(pending.promise);
    const { read, request, handler, endResponses } = scenario(newer);
    const entry = await Promise.race([
      request().run(() => handler.get(KEY, [])),
      setImmediate('still waiting' as const),
    ]);

    expect(entry).not.toBe('still waiting');

    const body =
      typeof entry === 'string' || entry === undefined
        ? entry
        : await new Response(entry.value).text();

    expect(body).toBe('A');
    expect(newer).not.toHaveBeenCalled();

    await endResponses();

    expect(newer).toHaveBeenCalledExactlyOnceWith(
      { key: KEY, kind: 'data:use-cache', handler: 'default' },
      1,
    );

    pending.resolve(value('B', 2));
    await vi.advanceTimersByTimeAsync(0);

    await expect(read()).resolves.toBe('B');
  });

  it('does not add a lookup or discard the memo for an unrelated fresh key', async () => {
    const pending = Promise.withResolvers<DataRead | undefined>();
    const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockReturnValue(pending.promise);
    const { read, getData, endResponses } = scenario(newer);

    await expect(read(FRESH_KEY)).resolves.toBe('fresh');
    expect(newer).not.toHaveBeenCalled();
    await expect(read()).resolves.toBe('A');
    await expect(read(FRESH_KEY)).resolves.toBe('fresh');
    expect(getData).toHaveBeenCalledTimes(2);
    expect(newer).not.toHaveBeenCalled();

    await endResponses();

    expect(newer).toHaveBeenCalledExactlyOnceWith(
      { key: KEY, kind: 'data:use-cache', handler: 'default' },
      1,
    );

    pending.resolve(undefined);
  });

  it('shares only the pending refresh of a key at the same revision', async () => {
    const pending = Promise.withResolvers<DataRead | undefined>();
    const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockReturnValue(pending.promise);
    const { read, endResponses } = scenario(newer);

    await expect(read()).resolves.toBe('A');
    await expect(read()).resolves.toBe('A');
    expect(newer).not.toHaveBeenCalled();

    await endResponses();

    expect(newer).toHaveBeenCalledTimes(1);

    pending.resolve(value('B', 2));
    await vi.advanceTimersByTimeAsync(0);

    await expect(read()).resolves.toBe('B');
  });

  it('does not overwrite a newer local write when the background lookup answers late', async () => {
    const pending = Promise.withResolvers<DataRead | undefined>();
    const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockReturnValue(pending.promise);
    const { handler, read, request, endResponses } = scenario(newer);

    await expect(read()).resolves.toBe('A');

    await endResponses();

    const entry = value('C', 3).entry;
    await request().run(() => {
      return handler.set(
        KEY,
        Promise.resolve({
          ...entry,
          tags: [...entry.tags],
          value: new Blob(['C']).stream(),
        }),
      );
    });
    await vi.advanceTimersByTimeAsync(0);

    pending.resolve(value('B', 2));
    await vi.advanceTimersByTimeAsync(0);

    await expect(read()).resolves.toBe('C');
    expect(newer).toHaveBeenCalledTimes(1);
  });

  it('releases a timed-out lookup so a later request can refresh the same revision', async () => {
    const pending = Promise.withResolvers<DataRead | undefined>();
    const newer = vi
      .fn<NonNullable<CacheHost['getNewerData']>>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(value('B', 2));
    const { read, endResponses } = scenario(newer);

    await expect(read()).resolves.toBe('A');

    await endResponses();
    await vi.advanceTimersByTimeAsync(200);

    await expect(read()).resolves.toBe('A');

    await endResponses();

    await expect(read()).resolves.toBe('B');
    expect(newer).toHaveBeenCalledTimes(2);

    pending.resolve(undefined);
  });

  it('ends a cancelled response wait without a lookup or blocking a later response', async () => {
    const newer = vi.fn<NonNullable<CacheHost['getNewerData']>>().mockResolvedValue(value('B', 2));
    const { handler, read, request } = scenario(newer);
    const cancelled = request();

    const entry = await cancelled.run(() => handler.get(KEY, []));

    expect(entry).toBeDefined();
    expect(newer).not.toHaveBeenCalled();

    const expired = Promise.allSettled(background);
    await vi.advanceTimersByTimeAsync(300_000);

    await expect(Promise.race([expired, setImmediate('still waiting')])).resolves.not.toBe(
      'still waiting',
    );

    await cancelled.writes.landed(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(newer).not.toHaveBeenCalled();

    const later = request();
    await later.run(() => handler.get(KEY, []));
    await later.writes.landed(0);
    await vi.advanceTimersByTimeAsync(0);

    expect(newer).toHaveBeenCalledTimes(1);
    await expect(read()).resolves.toBe('B');
  });
});
