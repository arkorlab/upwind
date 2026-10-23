import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import type {
  CacheHost,
  DataRead,
  DataWriteRequest,
  InvalidateOutcome,
  InvalidateRequest,
} from '../src/cache/host.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';

/**
 * A request's own invalidation, told to the host at the moment it was put in force here
 * (`InvalidateRequest.inForceAt`), and what the request computes after it stamped past that moment
 * (`own-marks.ts`): a Function's clock moves only when I/O completes, so a value the request began
 * after its invalidation can read the invalidation's very moment, which condemns what was made at or
 * before it. Every request here acts at one moment, as on a clock no I/O has moved.
 */

const NOW = 1_800_000_000_000;
const HOLD_MS = 5000;
const ENTRIES = 64;
const TAG = 'feed';
const FETCHED = 'fetched';
const CACHED = 'cached-function';

/** The clock every request here acts at: one no I/O moves. */
function frozen(): number {
  return NOW;
}

/** What the host answers a call no write or invalidation makes: a failure, which none asks for. */
function unasked(): Promise<never> {
  return Promise.reject(new Error('not asked by a write'));
}

/**
 * What a host whose clock reads `clock` answers `request` with, at `revision`: recorded at the moment
 * it was told, no later than its clock.
 */
function recorded(request: InvalidateRequest, clock: number, revision: number): InvalidateOutcome {
  const at = Math.min(request.inForceAt ?? NOW, clock);
  const mark = { staleAt: at, hardExpireAt: at, revision };
  return { revision, invalidations: request.tags.map((value) => ({ value, ...mark })) };
}

/** What the host answers a read of a value it was written with. */
function readOf(write: DataWriteRequest): DataRead {
  return {
    entryId: 'entry',
    generationId: 'generation',
    dependencyRevision: 3,
    entry: write.entry,
    value: { kind: 'inline', base64: write.valueBase64 },
  };
}

/**
 * A host that holds nothing yet, records each invalidation at once — at the moment it is told, no
 * later than its clock, which reads `clock` — and keeps every write.
 */
function cache(clock = Infinity) {
  const stored = new Map<string, DataWriteRequest>();
  let revision = 1;
  const host = {
    startAttempt: unasked,
    uploadArtifact: unasked,
    heartbeat: unasked,
    commit: unasked,
    fail: unasked,
    readRecord: () => Promise.resolve(undefined),
    readArtifact: () => Promise.resolve(undefined),
    getData: (request) => {
      const write = stored.get(request.key);
      return Promise.resolve(write === undefined ? undefined : readOf(write));
    },
    setData: vi.fn<CacheHost['setData']>((request) => {
      stored.set(request.key, request);
      return Promise.resolve({ entryId: 'entry', generationId: 'generation', revision: 3 });
    }),
    getTags: () => Promise.resolve({ tags: [] }),
    tagsDelta: () => Promise.resolve({ revision: 0, truncated: false, tags: [] }),
    invalidate: vi.fn<CacheHost['invalidate']>((request) => {
      revision += 1;
      return Promise.resolve(recorded(request, clock, revision));
    }),
  } satisfies CacheHost;
  const runtime: CacheRuntime = {
    scopeId: 'own-marks',
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
  configureCacheHandlers(runtime);
  return { host, runtime };
}

/** A request at `NOW`, with what it hands `waitUntil` collected in `kept`. */
function requestOf(runtime: CacheRuntime, kept: Promise<unknown>[]) {
  return requestContextFor({
    tables: { app: { entries: {} }, edge: { entries: {} } },
    runtime,
    request: new Request('https://app.test/', { method: 'POST' }),
    startedAt: NOW,
    waitUntil: (promise) => {
      kept.push(promise);
    },
    clock: NOW,
  });
}

/** Every handler Next.js has, handed `updateTag(TAG)` in one turn, as `revalidateTags` hands it. */
function updateTag(): Promise<unknown> {
  return Promise.all([
    useCacheHandler('default').updateTags([TAG]),
    useCacheHandler('remote').updateTags([TAG]),
    new PlatformFetchCache().revalidateTag([TAG]),
  ]);
}

const fetchCache = new PlatformFetchCache();

/** A `fetch` read of `key` under `TAG`, as Next.js makes one before it fetches. */
function readFetched(key = FETCHED): Promise<unknown> {
  return fetchCache.get(key, { kind: 'FETCH', tags: [TAG] });
}

/** What the `fetch` of `key` answered, handed to the fetch cache, as Next.js hands it. */
function writeFetched(key = FETCHED): Promise<void> {
  return fetchCache.set(
    key,
    { kind: 'FETCH', data: { body: key }, tags: [TAG], revalidate: 60 },
    { fetchCache: true, tags: [TAG] },
  );
}

/** A `use cache` read of `key`, as Next.js makes one before it computes the value. */
function readCached(key = CACHED): Promise<unknown> {
  return useCacheHandler('default').get(key, []);
}

/** A `use cache` value of `key` under `TAG`, as Next.js stamps one: at the clock's moment. */
function writeCached(key = CACHED): Promise<void> {
  const value = new Blob([key]).stream();
  const entry = { value, tags: [TAG], stale: 0, timestamp: NOW, expire: 3600, revalidate: 60 };
  return useCacheHandler('default').set(key, Promise.resolve(entry));
}

/** The moments of what the host was asked to write, by key, once every write behind has landed. */
async function written(
  host: ReturnType<typeof cache>['host'],
  kept: readonly Promise<unknown>[],
): Promise<Record<string, number>> {
  await Promise.all(kept);
  const writes = host.setData.mock.calls.map(([request]: [DataWriteRequest]) => request);
  return Object.fromEntries(writes.map((write) => [write.key, write.entry.timestamp]));
}

describe('what a request computes after its own invalidation', () => {
  afterEach(() => {
    vi.useRealTimers();
    configureCacheHandlers(undefined);
  });

  it('asks the host to record the invalidation at the moment it was put in force here', async () => {
    const { host, runtime } = cache();
    const context = requestOf(runtime, []);

    await context.run(async () => {
      await updateTag();
      await useCacheHandler('default').updateTags(['posts'], { expire: 60 });
    });

    expect(host.invalidate.mock.calls.map(([request]) => request)).toStrictEqual([
      { tags: [TAG], api: 'updateTag', inForceAt: NOW },
      { tags: ['posts'], expire: 60, api: 'revalidateTag', inForceAt: NOW },
    ]);
  });

  it('is stamped past the invalidation, where its first read began after it', async () => {
    const { host, runtime } = cache();
    const kept: Promise<unknown>[] = [];
    const context = requestOf(runtime, kept);

    await context.run(async () => {
      await updateTag();
      await readFetched();
      await writeFetched();
      await readCached();
      await writeCached();
    });

    await expect(written(host, kept)).resolves.toStrictEqual({
      [FETCHED]: NOW + 1,
      [CACHED]: NOW + 1,
    });
  });

  it('is served here once written: made after the invalidation, it is none of what it condemned', async () => {
    const { runtime } = cache();
    const kept: Promise<unknown>[] = [];
    const context = requestOf(runtime, kept);
    await context.run(async () => {
      await updateTag();
      await readFetched();
      await writeFetched();
    });
    await Promise.all(kept);

    const next = requestOf(runtime, []);

    await expect(next.run(readFetched)).resolves.toMatchObject({
      value: { data: { body: 'fetched' } },
    });
  });

  it('keeps its moment where its first read began before the invalidation, which condemns it', async () => {
    const { host, runtime } = cache();
    const kept: Promise<unknown>[] = [];
    const context = requestOf(runtime, kept);

    await context.run(async () => {
      await readFetched();
      await readCached();
      await updateTag();
      // Read again after it, which hands back what the first read began.
      await readFetched();
      await writeFetched();
      await readCached();
      await writeCached();
    });

    await expect(written(host, kept)).resolves.toStrictEqual({ [FETCHED]: NOW, [CACHED]: NOW });
    await expect(requestOf(runtime, []).run(readFetched)).resolves.toBeNull();
  });

  it('is stamped as it was for a request that invalidated nothing, beside one that did', async () => {
    const { host, runtime } = cache();
    const kept: Promise<unknown>[] = [];
    const invalidating = requestOf(runtime, []);
    const other = requestOf(runtime, kept);

    await invalidating.run(updateTag);
    await other.run(async () => {
      await readFetched();
      await writeFetched();
      await readCached();
      await writeCached();
    });

    await expect(written(host, kept)).resolves.toStrictEqual({ [FETCHED]: NOW, [CACHED]: NOW });
  });

  /**
   * A value read between two of the request's invalidations of one millisecond is stamped past the
   * first, and computed before the change the second was asked for: the second is put in force no
   * earlier than it, and what the request reads after the second is stamped past that.
   */
  it('puts a second invalidation of one millisecond no earlier than what the request stamped since the first', async () => {
    const { host, runtime } = cache();
    const kept: Promise<unknown>[] = [];
    const context = requestOf(runtime, kept);

    await context.run(async () => {
      await updateTag();
      await readFetched('between');
      await readCached('computed-between');
      await updateTag();
      await readFetched('after');
      await readCached('computed-after');
      await writeFetched('between');
      await writeCached('computed-between');
      await writeFetched('after');
      await writeCached('computed-after');
    });
    // What the request handed `waitUntil`: its writes, and both invalidations.
    const stamps = await written(host, kept);

    expect(host.invalidate.mock.calls.map(([request]) => request.inForceAt)).toStrictEqual([
      NOW,
      NOW + 1,
    ]);
    expect(stamps).toStrictEqual({
      between: NOW + 1,
      'computed-between': NOW + 1,
      after: NOW + 2,
      'computed-after': NOW + 2,
    });
  });

  it('condemns here what the request read between them, though the host recorded the second earlier', async () => {
    // A host whose clock reads `NOW` records the second at it, before what the request stamped.
    const { runtime } = cache(NOW);
    const kept: Promise<unknown>[] = [];
    const context = requestOf(runtime, kept);
    await context.run(async () => {
      await updateTag();
      await readFetched('between');
      await writeFetched('between');
      await updateTag();
      await readFetched('after');
      await writeFetched('after');
    });
    // What the request handed `waitUntil`: its writes, and both invalidations.
    await Promise.all(kept);

    const next = requestOf(runtime, []);

    await expect(next.run(() => readFetched('between'))).resolves.toBeNull();
    await expect(next.run(() => readFetched('after'))).resolves.toMatchObject({
      value: { data: { body: 'after' } },
    });
  });

  it('sends a moment ahead of the clock once the clock has passed it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { host, runtime } = cache();
    const context = requestOf(runtime, []);

    await context.run(async () => {
      await updateTag();
      await readFetched('between');
      await updateTag();
    });

    // The first went at once; the second waits for the clock to pass its moment.
    expect(host.invalidate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inForceAt: NOW }),
    );

    await vi.advanceTimersByTimeAsync(1);

    expect(host.invalidate).toHaveBeenCalledTimes(2);
    expect(host.invalidate.mock.calls[1]?.[0].inForceAt).toBe(NOW + 1);
  });
});
