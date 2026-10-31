import { AsyncLocalStorage } from 'node:async_hooks';

import { deriveEntry } from '@stayingupwind/core/cache';
import { installResourcePrimaryReadStorage } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withClock } from '../src/cache/clock.ts';
import {
  asRegeneration,
  InvalidatedTags,
  RequestWrites,
  withRequestContext,
} from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { inRequest, requestKeeping } from './request-context.ts';

// The time each test had where this suite ran before: it renders through the runtime and the
// function-side cache host, and several of its tests take a second or two on a quiet machine.
vi.setConfig({ testTimeout: 60_000 });

const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: 'scope-test',
};
const MIB = 1024 * 1024;
/** Longer than any answer of a `fetchImpl` that answers at once takes. */
const SETTLE_MS = 100;

/** What a call came to within a moment, or that it was still waiting then. */
function settledWithin<T>(call: Promise<T>): Promise<T | 'still waiting'> {
  const moment = new Promise<'still waiting'>((resolve) => {
    setTimeout(() => {
      resolve('still waiting');
    }, SETTLE_MS);
  });
  return Promise.race([call, moment]);
}

function result(value: unknown): Response {
  return Response.json({ ok: true, result: value });
}

/**
 * A `use cache` entry's metadata, but for its handler: a gateway answers one beside a `use cache`
 * value, and none beside a fetch value (`dataEntryMetadataSchema`).
 */
function metadata(timestamp: number) {
  return {
    kind: 'data:use-cache' as const,
    tags: ['feed'],
    stale: 60,
    timestamp,
    expire: 600,
    revalidate: 60,
    dependencyCoverage: 'complete' as const,
  };
}

/** What a served value is kept by: the fetch cache, or a `use cache` handler's kind. */
type ServedKind = 'fetch' | 'default' | 'remote';

/** The core identity of a scoped key in the namespace its reader asks in. */
async function dataEntryId(kind: ServedKind, key: string): Promise<string> {
  const descriptor =
    kind === 'fetch'
      ? { kind: 'data:fetch' as const, key }
      : { kind: 'data:use-cache' as const, handler: kind, key };
  return (await deriveEntry(ENV.NEXT_DEPLOYMENT_ID, descriptor)).entryId;
}

function staleRuntime(kind: ServedKind, { onRead }: { readonly onRead?: () => unknown } = {}) {
  const timestamp = Date.now() - 1000;
  return servingRuntime(kind, {
    timestamp,
    onRead,
    tags: [
      {
        tagId: 'tag',
        kind: 'next-explicit',
        value: 'feed',
        revision: 1,
        staleAt: timestamp + 1,
        hardExpireAt: timestamp + 3_600_000,
        meaning: 'swr',
      },
    ],
  });
}

/** A value no tag has invalidated, two minutes old: past its `revalidate`, within its `expire`. */
function agedRuntime(kind: ServedKind) {
  return servingRuntime(kind, { timestamp: Date.now() - 120_000, tags: [] });
}

/**
 * A runtime whose host answers every read with one value, made at `timestamp`, and `tags` — telling
 * `onRead` first, and answering once what it returns has settled — and answers every write.
 */
async function servingRuntime(
  kind: ServedKind,
  {
    timestamp,
    tags,
    onRead,
  }: {
    readonly timestamp: number;
    readonly tags: readonly unknown[];
    readonly onRead?: (() => unknown) | undefined;
  },
) {
  const entryId = await dataEntryId(kind, 'feed');
  const stored = btoa(JSON.stringify({ kind: 'FETCH', data: {}, revalidate: 60 }));
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => Date.now(),
    fetchImpl: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/tags/delta') || url.pathname.endsWith('/tags/get')) {
        return Promise.resolve(result({ revision: 1, floor: 0, truncated: false, tags }));
      }
      if (request.method === 'PUT') {
        return Promise.resolve(result({ entryId, generationId: 'written', revision: 2 }));
      }
      const gate = onRead?.();
      const answer = result({
        entryId,
        generationId: 'generation',
        dependencyRevision: 0,
        entry: {
          ...metadata(timestamp),
          kind: kind === 'fetch' ? 'data:fetch' : 'data:use-cache',
          ...(kind !== 'fetch' && { handler: kind }),
        },
        value: { kind: 'inline', base64: stored },
      });
      return (async () => {
        await gate;
        return answer;
      })();
    },
  });
  return runtime;
}

describe('runtime cache reads', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  it.each(['fetch', 'use-cache'] as const)(
    'reads %s data and invalidation tags locally without serving invalidated data',
    async (kind) => {
      const entryId = await dataEntryId(kind === 'fetch' ? 'fetch' : 'default', 'feed');
      const tagged = Promise.withResolvers<Response>();
      const calls: Request[] = [];
      const timestamp = Date.now() - 1000;
      const runtime = createCacheRuntime({
        env: ENV,
        now: () => Date.now(),
        fetchImpl: async (request) => {
          calls.push(request);
          const url = new URL(request.url);
          if (url.pathname.endsWith('/tags/get')) {
            return tagged.promise;
          }
          return result({
            entryId,
            generationId: 'generation',
            dependencyRevision: 0,
            entry: {
              ...metadata(timestamp),
              kind: kind === 'fetch' ? 'data:fetch' : 'data:use-cache',
              ...(kind !== 'fetch' && { handler: 'default' }),
            },
            value: {
              kind: 'inline',
              base64: btoa(JSON.stringify({ kind: 'FETCH', data: {}, revalidate: 60 })),
            },
          });
        },
      });
      configureCacheHandlers(runtime);
      const handler = useCacheHandler('default');
      await handler.refreshTags();
      const read =
        kind === 'fetch'
          ? new PlatformFetchCache().get('feed', { kind: 'FETCH' })
          : handler.get('feed', []);
      let settled = false;
      async function observe() {
        try {
          return await read;
        } finally {
          settled = true;
        }
      }
      const observed = observe();
      try {
        await vi.waitFor(() => {
          expect(calls).toHaveLength(2);
        });

        expect(settled).toBe(false);
        expect(
          calls
            .map((request) => new URL(request.url).origin)
            .toSorted((a, b) => a.localeCompare(b)),
        ).toStrictEqual(['https://local.test', 'https://local.test']);

        for (const request of calls) {
          expect(request.headers.get('authorization')).toBe('Bearer test-scope-token');
          expect(request.headers.get('x-arkor-cache-scope')).toBe(ENV.NEXT_DEPLOYMENT_ID);
        }
      } finally {
        tagged.resolve(
          result({
            revision: 1,
            floor: 0,
            truncated: false,
            tags: [
              {
                tagId: 'tag',
                kind: 'next-explicit',
                value: 'feed',
                revision: 1,
                staleAt: timestamp + 1,
                hardExpireAt: timestamp + 1,
                meaning: 'immediate',
              },
            ],
          }),
        );
      }

      await expect(observed).resolves.toBe(kind === 'fetch' ? null : undefined);
    },
  );

  it.each(['host-delivery', 'next-explicit'] as const)(
    'keeps %s invalidations distinct from an explicit Next.js tag with the same text',
    async (kind) => {
      const runtime = createCacheRuntime({
        env: ENV,
        now: Date.now,
        fetchImpl: () => {
          return Promise.resolve(
            result({
              revision: 1,
              floor: 0,
              truncated: false,
              tags: [
                {
                  tagId: 'tag',
                  kind,
                  value: 'feed',
                  revision: 1,
                  staleAt: 1200,
                  hardExpireAt: 1200,
                  meaning: 'immediate',
                },
              ],
            }),
          );
        },
      });
      await runtime!.tags.sync(runtime!.host, 1300);

      expect(runtime?.tags.validityOf(['feed'], 1100, 1300)).toBe(
        kind === 'host-delivery' ? 'fresh' : 'expired',
      );
    },
  );

  it('expires values written in the same clock tick as an immediate invalidation', () => {
    const runtime = createCacheRuntime({ env: ENV, now: Date.now });
    runtime?.tags.applyLocal(['feed'], { staleAt: 1200, hardExpireAt: 1200 });

    expect(runtime?.tags.validityOf(['feed'], 1200, 1200)).toBe('expired');
    expect(runtime?.tags.validityOf(['feed'], 1201, 1201)).toBe('fresh');
  });

  it('keeps the preceding miss timestamp when a concurrent invalidation crosses a fetch', async () => {
    const writes: { entry: { timestamp: number } }[] = [];
    const runtime = createCacheRuntime({
      env: ENV,
      now: Date.now,
      fetchImpl: async (request) => {
        if (request.method === 'PUT') {
          writes.push((await request.json()) as { entry: { timestamp: number } });
          return result({});
        }
        if (new URL(request.url).pathname.endsWith('/tags/delta')) {
          return result({ revision: 0, floor: 0, truncated: false, tags: [] });
        }
        return new Response(null, { status: 404 });
      },
    });
    configureCacheHandlers(runtime);
    const handler = new PlatformFetchCache();
    const kept: Promise<unknown>[] = [];
    const context = {
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime,
      request: new Request('https://fixture.test/'),
      startedAt: 1000,
      publication: new Set<string>(),
      fetchStarts: new Map<string, number>(),
      waitUntil: (promise: Promise<unknown>) => {
        kept.push(promise);
      },
      run: <T>(work: () => Promise<T>) => work(),
      invalidated: new InvalidatedTags(),
      writes: new RequestWrites(),
    };
    await withRequestContext(context, async () => {
      await withClock(1100, () => handler.get('feed', { kind: 'FETCH', tags: ['feed'] }));
      runtime?.tags.applyLocal(['feed'], { staleAt: 1200, hardExpireAt: 1200 });
      await withClock(1300, () => {
        return handler.set(
          'feed',
          { kind: 'FETCH', data: 'old', revalidate: 60 },
          { fetchCache: true, tags: ['feed'] },
        );
      });
    });
    // The write goes on behind the render, in what the request handed `waitUntil`.
    await Promise.all(kept);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.entry.timestamp).toBe(1100);
    expect(runtime?.tags.validityOf(['feed'], writes[0]!.entry.timestamp, 1300)).toBe('expired');
  });

  it('uses request start when an on-demand fetch skips the read hook', async () => {
    const entryId = await dataEntryId('fetch', 'feed');
    const runtime = createCacheRuntime({ env: ENV, now: Date.now });
    const write = vi
      .spyOn(runtime!.host, 'setData')
      .mockResolvedValue({ entryId, generationId: 'written', revision: 1 });
    configureCacheHandlers(runtime);
    const kept: Promise<unknown>[] = [];
    await withRequestContext(
      {
        tables: { app: { entries: {} }, edge: { entries: {} } },
        runtime,
        request: new Request('https://fixture.test/'),
        startedAt: 1000,
        publication: new Set<string>(),
        fetchStarts: new Map(),
        waitUntil: (promise) => {
          kept.push(promise);
        },
        run: (work) => work(),
        invalidated: new InvalidatedTags(),
        writes: new RequestWrites(),
      },
      () => {
        return withClock(2000, () => {
          return new PlatformFetchCache().set(
            'feed',
            { kind: 'FETCH', data: 'old', revalidate: 60 },
            { fetchCache: true },
          );
        });
      },
    );
    await Promise.all(kept);

    const entry: unknown = expect.objectContaining({ timestamp: 1000 });

    expect(write).toHaveBeenCalledWith(expect.objectContaining({ entry }));
  });

  it('bounds cached payloads across many different keys and still serves uncached large values', async () => {
    const timestamp = Date.now();
    let payloadBytes = 2 * MIB;
    const runtime = createCacheRuntime({
      env: ENV,
      now: () => Date.now(),
      fetchImpl: async (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/tags/get')) {
          return result({ revision: 0, floor: 0, truncated: false, tags: [] });
        }
        if (url.pathname.includes('/artifacts/')) {
          return new Response(new Uint8Array(payloadBytes));
        }
        const { key } = (await request.json()) as { key: string };
        return result({
          entryId: await dataEntryId('default', key),
          generationId: key,
          dependencyRevision: 0,
          entry: { ...metadata(timestamp), handler: 'default' },
          value: { kind: 'ref', artifactId: key },
        });
      },
    });

    expect(runtime).toBeDefined();

    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    for (let index = 0; index < 70; index += 1) {
      const entry = await handler.get(`key-${index}`, []);

      expect((await new Response(entry?.value).arrayBuffer()).byteLength).toBe(payloadBytes);
    }

    expect(runtime?.dataMemo.size).toBeLessThan(5);
    expect(runtime?.dataMemo.usedBytes).toBeLessThanOrEqual(8 * MIB);

    payloadBytes = 9 * MIB;
    const large = await handler.get('large', []);

    expect((await new Response(large?.value).arrayBuffer()).byteLength).toBe(payloadBytes);
    expect(runtime?.dataMemo.get('data:use-cache|default|large')).toBeUndefined();

    runtime?.artifactMemo.set('oversized', new Uint8Array(5 * MIB));

    expect(runtime?.artifactMemo.get('oversized')).toBeUndefined();
  });

  it.each(['fetch', 'use-cache'] as const)(
    'keeps a successful %s write despite regional negative caching',
    async (kind) => {
      const entryId = await dataEntryId(kind === 'fetch' ? 'fetch' : 'default', 'key');
      let now = Date.now();
      let reads = 0;
      const runtime = createCacheRuntime({
        env: ENV,
        now: () => now,
        fetchImpl: (request) => {
          if (request.url.endsWith('/data/get')) {
            reads += 1;
            return Promise.resolve(new Response(null, { status: 404 }));
          }
          if (request.url.endsWith('/tags/get')) return Promise.resolve(result({ tags: [] }));
          return Promise.resolve(result({ entryId, generationId: 'written', revision: 1 }));
        },
      });
      configureCacheHandlers(runtime);
      const handler = useCacheHandler('default');
      const fetch = new PlatformFetchCache();
      const read = () =>
        kind === 'fetch' ? fetch.get('key', { kind: 'FETCH' }) : handler.get('key', []);

      await expect(read()).resolves.toBe(kind === 'fetch' ? null : undefined);

      const entry = { ...metadata(now), value: new Blob(['written']).stream() };
      await (kind === 'fetch'
        ? inRequest(runtime, () => {
            return fetch.set(
              'key',
              { kind: 'FETCH', data: { body: 'written' }, revalidate: 60 },
              { fetchCache: true },
            );
          })
        : handler.set('key', Promise.resolve(entry)));
      // No assumption that KV propagation is complete after a fixed 30 or 60 seconds.
      now += 70_000;
      const value = await read();

      expect(value).toBeDefined();
      expect(value).not.toBeNull();
      expect(reads).toBe(1);
      expect(runtime?.dataMemo.usedBytes).toBeLessThanOrEqual(8 * MIB);
    },
  );

  it('does not let an in-flight regional read overwrite a successful write', async () => {
    const entryId = await dataEntryId('fetch', 'key');
    const oldRead = Promise.withResolvers<Response>();
    let started = false;
    const runtime = createCacheRuntime({
      env: ENV,
      now: () => Date.now(),
      fetchImpl: async (request) => {
        if (request.url.endsWith('/data/get')) {
          started = true;
          return oldRead.promise;
        }
        if (request.url.endsWith('/tags/get')) return result({ tags: [] });
        return result({ entryId, generationId: 'new', revision: 2 });
      },
    });
    configureCacheHandlers(runtime);
    const handler = new PlatformFetchCache();
    const pending = handler.get('key', { kind: 'FETCH' });
    await vi.waitFor(() => {
      expect(started).toBe(true);
    });
    await inRequest(runtime, () => {
      return handler.set(
        'key',
        { kind: 'FETCH', data: { body: 'new' }, revalidate: 60 },
        { fetchCache: true },
      );
    });
    oldRead.resolve(new Response(null, { status: 404 }));

    await expect(pending).resolves.toMatchObject({ value: { data: { body: 'new' } } });
    await expect(handler.get('key', { kind: 'FETCH' })).resolves.toMatchObject({
      value: { data: { body: 'new' } },
    });
  });

  /**
   * A read under way is I/O of the request that started it, which the Workers runtime cancels once
   * that request is over: it never settles. A render of another request that joined it waited with
   * it, for as long as its own request was let run, where it would have read the value.
   */
  it.each(['fetch', 'use-cache'] as const)(
    'reads %s data for a request while another request is still reading the key',
    async (kind) => {
      const entryId = await dataEntryId(kind === 'fetch' ? 'fetch' : 'default', 'feed');
      const timestamp = Date.now() - 1000;
      const stored = btoa(JSON.stringify({ kind: 'FETCH', data: {}, revalidate: 60 }));
      const record = {
        entryId,
        generationId: 'generation',
        dependencyRevision: 0,
        entry: {
          ...metadata(timestamp),
          kind: kind === 'fetch' ? 'data:fetch' : 'data:use-cache',
          ...(kind !== 'fetch' && { handler: 'default' }),
        },
        value: { kind: 'inline', base64: stored },
      };
      let reads = 0;
      const runtime = createCacheRuntime({
        env: ENV,
        now: () => Date.now(),
        fetchImpl: (request) => {
          if (request.url.endsWith('/tags/get')) return Promise.resolve(result({ tags: [] }));
          reads += 1;
          // The first request's read, cancelled with its request: it never answers.
          if (reads === 1) return Promise.withResolvers<Response>().promise;
          return Promise.resolve(result(record));
        },
      });
      configureCacheHandlers(runtime);
      const handler = useCacheHandler('default');
      const read = (): Promise<unknown> => {
        return kind === 'fetch'
          ? new PlatformFetchCache().get('feed', { kind: 'FETCH' })
          : handler.get('feed', []);
      };

      const found =
        kind === 'fetch' ? { value: { kind: 'FETCH' }, lastModified: timestamp } : { timestamp };

      const stalled = read();
      await vi.waitFor(() => {
        expect(reads).toBe(1);
      });
      const answer = await settledWithin(read());

      expect(answer).toMatchObject(found);
      expect(reads).toBe(2);
      // Given up in the end, by the read's own deadline, as a miss of that request's alone: what
      // the other read found is what the key still answers with, and without a third read.
      await expect(stalled).resolves.toBe(kind === 'fetch' ? null : undefined);
      await expect(read()).resolves.toMatchObject(found);
      expect(reads).toBe(2);
    },
  );

  /**
   * Through the `use cache` handler, whose writes of a key may be out at once: the fetch cache's
   * wait for the one before (`cache-mutations.test.ts`).
   */
  it('keeps the newer committed value when write responses arrive out of order', async () => {
    const entryId = await dataEntryId('default', 'key');
    const first = Promise.withResolvers<Response>();
    let writes = 0;
    const runtime = createCacheRuntime({
      env: ENV,
      now: () => Date.now(),
      fetchImpl: (request) => {
        if (request.url.endsWith('/tags/get')) return Promise.resolve(result({ tags: [] }));
        writes += 1;
        return writes === 1
          ? first.promise
          : Promise.resolve(result({ entryId, generationId: 'newer', revision: 2 }));
      },
    });
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const entry = (body: string) =>
      Promise.resolve({ ...metadata(Date.now()), value: new Blob([body]).stream() });
    const older = handler.set('key', entry('old'));
    await vi.waitFor(() => {
      expect(writes).toBe(1);
    });
    await handler.set('key', entry('new'));
    first.resolve(result({ entryId, generationId: 'older', revision: 1 }));
    await older;

    const kept = await handler.get('key', []);

    expect(kept).toBeDefined();
    await expect(new Response(kept?.value).text()).resolves.toBe('new');
  });

  /**
   * The tags a read is asked under are known before the entry is — a `use cache` read's soft tags,
   * a `fetch` read's own tags and soft tags — so they are brought up to date while the value is read
   * rather than after it: one round trip where there were two, one after the other.
   */
  it.each(['fetch', 'use-cache'] as const)(
    'asks for the tags a %s read is asked under while the value is read',
    async (kind) => {
      const value = Promise.withResolvers<Response>();
      const asked: string[][] = [];
      const runtime = createCacheRuntime({
        env: ENV,
        now: () => Date.now(),
        fetchImpl: async (request) => {
          if (request.url.endsWith('/tags/get')) {
            const { tags } = (await request.json()) as { tags: string[] };
            asked.push(tags);
            return result({ tags: [] });
          }
          return value.promise;
        },
      });
      configureCacheHandlers(runtime);
      const reading =
        kind === 'fetch'
          ? new PlatformFetchCache().get('key', {
              kind: 'FETCH',
              tags: ['feed'],
              softTags: ['_N_T_/page'],
            })
          : useCacheHandler('default').get('key', ['_N_T_/page']);

      await vi.waitFor(() => {
        expect(asked.flat()).toContain('_N_T_/page');
      });

      value.resolve(new Response(null, { status: 404 }));

      // A miss: `null` from the fetch cache, nothing from a `use cache` handler.
      expect((await reading) ?? undefined).toBeUndefined();
    },
  );

  it('preserves updateTag on a local write while the regional projection is still stale', async () => {
    const entryId = await dataEntryId('default', 'key');
    const runtime = createCacheRuntime({
      env: ENV,
      now: () => Date.now(),
      fetchImpl: (request) => {
        if (request.url.endsWith('/tags/get')) return Promise.resolve(result({ tags: [] }));
        if (request.url.endsWith('/invalidations'))
          return Promise.resolve(
            result({
              revision: 2,
              affectedEntryIds: [entryId],
              invalidations: [
                {
                  invalidationId: 'inv',
                  tagId: 'tag',
                  value: 'feed',
                  staleAt: Date.now(),
                  hardExpireAt: Date.now(),
                  meaning: 'immediate',
                },
              ],
            }),
          );
        return Promise.resolve(result({ entryId, generationId: 'new', revision: 1 }));
      },
    });
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const entry = { ...metadata(Date.now() - 1000), value: new Blob(['before']).stream() };
    await handler.set('key', Promise.resolve(entry));

    await expect(handler.get('key', [])).resolves.toBeDefined();

    await handler.updateTags(['feed']);

    await expect(handler.get('key', [])).resolves.toBeUndefined();
  });

  it('uses the authority for a forced synchronization even after local tag checks', async () => {
    const calls: string[] = [];
    const runtime = createCacheRuntime({
      env: ENV,
      now: () => Date.now(),
      fetchImpl: (request) => {
        calls.push(request.url);
        return Promise.resolve(
          result(
            request.url.includes('/tags/delta')
              ? { revision: 9, floor: 0, truncated: false, tags: [] }
              : { tags: [] },
          ),
        );
      },
    });
    await runtime?.tags.syncLocal(runtime.host, ['feed'], Date.now());

    expect(runtime?.tags.revision).toBe(0);

    await runtime?.tags.sync(runtime.host, Date.now(), { force: true });

    expect(runtime?.tags.revision).toBe(9);
    expect(calls.map((url) => new URL(url).origin)).toStrictEqual([
      'https://local.test',
      'https://regional.test',
    ]);
  });

  it('charges serialized argument keys even when the cached result is a miss', () => {
    const runtime = createCacheRuntime({ env: ENV, now: () => Date.now() });
    const largeKey = 'x'.repeat(256 * 1024);
    for (let index = 0; index < 512; index += 1) {
      runtime?.dataMemo.set(`${index}:${largeKey}`, { kind: 'missing' });
    }

    expect(runtime?.dataMemo.usedBytes).toBeGreaterThan(0);
    expect(runtime?.dataMemo.usedBytes).toBeLessThanOrEqual(8 * MIB);
    expect(runtime?.dataMemo.size).toBeLessThan(16);
  });

  /**
   * A Worker's clock stands still between I/O completions: the write, the update and the read
   * after it all happen at one moment, which the request's own clock stands for here. The
   * authority records the update by a clock of its own, which may run ahead of this one.
   */
  it.each([
    { clock: 'in step with', ahead: 0 },
    { clock: '50 ms ahead of', ahead: 50 },
  ])(
    'does not serve a value an update invalidated in the millisecond it was written, the authority $clock the Worker',
    async ({ ahead }) => {
      const now = Date.now();
      const stored = new Map<string, string>();
      const runtime = createCacheRuntime({
        env: ENV,
        now: () => now,
        fetchImpl: async (request) => {
          const url = new URL(request.url);
          if (url.pathname.endsWith('/tags/delta')) {
            return result({ revision: 0, floor: 0, truncated: false, tags: [] });
          }
          if (url.pathname.endsWith('/tags/get')) {
            return result({ tags: [] });
          }
          if (url.pathname.endsWith('/invalidations')) {
            // As the authority answers an `updateTag`: the invalidation, by the authority's clock.
            return result({
              revision: 2,
              invalidations: [
                {
                  invalidationId: 'inv',
                  tagId: 'tag',
                  value: 'feed',
                  staleAt: now + ahead,
                  hardExpireAt: now + ahead,
                  meaning: 'immediate',
                },
              ],
              affectedEntryIds: [],
            });
          }
          if (request.method === 'PUT') {
            const { key, entry, valueBase64 } = (await request.json()) as {
              key: string;
              entry: ReturnType<typeof metadata>;
              valueBase64: string;
            };
            stored.set(key, JSON.stringify({ entry, valueBase64 }));
            return result({
              entryId: await dataEntryId('default', key),
              generationId: key,
              revision: 1,
            });
          }
          const { key } = (await request.json()) as { key: string };
          const record = stored.get(key);
          if (record === undefined) {
            return new Response(null, { status: 404 });
          }
          const { entry, valueBase64 } = JSON.parse(record) as {
            entry: ReturnType<typeof metadata>;
            valueBase64: string;
          };
          return result({
            entryId: await dataEntryId('default', key),
            generationId: key,
            dependencyRevision: 0,
            entry,
            value: { kind: 'inline', base64: valueBase64 },
          });
        },
      });
      configureCacheHandlers(runtime);
      const handler = useCacheHandler('default');

      const read = await withClock(now, async () => {
        await handler.set(
          'posts',
          Promise.resolve({
            ...metadata(now),
            value: new Blob(['before the update']).stream(),
          }),
        );
        const written = await handler.get('posts', []);
        await handler.updateTags(['feed']);
        return { written, updated: await handler.get('posts', []) };
      });

      expect(read.written?.timestamp).toBe(now);
      expect(read.updated).toBeUndefined();
    },
  );

  /**
   * A regenerated route must read fresh data. Next's request stores can use stale fetch and
   * `use cache` values while refreshing them behind the render, so a host's regeneration must
   * force a miss. Visitor renders keep that stale value while the replacement is computed.
   */
  it('misses stale fetch data for an ordinary regeneration while keeping visitor SWR', async () => {
    configureCacheHandlers(await staleRuntime('fetch'));
    const cache = new PlatformFetchCache();

    await expect(cache.get('feed', { kind: 'FETCH' })).resolves.toMatchObject({
      lastModified: 0,
    });
    await expect(asRegeneration(() => cache.get('feed', { kind: 'FETCH' }))).resolves.toBeNull();
  });

  it.each(['default', 'remote'] as const)(
    'misses stale %s use-cache data for an ordinary regeneration while keeping visitor SWR',
    async (kind) => {
      configureCacheHandlers(await staleRuntime(kind));
      const handler = useCacheHandler(kind);
      const visitor = await handler.get('feed', []);

      expect(visitor).toMatchObject({ revalidate: -1 });

      await visitor?.value.cancel();

      await expect(asRegeneration(() => handler.get('feed', []))).resolves.toBeUndefined();
    },
  );

  /**
   * A gateway malformed or of another version can answer a read with a value of another namespace
   * than it asked in: `default`'s, to a read of `remote` or of the fetch cache. Kept as the value of
   * the key read, it would be served as that one's; it is a failed read instead, which is a miss.
   */
  it('serves no value a read was answered with from another namespace', async () => {
    const timestamp = Date.now() - 1000;
    const stored = btoa(JSON.stringify({ kind: 'FETCH', data: {}, revalidate: 60 }));
    const runtime = createCacheRuntime({
      env: ENV,
      now: () => Date.now(),
      fetchImpl: async (request) => {
        if (new URL(request.url).pathname.endsWith('/tags/get')) {
          return result({ tags: [] });
        }
        const input = (await request.json()) as {
          key: string;
          kind: 'data:fetch' | 'data:use-cache';
          handler?: 'default' | 'remote';
        };
        const entryId = await dataEntryId(
          input.kind === 'data:fetch' ? 'fetch' : (input.handler ?? 'default'),
          input.key,
        );
        return result({
          entryId,
          generationId: 'generation',
          dependencyRevision: 0,
          entry: { ...metadata(timestamp), handler: 'default' },
          value: { kind: 'inline', base64: stored },
        });
      },
    });
    configureCacheHandlers(runtime);

    await expect(useCacheHandler('remote').get('feed', [])).resolves.toBeUndefined();
    await expect(new PlatformFetchCache().get('feed', { kind: 'FETCH' })).resolves.toBeNull();

    const own = await useCacheHandler('default').get('feed', []);

    expect(own).toBeDefined();

    await own?.value.cancel();
  });

  /**
   * A gateway malformed or of another version can answer a read of `feed`'s tag with a record of
   * another: taken in, `feed` would be held as invalidated by nothing, and a value under it served
   * as fresh however it stood. It is a failed read instead, and the value a miss.
   */
  it('serves no value whose tag read was answered with a record of a tag it did not ask about', async () => {
    const entryId = await dataEntryId('fetch', 'feed');
    const timestamp = Date.now() - 1000;
    const stored = btoa(JSON.stringify({ kind: 'FETCH', data: {}, revalidate: 60 }));
    const runtime = createCacheRuntime({
      env: ENV,
      now: () => Date.now(),
      fetchImpl: (request) => {
        if (new URL(request.url).pathname.endsWith('/tags/get')) {
          const other = {
            tagId: 'tag',
            kind: 'next-explicit',
            value: 'Feed',
            revision: 1,
            staleAt: timestamp + 1,
            hardExpireAt: timestamp + 1,
            meaning: 'immediate',
          };
          return Promise.resolve(result({ tags: [other] }));
        }
        return Promise.resolve(
          result({
            entryId,
            generationId: 'generation',
            dependencyRevision: 0,
            entry: { ...metadata(timestamp), kind: 'data:fetch' },
            value: { kind: 'inline', base64: stored },
          }),
        );
      },
    });
    configureCacheHandlers(runtime);

    await expect(new PlatformFetchCache().get('feed', { kind: 'FETCH' })).resolves.toBeNull();
  });

  it('uses the regional endpoint for old deployments without a read URL', async () => {
    const calls: string[] = [];
    const runtime = createCacheRuntime({
      env: { ...ENV, ARKOR_CACHE_READ_GATEWAY_URL: undefined },
      now: () => Date.now(),
      fetchImpl: (request) => {
        calls.push(request.url);
        return Promise.resolve(new Response(null, { status: 404 }));
      },
    });
    await runtime?.host.readRecord('entry');

    expect(calls).toStrictEqual([
      'https://regional.test/v1/scopes/scope-test/entries/entry/record',
    ]);
  });
});

/** A `use cache` entry as Next.js hands one over once its function has returned. */
function useCacheEntry(timestamp: number) {
  return {
    value: new Blob([new TextEncoder().encode('"fresh"')]).stream(),
    tags: ['feed'],
    stale: 60,
    timestamp,
    expire: 600,
    revalidate: 60,
  };
}

/**
 * Next.js revalidates a stale value behind the render that read it, by work it hands the request's
 * `waitUntil` only where the read came before the render's stream was made: a value read in a part
 * of the page streamed after was revalidated by work that ended with the request, and the key was
 * answered stale for as long as the isolate lived. The request answered with it is kept going
 * until that revalidation, which runs in it, has set the key again.
 */
describe('a request answered with a stale value', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['default', 'remote'] as const)(
    'is kept going until the %s use-cache key is set again',
    async (kind) => {
      const runtime = await staleRuntime(kind);
      configureCacheHandlers(runtime);
      const handler = useCacheHandler(kind);
      const kept: Promise<unknown>[] = [];
      const context = requestKeeping(runtime, kept);

      const stale = await withRequestContext(context, () => handler.get('feed', []));

      expect(stale).toMatchObject({ revalidate: -1 });

      await stale?.value.cancel();

      await expect(settledWithin(Promise.allSettled(kept))).resolves.toBe('still waiting');

      const revalidated = Promise.resolve(useCacheEntry(Date.now()));
      await withRequestContext(context, () => handler.set('feed', revalidated));

      await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
    },
  );

  it("is kept going through another request's write of the key", async () => {
    const runtime = await staleRuntime('default');
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);
    const stale = await withRequestContext(context, () => handler.get('feed', []));
    await stale?.value.cancel();

    const elsewhere = Promise.resolve(useCacheEntry(Date.now()));
    await withRequestContext(requestKeeping(runtime, []), () => handler.set('feed', elsewhere));

    await expect(settledWithin(Promise.allSettled(kept))).resolves.toBe('still waiting');

    const revalidated = Promise.resolve(useCacheEntry(Date.now()));
    await withRequestContext(context, () => handler.set('feed', revalidated));

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  it('is kept going until the fetch cache key is set again', async () => {
    const runtime = await staleRuntime('fetch');
    configureCacheHandlers(runtime);
    const cache = new PlatformFetchCache();
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);

    await expect(
      withRequestContext(context, () => cache.get('feed', { kind: 'FETCH' })),
    ).resolves.toMatchObject({ lastModified: 0 });
    await expect(settledWithin(Promise.allSettled(kept))).resolves.toBe('still waiting');

    await withRequestContext(context, () =>
      cache.set('feed', { kind: 'FETCH', data: {}, revalidate: 60 }, { fetchCache: true }),
    );

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  it("lets the request go a lifetime after its response's end, where nothing has set the key", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtime = await staleRuntime('default');
    configureCacheHandlers(runtime);
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);
    const stale = await withRequestContext(context, () =>
      useCacheHandler('default').get('feed', []),
    );
    await stale?.value.cancel();
    await context.writes.landed(0);
    let lapsed = false;
    const watched = (async () => {
      await Promise.allSettled(kept);
      lapsed = true;
    })();

    await vi.advanceTimersByTimeAsync(29_999);

    expect(lapsed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await watched;

    expect(lapsed).toBe(true);
  });

  it('is not kept going where a regeneration misses the stale value', async () => {
    const runtime = await staleRuntime('remote');
    configureCacheHandlers(runtime);
    const kept: Promise<unknown>[] = [];

    await expect(
      withRequestContext(requestKeeping(runtime, kept), () =>
        asRegeneration(() => useCacheHandler('remote').get('feed', [])),
      ),
    ).resolves.toBeUndefined();
    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  /** Native production use-cache handlers miss past revalidate, including shared storage. */
  it.each(['default', 'remote'] as const)(
    'misses a %s use-cache value past revalidate without holding background work',
    async (kind) => {
      const runtime = await agedRuntime(kind);
      configureCacheHandlers(runtime);
      const handler = useCacheHandler(kind);
      const kept: Promise<unknown>[] = [];
      const context = requestKeeping(runtime, kept);

      const aged = await withRequestContext(context, () => handler.get('feed', []));

      expect(aged).toBeUndefined();
      await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');

      const revalidated = Promise.resolve(useCacheEntry(Date.now()));
      await withRequestContext(context, () => handler.set('feed', revalidated));
      const fresh = await withRequestContext(context, () => handler.get('feed', []));

      expect(fresh).toMatchObject({ revalidate: 60 });

      await fresh?.value.cancel();

      await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
    },
  );

  /** As `IncrementalCache` judges a value's age: by the call's `revalidate` where it gives one. */
  it.each([
    { revalidate: undefined, held: true },
    { revalidate: 30, held: true },
    { revalidate: 300, held: false },
  ])(
    'is kept going where the fetched value is past the revalidate it is read with ($revalidate)',
    async ({ revalidate, held }) => {
      const runtime = await agedRuntime('fetch');
      configureCacheHandlers(runtime);
      const cache = new PlatformFetchCache();
      const kept: Promise<unknown>[] = [];
      const context = requestKeeping(runtime, kept);

      await withRequestContext(context, () => cache.get('feed', { kind: 'FETCH', revalidate }));
      const waiting = (await settledWithin(Promise.allSettled(kept))) === 'still waiting';

      expect(waiting).toBe(held);

      // Let a request held go, as its revalidation would: nothing is left held past the test.
      await withRequestContext(context, () =>
        cache.set('feed', { kind: 'FETCH', data: {}, revalidate: 60 }, { fetchCache: true }),
      );
    },
  );

  /**
   * The first request's revalidation set nothing — it failed, say — and Next.js began one behind the
   * second's answer: the second is held for its own lifetime, not to the end of the first's.
   */
  it('keeps a request answered after another going for a revalidation of its own', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtime = await staleRuntime('default');
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const answered = requestKeeping(runtime, []);
    const first = await withRequestContext(answered, () => handler.get('feed', []));
    await first?.value.cancel();
    await answered.writes.landed(0);
    await vi.advanceTimersByTimeAsync(29_000);
    const kept: Promise<unknown>[] = [];
    const second = requestKeeping(runtime, kept);
    const stale = await withRequestContext(second, () => handler.get('feed', []));
    await stale?.value.cancel();
    let released = false;
    const watched = (async () => {
      await Promise.allSettled(kept);
      released = true;
    })();

    await vi.advanceTimersByTimeAsync(1500);

    expect(released).toBe(false);

    const revalidated = Promise.resolve(useCacheEntry(Date.now()));
    await withRequestContext(second, () => handler.set('feed', revalidated));
    await watched;

    expect(released).toBe(true);
  });

  it('answers a stale value where its request can be kept going no longer', async () => {
    const runtime = await staleRuntime('fetch');
    configureCacheHandlers(runtime);
    const ended = {
      ...requestKeeping(runtime, []),
      waitUntil: () => {
        throw new Error('the invocation has ended');
      },
    };

    await expect(
      withRequestContext(ended, () => new PlatformFetchCache().get('feed', { kind: 'FETCH' })),
    ).resolves.toMatchObject({ lastModified: 0 });
  });

  /** A published regeneration must compute fresh data, including stores where Next permits SWR. */
  it('misses a value past its revalidate without keeping a regeneration going', async () => {
    const runtime = await agedRuntime('default');
    configureCacheHandlers(runtime);
    const kept: Promise<unknown>[] = [];

    const aged = await withRequestContext(requestKeeping(runtime, kept), () =>
      asRegeneration(() => useCacheHandler('default').get('feed', [])),
    );

    expect(aged).toBeUndefined();

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  /** Next.js revalidates a key one at a time in an isolate: its write lets every request go. */
  it('lets every request held for a key go once a revalidation of it has landed', async () => {
    const runtime = await staleRuntime('default');
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const kept: Promise<unknown>[] = [];
    const first = requestKeeping(runtime, kept);
    const firstAnswer = await withRequestContext(first, () => handler.get('feed', []));
    await firstAnswer?.value.cancel();
    const secondAnswer = await withRequestContext(requestKeeping(runtime, kept), () =>
      handler.get('feed', []),
    );
    await secondAnswer?.value.cancel();

    await expect(settledWithin(Promise.allSettled(kept))).resolves.toBe('still waiting');

    const revalidated = Promise.resolve(useCacheEntry(Date.now()));
    await withRequestContext(first, () => handler.set('feed', revalidated));

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  /** A primary read follows the same native age miss, then keeps its replacement. */
  it('misses an aged primary value without holding a background revalidation', async () => {
    const primary = new AsyncLocalStorage<true>();
    installResourcePrimaryReadStorage(primary);
    const runtime = await agedRuntime('default');
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);
    const aged = await primary.run(true, () =>
      withRequestContext(context, () => handler.get('feed', [])),
    );

    expect(aged).toBeUndefined();
    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');

    const revalidated = Promise.resolve(useCacheEntry(Date.now()));
    await primary.run(true, () =>
      withRequestContext(context, () => handler.set('feed', revalidated)),
    );

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  /** The clock moves 200 ms while storage answers; native expiry is judged after that read. */
  it('misses a value that crossed revalidate while storage was answering', async () => {
    const base = performance.now();
    let read = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => base + read);
    const runtime = await servingRuntime('default', {
      timestamp: Math.round(performance.timeOrigin + base) - 59_900,
      tags: [],
      onRead: () => {
        read = 200;
      },
    });
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);

    const answer = await withRequestContext(context, () => handler.get('feed', []));

    expect(answer).toBeUndefined();
    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');

    const revalidated = Promise.resolve(useCacheEntry(Date.now()));
    await withRequestContext(context, () => handler.set('feed', revalidated));

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  /** The write is the revalidation the others are held for, whether or not its request still is. */
  it("lets the requests still held go once a write lands whose request's own hold lapsed", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtime = await staleRuntime('default');
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const writer = requestKeeping(runtime, []);
    const first = await withRequestContext(writer, () => handler.get('feed', []));
    await first?.value.cancel();
    await writer.writes.landed(0);
    await vi.advanceTimersByTimeAsync(25_000);
    const kept: Promise<unknown>[] = [];
    const second = await withRequestContext(requestKeeping(runtime, kept), () =>
      handler.get('feed', []),
    );
    await second?.value.cancel();
    await vi.advanceTimersByTimeAsync(6000);
    let released = false;
    const watched = (async () => {
      await Promise.allSettled(kept);
      released = true;
    })();

    const revalidated = Promise.resolve(useCacheEntry(Date.now()));
    await withRequestContext(writer, () => handler.set('feed', revalidated));
    await vi.advanceTimersByTimeAsync(1000);

    expect(released).toBe(true);

    await watched;
  });

  /**
   * The host keeps a request's `waitUntil` work going for a while from its response's end, however
   * long the response streamed: the hold counts its lifetime from there too.
   */
  it('keeps a request going a lifetime past the end of a response that streamed long', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtime = await staleRuntime('default');
    configureCacheHandlers(runtime);
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(runtime, kept);
    const stale = await withRequestContext(context, () =>
      useCacheHandler('default').get('feed', []),
    );
    await stale?.value.cancel();
    let released = false;
    const watched = (async () => {
      await Promise.allSettled(kept);
      released = true;
    })();

    await vi.advanceTimersByTimeAsync(40_000);
    await context.writes.landed(0);
    await vi.advanceTimersByTimeAsync(29_000);

    expect(released).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await watched;

    expect(released).toBe(true);
  });

  /** Next.js takes a `use cache` value past its `expire` for a miss, and computes it in front. */
  it('is not kept going where the use-cache value is past its expire', async () => {
    const runtime = await servingRuntime('default', { timestamp: Date.now() - 700_000, tags: [] });
    configureCacheHandlers(runtime);
    const kept: Promise<unknown>[] = [];

    const expired = await withRequestContext(requestKeeping(runtime, kept), () =>
      useCacheHandler('default').get('feed', []),
    );

    expect(expired).toBeUndefined();

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  /**
   * Next.js hands the handler its entry before the value has been collected: a request answered
   * stale meanwhile is held for the same write, and goes with it.
   */
  it('lets a request answered stale while the entry was collected go with the write', async () => {
    const runtime = await staleRuntime('default');
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const first = requestKeeping(runtime, []);
    const firstAnswer = await withRequestContext(first, () => handler.get('feed', []));
    await firstAnswer?.value.cancel();
    const collected = Promise.withResolvers<ReturnType<typeof useCacheEntry>>();
    const setting = withRequestContext(first, () => handler.set('feed', collected.promise));
    const kept: Promise<unknown>[] = [];
    const meanwhile = await withRequestContext(requestKeeping(runtime, kept), () =>
      handler.get('feed', []),
    );
    await meanwhile?.value.cancel();

    await expect(settledWithin(Promise.allSettled(kept))).resolves.toBe('still waiting');

    collected.resolve(useCacheEntry(Date.now()));
    await setting;

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });

  /** A hold its request could not be kept going for leaves no timer of its own behind. */
  it('leaves no timer behind where the request can be kept going no longer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const runtime = await staleRuntime('default');
    configureCacheHandlers(runtime);
    const ended = {
      ...requestKeeping(runtime, []),
      waitUntil: () => {
        throw new Error('the invocation has ended');
      },
    };
    const stale = await withRequestContext(ended, () => useCacheHandler('default').get('feed', []));
    await stale?.value.cancel();

    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * A read under way as a write of the key is handed over is fenced by that write and answered with
   * what the write carries: it is never answered stale once the write has begun, so no request is
   * held for a write it came too late to be told of.
   */
  it('holds nothing for a read under way as a write of the key is handed over', async () => {
    const read = Promise.withResolvers<undefined>();
    const runtime = await staleRuntime('default', { onRead: () => read.promise });
    configureCacheHandlers(runtime);
    const handler = useCacheHandler('default');
    const kept: Promise<unknown>[] = [];
    const answering = withRequestContext(requestKeeping(runtime, kept), () =>
      handler.get('feed', []),
    );
    await settledWithin(answering);
    const written = Promise.resolve(useCacheEntry(Date.now()));
    await withRequestContext(requestKeeping(runtime, []), () => handler.set('feed', written));

    read.resolve(undefined);

    const answer = await answering;

    expect(answer).toMatchObject({ revalidate: 60 });

    await answer?.value.cancel();

    await expect(settledWithin(Promise.allSettled(kept))).resolves.not.toBe('still waiting');
  });
});
