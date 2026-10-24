/// <reference types="next" />

import { deriveEntry } from '@stayingupwind/core/cache';
import { INFINITE_CACHE } from 'next/dist/lib/constants.js';
import {
  type WorkStore,
  workAsyncStorage,
} from 'next/dist/server/app-render/work-async-storage.external.js';
import {
  workUnitAsyncStorage,
  type WorkUnitStore,
} from 'next/dist/server/app-render/work-unit-async-storage.external.js';
import {
  type CacheHandler,
  IncrementalCache,
} from 'next/dist/server/lib/incremental-cache/index.js';
import { createPatchedFetcher } from 'next/dist/server/lib/patch-fetch.js';
import { createPrerenderResumeDataCache } from 'next/dist/server/resume-data-cache/resume-data-cache.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_INLINE_DATA_VALUE_BYTES } from '../../host/src/cache/gateway-contract.ts';
import { asRegeneration, withRequestContext } from '../src/cache/context.ts';
import {
  configureCacheHandlers,
  PlatformFetchCache,
  useCacheHandler,
} from '../src/cache/handlers.ts';
import { createCacheRuntime } from '../src/cache/runtime.ts';
import { inRequest, requestKeeping } from './request-context.ts';

// Next.js's storages read the global once, as they are evaluated, and settle for a fake without it:
// it is published before any of Next.js is, as the banner of the Function's bundle publishes it.
await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  Reflect.set(globalThis, 'AsyncLocalStorage', AsyncLocalStorage);
});

const KIB = 1024;
const MIB = KIB * KIB;
const FETCH_CONTEXT = { fetchCache: true };
const NEXT_PATCH_SYMBOL = Symbol.for('next-patch');

function result(value: unknown): Response {
  return Response.json({ ok: true, result: value });
}

function committed(revision: number): Response {
  return result({ generationId: `generation-${revision}`, revision });
}

function harness(kind: 'fetch' | 'use-cache' = 'use-cache', lifetimeSeconds = 1) {
  let now = Date.now();
  let reads = 0;
  const writes: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
  let read = (): Promise<Response> => Promise.resolve(new Response(null, { status: 404 }));
  const written: Request[] = [];
  const artifacts = new Map<string, Uint8Array<ArrayBuffer>>();
  /** Like the authority, return large values by reference while keeping the mutation controls. */
  const valueFor = (body: string) => {
    const value =
      kind === 'fetch' ? JSON.stringify({ kind: 'FETCH', data: { body }, revalidate: 60 }) : body;
    if (value.length <= MAX_INLINE_DATA_VALUE_BYTES) {
      return { kind: 'inline' as const, base64: btoa(value) };
    }
    const artifactId = crypto.randomUUID();
    artifacts.set(artifactId, new TextEncoder().encode(value));
    return { kind: 'ref' as const, artifactId };
  };
  /** The mock authority names every requested key by its core identity, on reads and writes. */
  const answerFor = async (request: Request, pending: Promise<Response>): Promise<Response> => {
    const [answer, input] = await Promise.all([
      pending,
      request.clone().json() as Promise<{ readonly key: string }>,
    ]);
    if (!answer.ok) return answer;
    const descriptor =
      kind === 'fetch'
        ? { kind: 'data:fetch' as const, key: input.key }
        : { kind: 'data:use-cache' as const, handler: 'default', key: input.key };
    const { entryId } = await deriveEntry('scope-test', descriptor);
    const body = (await answer.json()) as { readonly result: Record<string, unknown> };
    return result({ ...body.result, entryId });
  };
  const runtime = createCacheRuntime({
    env: {
      NEXT_DEPLOYMENT_ID: 'scope-test',
      ARKOR_CACHE_GATEWAY_URL: 'https://authority.test',
      ARKOR_CACHE_READ_GATEWAY_URL: 'https://regional.test',
      ARKOR_CACHE_TOKEN: 'scope-token',
    },
    now: () => now,
    fetchImpl: (request) => {
      if (request.url.endsWith('/tags/get')) return Promise.resolve(result({ tags: [] }));
      if (request.url.endsWith('/data/get')) {
        reads += 1;
        return answerFor(request, read());
      }
      if (request.method === 'GET' && request.url.includes('/artifacts/')) {
        const artifactId = request.url.slice(request.url.lastIndexOf('/') + 1);
        const bytes = artifacts.get(artifactId);
        return Promise.resolve(
          bytes === undefined
            ? new Response(null, { status: 404 })
            : new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } }),
        );
      }
      const pending = Promise.withResolvers<Response>();
      writes.push(pending);
      written.push(request.clone());
      return answerFor(request, pending.promise);
    },
  });
  if (runtime === undefined) throw new Error('no runtime');
  vi.spyOn(runtime, 'log').mockImplementation(vi.fn());
  configureCacheHandlers(runtime);
  const fetch = new PlatformFetchCache();
  const cache = useCacheHandler('default');
  const metadata = (lifetime = lifetimeSeconds) => {
    return {
      tags: [],
      timestamp: now,
      stale: 1,
      expire: lifetime,
      revalidate: lifetime,
    };
  };
  return {
    runtime,
    writes,
    memoKey: kind === 'fetch' ? 'data:fetch||key' : 'data:use-cache|default|key',
    reads: () => reads,
    /** The keys the writes started so far are for, in the order they went out. */
    writtenKeys: (): Promise<string[]> => {
      return Promise.all(
        written.map(async (request) => ((await request.clone().json()) as { key: string }).key),
      );
    },
    clock: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    onRead: (response: () => Promise<Response>) => {
      read = response;
    },
    reply: (body: string, revision: number, lifetime = lifetimeSeconds): Response => {
      return result({
        generationId: `generation-${revision}`,
        dependencyRevision: revision,
        entry: {
          ...metadata(lifetime),
          kind: kind === 'fetch' ? 'data:fetch' : 'data:use-cache',
          ...(kind === 'use-cache' && { handler: 'default' }),
          dependencyCoverage: 'complete',
        },
        value: valueFor(body),
      });
    },
    get: async (key = 'key'): Promise<string | undefined> => {
      if (kind === 'fetch') {
        const value = await fetch.get(key, { kind: 'FETCH' });
        return (value?.value.data as { body: string } | undefined)?.body;
      }
      const value = await cache.get(key, []);
      return value === undefined ? undefined : new Response(value.value).text();
    },
    put: (body: string, key = 'key'): Promise<void> => {
      return kind === 'fetch'
        ? inRequest(runtime, () =>
            fetch.set(key, { kind: 'FETCH', data: { body }, revalidate: 60 }, FETCH_CONTEXT),
          )
        : cache.set(key, Promise.resolve({ ...metadata(), value: new Blob([body]).stream() }));
    },
    /** A `use cache` entry handed over before the function has returned it, given later. */
    putLater: (key = 'key') => {
      const entry = Promise.withResolvers<Awaited<Parameters<typeof cache.set>[1]>>();
      return {
        set: (): Promise<void> => cache.set(key, entry.promise),
        give: (body: string, expire = metadata().expire) => {
          const given = { ...metadata(), expire, value: new Blob([body]).stream() };
          entry.resolve(given);
          return given;
        },
      };
    },
  };
}

async function writesStarted(h: ReturnType<typeof harness>, count: number): Promise<void> {
  await vi.waitFor(() => {
    expect(h.writes).toHaveLength(count);
  });
}

/** Force real metadata eviction through unrelated reads, without manipulating cache internals. */
async function otherKeys(
  h: ReturnType<typeof harness>,
  keyLength = 1,
  prefix = 'other',
): Promise<void> {
  h.onRead(() => Promise.resolve(new Response(null, { status: 404 })));
  for (let index = 0; index < 520; index += 1) {
    await h.get(`${prefix}-${index}-${'x'.repeat(keyLength)}`);
  }
}

async function finishReadBeforeFailure(
  arrival: 'before' | 'after',
  remote: ReturnType<typeof Promise.withResolvers<Response>>,
  read: Promise<string | undefined>,
  response: Response,
): Promise<void> {
  if (arrival !== 'before') return;
  remote.resolve(response);
  await read;
}

async function loseNewerBytes(
  h: ReturnType<typeof harness>,
  loss: 'oversized' | 'evicted' | 'expired',
): Promise<void> {
  if (loss === 'expired') h.advance(6000);
  else if (loss === 'evicted') {
    // Referenced values charge their bytes, without the former inline base64 copy: exceed 8 MiB.
    h.onRead(() => Promise.resolve(h.reply('f'.repeat(5 * MIB), 1)));
    await h.get('filler-a');
    await h.get('filler-b');
  }
}

function finishEvictedWrite(h: ReturnType<typeof harness>, outcome: 'success' | 'failure'): void {
  if (outcome === 'success') h.writes[0]!.resolve(committed(2));
  else h.writes[0]!.reject(new Error('reply lost after commit'));
}

describe('local data state across overlapping reads and writes', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    vi.restoreAllMocks();
  });

  it.each(['fetch', 'use-cache'] as const)(
    'drops the old %s memo when a committed write loses its reply',
    async (kind) => {
      const h = harness(kind);
      h.onRead(() => Promise.resolve(h.reply('old', 1)));

      await expect(h.get()).resolves.toBe('old');

      const write = h.put('new');
      await writesStarted(h, 1);
      const atStart = h.runtime.dataMemo.get(h.memoKey);
      h.onRead(() => Promise.resolve(h.reply('new', 2)));
      h.writes[0]!.reject(new Error('committed, but the reply was lost'));
      await write;

      expect(atStart).toBeUndefined();
      expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();
      await expect(h.get()).resolves.toBe('new');
      expect(h.reads()).toBe(2);
    },
  );

  it.each([
    { arrival: 'before' as const, expected: 'old' },
    { arrival: 'after' as const, expected: undefined },
  ])(
    'fences a read started during a write that finishes $arrival the lost reply',
    async ({ arrival, expected }) => {
      const h = harness();
      const write = h.put('new');
      await writesStarted(h, 1);
      const remote = Promise.withResolvers<Response>();
      h.onRead(() => remote.promise);
      const read = h.get();
      await vi.waitFor(() => {
        expect(h.reads()).toBe(1);
      });
      await finishReadBeforeFailure(arrival, remote, read, h.reply('old', 1));
      h.writes[0]!.reject(new Error('committed, but the reply was lost'));
      await write;
      remote.resolve(h.reply('old', 1));
      const value = await read;

      expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();

      expect(value).toBe(expected);
    },
  );

  it.each(['oversized', 'evicted', 'expired'] as const)(
    'rejects an older write reply when the newer bytes were %s',
    async (loss) => {
      const h = harness();
      const older = h.put('old');
      await writesStarted(h, 1);
      const newer = h.put(loss === 'oversized' ? 'n'.repeat(3 * MIB) : 'new');
      await writesStarted(h, 2);
      h.writes[1]!.resolve(committed(2));
      await newer;
      try {
        await loseNewerBytes(h, loss);

        expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();
      } finally {
        h.writes[0]!.resolve(committed(1));
        await older;
      }

      expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();

      h.onRead(() => Promise.resolve(h.reply('stale-regional-value', 1)));

      await expect(h.get()).resolves.toBeUndefined();
    },
  );

  it('does not return an older in-flight read when a newer write exceeds the byte budget', async () => {
    const h = harness();
    const remote = Promise.withResolvers<Response>();
    h.onRead(() => remote.promise);
    const read = h.get();
    await vi.waitFor(() => {
      expect(h.reads()).toBe(1);
    });
    const write = h.put('n'.repeat(3 * MIB));
    await writesStarted(h, 1);
    h.writes[0]!.resolve(committed(2));
    await write;
    remote.resolve(h.reply('old', 1));

    await expect(read).resolves.toBeUndefined();
    expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();
  });

  /**
   * Other keys push the state out of the LRU while the write is in flight, and the write keeps it
   * all the same: the read that begins meanwhile is fenced on the write's own state, and answers
   * with what the write committed, or with a miss when its reply was lost — never the older value.
   */
  it.each([
    { outcome: 'success' as const, expected: 'new' },
    { outcome: 'failure' as const, expected: undefined },
  ])(
    'fences a read begun during a write whose state other keys evicted, when it ends in $outcome',
    async ({ outcome, expected }) => {
      const h = harness();
      const write = h.put('new');
      await writesStarted(h, 1);
      await otherKeys(h);

      expect(h.runtime.dataStates.get(h.memoKey)).toBeUndefined();

      const remote = Promise.withResolvers<Response>();
      h.onRead(() => remote.promise);
      const read = h.get();
      await vi.waitFor(() => {
        expect(h.reads()).toBe(521);
      });
      finishEvictedWrite(h, outcome);
      await write;
      remote.resolve(h.reply('old', 1));

      await expect(read).resolves.toBe(expected);
    },
  );

  it('bounds mutation state by count and bytes without admitting an evicted write token', async () => {
    const h = harness();
    const older = h.put('old');
    await writesStarted(h, 1);
    const newer = h.put('new');
    await writesStarted(h, 2);
    h.writes[1]!.resolve(committed(2));
    await newer;
    await otherKeys(h, KIB);

    expect(h.runtime.dataStates.get(h.memoKey)).toBeUndefined();
    expect(h.runtime.dataStates.size).toBeLessThanOrEqual(512);
    expect(h.runtime.dataStates.usedBytes).toBeLessThanOrEqual(128 * KIB);

    h.writes[0]!.resolve(committed(1));
    await older;

    expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();
  });

  it('shares observed revisions with outstanding writes across repeated metadata eviction', async () => {
    const h = harness();
    const older = h.put('old');
    await writesStarted(h, 1);
    const newer = h.put('new');
    await writesStarted(h, 2);
    await otherKeys(h);

    expect(h.runtime.dataStates.get(h.memoKey)).toBeUndefined();

    h.writes[1]!.resolve(committed(2));
    await newer;
    await otherKeys(h, 1, 'second-eviction');

    expect(h.runtime.dataStates.get(h.memoKey)).toBeUndefined();

    h.writes[0]!.resolve(committed(1));
    await older;
    h.onRead(() => Promise.resolve(h.reply('stale-regional-value', 1)));

    await expect(h.get()).resolves.toBeUndefined();
    expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();
  });

  /**
   * The newer write starts after the older one's state went to other keys, and its own state and
   * bytes go the same way before the older reply lands: that reply must still find the newer
   * write's floor, or a regional read behind it rolls the key back.
   */
  it('keeps a newer write’s floor for an older write whose state was evicted before it began', async () => {
    const h = harness();
    const older = h.put('old');
    await writesStarted(h, 1);
    await otherKeys(h);
    const newer = h.put('new');
    await writesStarted(h, 2);
    h.writes[1]!.resolve(committed(2));
    await newer;
    await otherKeys(h, 1, 'second-eviction');
    await loseNewerBytes(h, 'expired');
    h.writes[0]!.resolve(committed(1));
    await older;
    h.onRead(() => Promise.resolve(h.reply('stale-regional-value', 1)));

    await expect(h.get()).resolves.toBeUndefined();
    expect(h.runtime.dataWrites.size).toBe(0);
  });

  /**
   * A retried write the authority found unchanged, on a generation an `updateTag` condemned since:
   * it is remembered as the read would answer it, even where the tag's projection has not arrived.
   */
  it('does not remember as fresh an unchanged write whose generation was condemned', async () => {
    const h = harness();
    const write = h.put('same');
    await writesStarted(h, 1);
    h.writes[0]!.resolve(
      result({
        generationId: 'generation-1',
        revision: 1,
        invalidation: { revision: 2, staleAt: h.clock(), hardExpireAt: h.clock() },
      }),
    );
    await write;

    await expect(h.get()).resolves.toBeUndefined();
    expect(h.reads()).toBe(0);
  });

  /**
   * Concurrent misses are not coalesced: a read under way is I/O of the request that started it,
   * which may be cancelled with that request before it answers. Once one has answered, the memo
   * answers for it.
   */
  it('reads for each concurrent miss and answers a hot hit without another request', async () => {
    const h = harness();
    const remote = Promise.withResolvers<undefined>();
    h.onRead(async () => {
      await remote.promise;
      return h.reply('shared', 1);
    });
    const first = h.get();
    const second = h.get();
    await vi.waitFor(() => {
      expect(h.reads()).toBe(2);
    });
    remote.resolve(undefined);

    await expect(first).resolves.toBe('shared');
    await expect(second).resolves.toBe('shared');
    await expect(h.get()).resolves.toBe('shared');
    expect(h.reads()).toBe(2);
  });

  /**
   * Two reads of one key under way at once can be answered differently: one finds the value, the
   * other that there is none. A miss carries no revision to be ordered by, so the value one read
   * found is not taken away by the other's miss, whichever answers last.
   */
  it('keeps what one concurrent read found when another answers that there is none', async () => {
    const h = harness();
    const found = Promise.withResolvers<undefined>();
    const none = Promise.withResolvers<undefined>();
    let asked = 0;
    h.onRead(async () => {
      asked += 1;
      if (asked === 1) {
        await found.promise;
        return h.reply('found', 1);
      }
      await none.promise;
      return new Response(null, { status: 404 });
    });
    const first = h.get();
    const second = h.get();
    await vi.waitFor(() => {
      expect(h.reads()).toBe(2);
    });
    // The value is found first, and the miss answers after it.
    found.resolve(undefined);
    const firstAnswer = await first;
    none.resolve(undefined);
    const secondAnswer = await second;

    expect([firstAnswer, secondAnswer]).toStrictEqual(['found', 'found']);
    await expect(h.get()).resolves.toBe('found');
    expect(h.reads()).toBe(2);
  });

  /**
   * The value one read found can be too large for the memo to keep. The miss another read answers
   * after it is not remembered in its place either: the next request reads the key again, rather
   * than be told for a hold that there is nothing.
   */
  it('remembers no late miss after another read found a value too large to keep', async () => {
    const h = harness();
    // A referenced body must itself exceed the 8 MiB memo; its response has no base64 copy.
    const oversized = 'o'.repeat(9 * MIB);
    const found = Promise.withResolvers<undefined>();
    const none = Promise.withResolvers<undefined>();
    let asked = 0;
    h.onRead(async () => {
      asked += 1;
      if (asked === 1) {
        await found.promise;
      } else if (asked === 2) {
        await none.promise;
        return new Response(null, { status: 404 });
      }
      return h.reply(oversized, 1);
    });
    const first = h.get();
    const second = h.get();
    await vi.waitFor(() => {
      expect(h.reads()).toBe(2);
    });
    found.resolve(undefined);
    const firstAnswer = await first;
    none.resolve(undefined);
    const secondAnswer = await second;
    const thirdAnswer = await h.get();

    expect([firstAnswer?.length, secondAnswer, thirdAnswer?.length]).toStrictEqual([
      oversized.length,
      undefined,
      oversized.length,
    ]);
    expect(h.reads()).toBe(3);
  });

  /**
   * A write held up on its way arrived after the write of a value made later, and the host kept
   * that one: what a read of the key finds is the newer value, from the host, not the value written.
   */
  it.each(['fetch', 'use-cache'] as const)(
    'does not remember a %s write the host kept a newer value over',
    async (kind) => {
      const h = harness(kind);
      const write = h.put('older');
      await writesStarted(h, 1);
      h.writes[0]!.resolve(result({ generationId: 'generation-2', revision: 2, superseded: true }));
      await write;
      h.onRead(() => Promise.resolve(h.reply('newer', 2)));

      expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();
      await expect(h.get()).resolves.toBe('newer');
      expect(h.reads()).toBe(1);
    },
  );

  /**
   * Writes of a key can cross on their way to the host, and the host keeps a writer's later write
   * over its earlier one, whichever lands last: each is sent with where it stands among this
   * isolate's, an id the isolate drew and a count it raises with every write.
   */
  it('sends each write with where it stands among this isolate’s', async () => {
    const h = harness();
    const setData = vi.spyOn(h.runtime.host, 'setData');
    const first = h.put('first');
    await writesStarted(h, 1);
    const second = h.put('second', 'other');
    await writesStarted(h, 2);
    h.writes[0]!.resolve(committed(1));
    h.writes[1]!.resolve(committed(1));
    await Promise.all([first, second]);

    const [one, two] = setData.mock.calls.map(([request]) => request.order);

    expect(one?.writer).toMatch(/^[\da-f-]{36}$/u);
    expect(two?.writer).toBe(one?.writer);
    expect((two?.seq ?? 0) - (one?.seq ?? 0)).toBe(1);
  });

  /**
   * A write whose request ended under it never answers. Its key's state is held for it no longer
   * than a write can be in flight, nor past a budget of held states: keys each written once, under
   * a host that answers none of them, would otherwise each hold one for as long as the isolate lives.
   */
  describe('when a write never answers', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('lets its state go once it has been in flight as long as a write can be', async () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const h = harness();
      const puts = [h.put('lost', 'lost')];
      await writesStarted(h, 1);

      expect([...h.runtime.dataWrites.keys()]).toStrictEqual(['data:use-cache|default|lost']);

      // Short of the lifetime by more than `vi.waitFor` moves the clock on while it polls.
      vi.advanceTimersByTime(25_000);
      puts.push(h.put('next', 'next'));
      await writesStarted(h, 2);

      expect(h.runtime.dataWrites.size).toBe(2);

      vi.advanceTimersByTime(5000);
      puts.push(h.put('last', 'last'));
      await writesStarted(h, 3);

      expect([...h.runtime.dataWrites.keys()]).toStrictEqual([
        'data:use-cache|default|next',
        'data:use-cache|default|last',
      ]);
      expect(h.runtime.dataStates.get('data:use-cache|default|lost')).toBeDefined();

      for (const write of h.writes) {
        write.resolve(committed(1));
      }
      await Promise.all(puts);
    });

    it('holds the states of 512 keys at most, letting the oldest go', async () => {
      const h = harness();
      const puts: Promise<void>[] = [];
      for (let index = 0; index <= 512; index += 1) {
        puts.push(h.put('lost', `key-${String(index)}`));
      }
      await writesStarted(h, 513);

      expect(h.runtime.dataWrites.size).toBe(512);
      expect(h.runtime.dataWrites.has('data:use-cache|default|key-0')).toBe(false);
      expect(h.runtime.dataWrites.has('data:use-cache|default|key-512')).toBe(true);

      for (const write of h.writes) {
        write.resolve(committed(1));
      }
      await Promise.all(puts);
    });

    /**
     * Its state let go of, the key's state may leave the LRU, and another take its place, before the
     * lost write answers after all: what it committed is the floor of the state the key has then,
     * or a read through that one takes an answer older than the write for current.
     */
    it('raises the floor of the key’s state as it is now when the lost one answers', async () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      const h = harness();
      const lost = h.put('lost');
      await writesStarted(h, 1);
      vi.advanceTimersByTime(30_000);
      const other = h.put('other', 'other');
      await writesStarted(h, 2);
      await otherKeys(h);
      // Keep the regional value fresh past the delay; the lost write still has its shorter memo.
      h.onRead(() => Promise.resolve(h.reply('stale', 1, 60)));

      await expect(h.get()).resolves.toBe('stale');

      h.writes[0]!.resolve(committed(5));
      await lost;
      h.advance(6000);

      await expect(h.get()).resolves.toBeUndefined();

      h.writes[1]!.resolve(committed(1));
      await other;
    });

    /** The one let go of answers after all: it raises the floor, and leaves the later hold alone. */
    it('leaves a later write of the key its own hold when the lost one answers after all', async () => {
      vi.useFakeTimers({ toFake: ['performance'] });
      // Keep values fresh beyond the 30-second lost-write delay to isolate the held write.
      const h = harness('use-cache', 60);
      const lost = h.put('lost');
      await writesStarted(h, 1);
      vi.advanceTimersByTime(30_000);
      const later = h.put('later');
      await writesStarted(h, 2);
      h.writes[0]!.resolve(committed(1));
      await lost;

      expect(h.runtime.dataWrites.size).toBe(1);

      h.writes[1]!.resolve(committed(2));
      await later;

      expect(h.runtime.dataWrites.size).toBe(0);
      await expect(h.get()).resolves.toBe('later');
      expect(h.reads()).toBe(0);
    });
  });

  it('keeps long argument-derived keys cacheable with the same revision fences', async () => {
    const h = harness();
    const key = 'x'.repeat(70 * KIB);
    h.onRead(() => Promise.resolve(h.reply('regional', 1)));

    await expect(h.get(key)).resolves.toBe('regional');
    await expect(h.get(key)).resolves.toBe('regional');
    expect(h.reads()).toBe(1);

    const older = h.put('old', key);
    await writesStarted(h, 1);
    const newer = h.put('new', key);
    await writesStarted(h, 2);
    h.writes[1]!.resolve(committed(3));
    await newer;
    h.writes[0]!.resolve(committed(2));
    await older;

    await expect(h.get(key)).resolves.toBe('new');
    expect(h.reads()).toBe(1);
    expect(h.runtime.dataStates.usedBytes).toBeLessThan(KIB);
  });
});

/** What Next.js hands the fetch cache for a `fetch` it answered. */
function fetched(body: string) {
  return { kind: 'FETCH' as const, data: { body }, revalidate: 60 };
}

const FEED = 'https://origin.test/feed';
const PRERENDER_MANIFEST = {
  version: 4 as const,
  routes: {},
  dynamicRoutes: {},
  notFoundRoutes: [],
  preview: {
    previewModeId: 'preview',
    previewModeSigningKey: 'signing',
    previewModeEncryptionKey: 'encryption',
  },
};

/**
 * Next.js's own `fetch` inside a prerender of a Cache Components page — the render every
 * regeneration of one is — with the fetch cache the Function installs behind its incremental
 * cache, and `origin` standing for the network.
 */
function prerender(origin: typeof fetch): (url: string) => Promise<Response> {
  // From 16.4 the preview props come from a manifest of their own, and are handed over beside the
  // prerender manifest rather than read off it.
  const incrementalCache = new IncrementalCache({
    dev: false,
    minimalMode: true,
    requestHeaders: {},
    previewProps: PRERENDER_MANIFEST.preview,
    prerenderManifest: PRERENDER_MANIFEST,
    CurCacheHandler: PlatformFetchCache as unknown as typeof CacheHandler,
  });
  const work = {
    route: '/feed',
    incrementalCache,
    isStaticGeneration: true,
  } as unknown as WorkStore;
  const unit = {
    type: 'prerender',
    revalidate: INFINITE_CACHE,
    tags: [],
    resumeDataCache: createPrerenderResumeDataCache(),
    renderSignal: new AbortController().signal,
  } as unknown as WorkUnitStore;
  const nextFetch = createPatchedFetcher(origin, { workAsyncStorage, workUnitAsyncStorage });
  return (url) => {
    return workAsyncStorage.run(work, () =>
      workUnitAsyncStorage.run(unit, () => nextFetch(url, { next: { revalidate: 60 } })),
    );
  };
}

/** Long enough for a write the test has answered to settle; a bound only, never reached. */
const WRITES_LANDED_WITHIN_MS = 1000;

/**
 * A cached `fetch`'s write, started as Next.js hands it over and finished behind the render, in the
 * request's `waitUntil`. Where Next.js prerenders it gives the render the response a `fetch` got
 * only once the handler has answered for the write, so the handler answers at once.
 */
describe('a fetch cache write, behind the render that fetched it', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    vi.restoreAllMocks();
    // Next.js marks the global `fetch` as patched when it makes one, though nothing here was.
    Reflect.deleteProperty(globalThis, NEXT_PATCH_SYMBOL);
  });

  it('hands a prerender what its fetch got while the authority has yet to answer the write', async () => {
    const h = harness('fetch');
    const kept: Promise<unknown>[] = [];
    const origin = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ hits: 1 })));
    const nextFetch = prerender(origin);
    const answers: unknown[] = [];
    const rendered = withRequestContext(requestKeeping(h.runtime, kept), async () => {
      const first: unknown = await (await nextFetch(FEED)).json();
      // Again in the same render: answered from its resume data cache, which Next.js filled
      // before it handed over the write, so neither the host nor the origin is asked again.
      const again: unknown = await (await nextFetch(FEED)).json();
      answers.push(first, again);
    });
    await writesStarted(h, 1);

    await vi.waitFor(() => {
      expect(answers).toStrictEqual([{ hits: 1 }, { hits: 1 }]);
    });

    expect(origin).toHaveBeenCalledExactlyOnceWith(FEED, expect.anything());
    expect(h.reads()).toBe(1);
    expect(kept).toHaveLength(1);

    h.writes[0]!.resolve(committed(1));
    await Promise.all(kept);
    await rendered;
  });

  /**
   * And the end of the request's response waits for the write (`RequestWrites`): a request made
   * once the response was read whole finds the entry at the host, in whatever isolate it lands.
   */
  it("holds the end of the request's response for the write, the answer not", async () => {
    const h = harness('fetch');
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(h.runtime, kept);
    await withRequestContext(context, () =>
      new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT),
    );
    await writesStarted(h, 1);

    expect(context.writes.pending).toBe(true);

    h.writes[0]!.resolve(committed(1));
    await context.writes.landed(WRITES_LANDED_WITHIN_MS);

    expect(context.writes.pending).toBe(false);
  });

  /** Not a regeneration's: it runs behind a response that served what was there before. */
  it("leaves the end of the request's response to a regeneration's write", async () => {
    const h = harness('fetch');
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(h.runtime, kept);
    await withRequestContext(context, () =>
      asRegeneration(() => new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT)),
    );
    await writesStarted(h, 1);

    expect(kept).toHaveLength(1);
    expect(context.writes.pending).toBe(false);

    h.writes[0]!.resolve(committed(1));
    await Promise.all(kept);
  });

  it("answers before the authority does, and hands the write to the request's waitUntil", async () => {
    const h = harness('fetch');
    const kept: Promise<unknown>[] = [];
    let answered = false;
    const rendered = withRequestContext(requestKeeping(h.runtime, kept), async () => {
      await new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT);
      answered = true;
    });
    await writesStarted(h, 1);

    await vi.waitFor(() => {
      expect(answered).toBe(true);
    });

    expect(kept).toHaveLength(1);

    h.writes[0]!.resolve(committed(1));
    await Promise.all(kept);
    await rendered;

    // What the isolate remembers, once the authority has answered, is what it committed.
    await expect(h.get()).resolves.toBe('new');
    expect(h.reads()).toBe(0);
  });

  /**
   * A request's writes go out four at a time (`WRITES_AT_ONCE`), so that two of the six calls a
   * Function may have out are left to the reads a render waits on and the heartbeat; its `fetch`
   * writes, behind the render, three of the four (`CALLS_BEHIND_AT_ONCE`). A `use cache` value's
   * write goes ahead of them, though nothing in the request waits for it: no other isolate has the
   * value until it has landed.
   */
  it('writes a `use cache` value ahead of the fetch writes behind the render, within four writes', async () => {
    const h = harness();
    const kept: Promise<unknown>[] = [];
    const request = requestKeeping(h.runtime, kept);
    const fetches = new PlatformFetchCache();
    await withRequestContext(request, async () => {
      for (const key of ['a', 'b', 'c', 'd']) {
        await fetches.set(key, fetched(key), FETCH_CONTEXT);
      }
    });
    await writesStarted(h, 3);

    // Answered as soon as the values are held here, before either write has gone out.
    await withRequestContext(request, async () => {
      await Promise.all(['one', 'two'].map((key) => h.put('value', key)));
    });
    await writesStarted(h, 4);
    // A moment more, in which neither the second `use cache` write nor the fourth `fetch` goes.
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(h.writes).toHaveLength(4);

    // A `fetch` write answered: the turn it gives back goes to the `use cache` write waiting.
    h.writes[0]!.resolve(committed(1));
    await writesStarted(h, 5);

    await expect(h.writtenKeys()).resolves.toStrictEqual(['a', 'b', 'c', 'one', 'two']);

    for (const write of h.writes) {
      write.resolve(committed(1));
    }
    await writesStarted(h, 6);
    h.writes[5]!.resolve(committed(1));

    await Promise.all(kept);
  });

  /**
   * The render goes on while the write is out, and Next.js lets the next read of the key past its
   * lock as the handler answers: that read finds what the write carries, as it did when it waited
   * for the write to land, and neither the host nor the origin is asked for it.
   */
  it('answers a read of the key while its write is out with what the write carries', async () => {
    const h = harness('fetch');
    h.onRead(() => Promise.resolve(h.reply('old', 1)));

    await expect(h.get()).resolves.toBe('old');

    const kept: Promise<unknown>[] = [];
    await withRequestContext(requestKeeping(h.runtime, kept), () =>
      new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT),
    );
    await writesStarted(h, 1);

    await expect(h.get()).resolves.toBe('new');
    expect(h.reads()).toBe(1);

    h.writes[0]!.resolve(committed(2));
    await Promise.all(kept);

    await expect(h.get()).resolves.toBe('new');
    expect(h.reads()).toBe(1);
  });

  /**
   * A regeneration renders what the host will keep, and what the host says of the entry — an
   * invalidation fenced by the moment the fetch began — reaches the isolate only with the write's
   * answer. So a regeneration asks the host, as every read did before the write went behind.
   */
  it("asks the host for a regeneration, whatever another render's write of the key is out", async () => {
    const h = harness('fetch');
    h.onRead(() => Promise.resolve(h.reply('regional', 1)));
    const kept: Promise<unknown>[] = [];
    await withRequestContext(requestKeeping(h.runtime, kept), () =>
      new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT),
    );
    await writesStarted(h, 1);

    await expect(asRegeneration(() => h.get())).resolves.toBe('regional');
    expect(h.reads()).toBe(1);

    h.writes[0]!.resolve(committed(2));
    await Promise.all(kept);
  });

  /** Another regeneration's write is another render's as well. */
  it("asks the host for a regeneration, whatever another regeneration's write of the key is out", async () => {
    const h = harness('fetch');
    h.onRead(() => Promise.resolve(h.reply('regional', 1)));
    const kept: Promise<unknown>[] = [];
    await withRequestContext(requestKeeping(h.runtime, kept), () =>
      asRegeneration(() => new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT)),
    );
    await writesStarted(h, 1);

    await expect(asRegeneration(() => h.get())).resolves.toBe('regional');
    expect(h.reads()).toBe(1);

    h.writes[0]!.resolve(committed(2));
    await Promise.all(kept);
  });

  /**
   * But its own write it is answered with: what its render already served. Next.js computes a value
   * past its `revalidate` again in front of a regeneration and writes it, and the render's next read
   * of the key, answered with what the host kept instead, was past its `revalidate` still, so
   * Next.js computed it a second time — one page rendering two values of a key it fetched twice
   * (`app-static`, "should honor fetch cache correctly").
   */
  it('answers a regeneration with the write its own render handed over', async () => {
    const h = harness('fetch');
    h.onRead(() => Promise.resolve(h.reply('regional', 1)));
    const kept: Promise<unknown>[] = [];

    const read = withRequestContext(requestKeeping(h.runtime, kept), () => {
      return asRegeneration(async () => {
        await new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT);
        return h.get();
      });
    });
    await writesStarted(h, 1);

    await expect(read).resolves.toBe('new');
    expect(h.reads()).toBe(0);

    h.writes[0]!.resolve(committed(2));
    await Promise.all(kept);
  });

  it('judges what a write still out carries against the tags, as it would what the host kept', async () => {
    const h = harness('fetch');
    const kept: Promise<unknown>[] = [];
    await withRequestContext(requestKeeping(h.runtime, kept), () =>
      new PlatformFetchCache().set('key', fetched('new'), { ...FETCH_CONTEXT, tags: ['feed'] }),
    );
    await writesStarted(h, 1);
    // A tag the value carries, invalidated in this isolate once the fetch had begun.
    h.runtime.tags.applyLocal(['feed'], { staleAt: Date.now(), hardExpireAt: null });

    const read = await new PlatformFetchCache().get('key', { kind: 'FETCH' });

    // Served, and fetched again behind, as a stale value the host kept would be.
    expect(read?.lastModified).toBe(0);
    expect(h.reads()).toBe(0);

    h.writes[0]!.resolve(committed(1));
    await Promise.all(kept);
  });

  it('logs a write the authority failed, and fails nothing the request handed waitUntil', async () => {
    const h = harness('fetch');
    const kept: Promise<unknown>[] = [];
    const rendered = withRequestContext(requestKeeping(h.runtime, kept), () =>
      new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT),
    );
    await writesStarted(h, 1);
    h.writes[0]!.reject(new Error('the authority is out of reach'));
    await rendered;

    await expect(Promise.all(kept)).resolves.toBeDefined();
    expect(h.runtime.log).toHaveBeenCalledWith('fetch cache write failed', {
      detail: 'the authority is out of reach',
    });
    expect(h.runtime.dataMemo.get(h.memoKey)).toBeUndefined();
  });
});

/** A value of 3 MiB, told apart by `index`. */
function mebibytes(index: number): string {
  return `${String(index)}${'v'.repeat(3 * MIB)}`;
}

/** A `fetch`'s value handed to the fetch cache in a request of its own: its answer, and its write. */
function handOver(h: ReturnType<typeof harness>, body: string, key = 'key') {
  const kept: Promise<unknown>[] = [];
  const answered = withRequestContext(requestKeeping(h.runtime, kept), () =>
    new PlatformFetchCache().set(key, fetched(body), FETCH_CONTEXT),
  );
  const landed = async (): Promise<void> => {
    await answered;
    await Promise.all(kept);
  };
  return { answered, landed };
}

/**
 * Next.js ordered a key's writes while it waited on them — one after another within a render, and
 * behind its lock on the key across renders. It lets go as the handler answers, before the write
 * lands, so the handler keeps the order itself.
 */
/**
 * A `use cache` write, as a request that joined the function's invocation waits for it: Next.js
 * holds such a request until the handler's `set` answers, and reads the key again then. It answers
 * once the value is held in the isolate, and the write goes on behind the response.
 */
describe('a `use cache` write, behind the requests waiting for it', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  it("answers before the host has the value, and hands the write to the request's waitUntil", async () => {
    const h = harness();
    const kept: Promise<unknown>[] = [];

    await withRequestContext(requestKeeping(h.runtime, kept), () => h.put('value'));
    await writesStarted(h, 1);

    expect(kept).toHaveLength(1);

    h.writes[0]!.resolve(committed(1));
    await Promise.all(kept);
  });

  it("holds the end of the request's response for the write, the answer not", async () => {
    const h = harness();
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(h.runtime, kept);
    await withRequestContext(context, () => h.put('value'));
    await writesStarted(h, 1);

    expect(context.writes.pending).toBe(true);

    h.writes[0]!.resolve(committed(1));
    await context.writes.landed(WRITES_LANDED_WITHIN_MS);

    expect(context.writes.pending).toBe(false);
  });

  /**
   * From the moment Next.js hands the entry over, not once its value has been read whole: a
   * response that ended in between would end before the write it made.
   */
  it("holds the end of the request's response from the hand-over of the entry", async () => {
    const h = harness();
    const kept: Promise<unknown>[] = [];
    const context = requestKeeping(h.runtime, kept);
    const later = h.putLater();

    const set = withRequestContext(context, later.set);
    await vi.waitFor(() => {
      expect(context.writes.pending).toBe(true);
    });

    later.give('value');
    await set;
    await writesStarted(h, 1);
    h.writes[0]!.resolve(committed(1));
    await context.writes.landed(WRITES_LANDED_WITHIN_MS);

    expect(context.writes.pending).toBe(false);
  });

  it('lets the end of the response go when the entry is nothing to write', async () => {
    const h = harness();
    const context = requestKeeping(h.runtime, []);
    const encoder = new TextEncoder();
    const chunks = ['dy', 'nam', 'ic'][Symbol.iterator]();
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.next();
        if (chunk.done === true) controller.close();
        else controller.enqueue(encoder.encode(chunk.value));
      },
    });
    // Next.js keeps the render copy; this handler owns only the other branch.
    const [render, value] = source.tee();
    const entry = Promise.resolve({
      value,
      tags: [],
      timestamp: h.clock(),
      stale: 0,
      expire: 0,
      revalidate: 0,
    });
    const set = withRequestContext(context, () => useCacheHandler('default').set('key', entry));

    await set;

    expect(context.writes.pending).toBe(false);
    expect(h.writes).toHaveLength(0);
    await expect(new Response(render).text()).resolves.toBe('dynamic');
  });

  /** What a request that joined reads once `set` has answered: the value, without the host. */
  it('answers a read of the key while its write is out with what the write carries', async () => {
    const h = harness();
    h.onRead(() => Promise.resolve(h.reply('old', 1)));
    const kept: Promise<unknown>[] = [];
    await withRequestContext(requestKeeping(h.runtime, kept), () => h.put('new'));
    await writesStarted(h, 1);

    await expect(h.get()).resolves.toBe('new');
    expect(h.reads()).toBe(0);

    h.writes[0]!.resolve(committed(2));
    await Promise.all(kept);
  });

  it('asks the host for a regeneration, whatever write of the key is out', async () => {
    const h = harness();
    h.onRead(() => Promise.resolve(h.reply('regional', 1)));
    const kept: Promise<unknown>[] = [];
    await withRequestContext(requestKeeping(h.runtime, kept), () => h.put('new'));
    await writesStarted(h, 1);

    await expect(asRegeneration(() => h.get())).resolves.toBe('regional');
    expect(h.reads()).toBe(1);

    h.writes[0]!.resolve(committed(2));
    await Promise.all(kept);
  });

  /** A regeneration commits what it made, and nobody waits on the request it runs in. */
  it('still waits for the write of a regeneration', async () => {
    const h = harness();
    const kept: Promise<unknown>[] = [];
    let stored = false;

    const storing = withRequestContext(requestKeeping(h.runtime, kept), async () => {
      await asRegeneration(() => h.put('value'));
      stored = true;
    });
    await writesStarted(h, 1);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(stored).toBe(false);
    expect(kept).toHaveLength(0);

    h.writes[0]!.resolve(committed(1));
    await storing;

    expect(stored).toBe(true);
  });

  it('logs a write the host failed, and fails nothing the request handed waitUntil', async () => {
    const h = harness();
    const kept: Promise<unknown>[] = [];
    await withRequestContext(requestKeeping(h.runtime, kept), () => h.put('value'));
    await writesStarted(h, 1);

    h.writes[0]!.reject(new Error('host down'));

    await expect(Promise.all(kept)).resolves.toBeDefined();
    expect(h.runtime.log).toHaveBeenCalledWith('use cache write failed', { detail: 'host down' });
  });
});

describe("the fetch cache's writes of one key", () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
    vi.restoreAllMocks();
  });

  it('land in the order they were handed over, the later one waiting on the earlier', async () => {
    const h = harness('fetch');
    const older = handOver(h, 'old');
    const newer = handOver(h, 'new');
    await older.answered;
    await newer.answered;
    await writesStarted(h, 1);

    // The later write is not sent while the earlier one is out, however long it takes.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(h.writes).toHaveLength(1);

    h.writes[0]!.resolve(committed(1));
    await older.landed();
    await writesStarted(h, 2);
    h.writes[1]!.resolve(committed(2));
    await newer.landed();

    await expect(h.get()).resolves.toBe('new');
    expect(h.reads()).toBe(0);
  });

  it('send the later one when the earlier failed', async () => {
    const h = harness('fetch');
    const older = handOver(h, 'old');
    const newer = handOver(h, 'new');
    await writesStarted(h, 1);

    h.writes[0]!.reject(new Error('the authority is out of reach'));
    await older.landed();
    await writesStarted(h, 2);
    h.writes[1]!.resolve(committed(2));
    await newer.landed();

    await expect(h.get()).resolves.toBe('new');
  });

  it("leave another key's write to go at once", async () => {
    const h = harness('fetch');
    const one = handOver(h, 'one', 'one');
    const other = handOver(h, 'other', 'other');
    await writesStarted(h, 2);

    h.writes[0]!.resolve(committed(1));
    h.writes[1]!.resolve(committed(1));
    await one.landed();
    await other.landed();

    await expect(h.get('one')).resolves.toBe('one');
    await expect(h.get('other')).resolves.toBe('other');
  });

  /**
   * A key the host is slow to answer for is fetched again by every render that misses it meanwhile.
   * Only the newest of what those renders hand over waits for the write that is out; the ones it
   * replaces never go out, and hold nothing while they wait.
   */
  it('send only the newest of the writes handed over while one is out', async () => {
    const h = harness('fetch');
    const first = handOver(h, 'first');
    await writesStarted(h, 1);
    const middle = handOver(h, 'middle');
    const newest = handOver(h, 'newest');
    await middle.answered;
    await newest.answered;

    h.writes[0]!.resolve(committed(1));
    await first.landed();
    await middle.landed();
    await writesStarted(h, 2);
    h.writes[1]!.resolve(committed(2));
    await newest.landed();

    expect(h.writes).toHaveLength(2);
    await expect(h.get()).resolves.toBe('newest');
    expect(h.reads()).toBe(0);
  });

  /**
   * A host that answers no write, under keys each fetched once, would have the isolate keep a value
   * for every one of them: the table keeps the writes of 512 keys, and lets the oldest go.
   */
  it('keep track of 512 keys’ writes at most, letting the oldest go', async () => {
    const h = harness('fetch');
    h.onRead(() => Promise.resolve(h.reply('regional', 1)));
    handOver(h, 'first', 'key-0');
    for (let index = 1; index <= 512; index += 1) {
      handOver(h, `value-${String(index)}`, `key-${String(index)}`);
    }
    await writesStarted(h, 513);

    // The newest is still answered from its write; the oldest has been let go, and asks the host.
    await expect(h.get('key-512')).resolves.toBe('value-512');
    expect(h.reads()).toBe(0);
    await expect(h.get('key-0')).resolves.toBe('regional');
    expect(h.reads()).toBe(1);
  });

  /**
   * Values of a few MiB each, under a host that answers none of their writes, would have the table
   * keep every one of them for reads of their keys: it keeps 8 MiB of them, letting go first of the
   * oldest that have gone out, whose keys then ask the host.
   */
  it('keep 8 MiB of the values they carry for reads, letting the oldest sent go first', async () => {
    const h = harness('fetch');
    h.onRead(() => Promise.resolve(h.reply('regional', 1)));
    for (let index = 0; index < 3; index += 1) {
      handOver(h, mebibytes(index), `key-${String(index)}`);
    }
    await writesStarted(h, 3);

    await expect(h.get('key-2')).resolves.toBe(mebibytes(2));
    await expect(h.get('key-1')).resolves.toBe(mebibytes(1));
    expect(h.reads()).toBe(0);
    await expect(h.get('key-0')).resolves.toBe('regional');
    expect(h.reads()).toBe(1);
  });

  /**
   * A write that waits to go takes its place in this isolate's order as it is handed over: sent once
   * the one before it is answered, after a write handed over later, it is still the earlier, and the
   * host keeps the later where the two cross.
   */
  it('take their place in the order as they are handed over, not as they go', async () => {
    const h = harness('fetch');
    const setData = vi.spyOn(h.runtime.host, 'setData');
    const first = handOver(h, 'first');
    await writesStarted(h, 1);
    const waiting = handOver(h, 'waiting');
    const other = handOver(h, 'other', 'other');
    await writesStarted(h, 2);
    h.writes[0]!.resolve(committed(1));
    h.writes[1]!.resolve(committed(1));
    await first.landed();
    await other.landed();
    await writesStarted(h, 3);
    h.writes[2]!.resolve(committed(2));
    await waiting.landed();

    const [, handedLater = 0, sentLater] = setData.mock.calls.map(
      ([request]) => request.order?.seq ?? 0,
    );

    expect(sentLater).toBeLessThan(handedLater);
  });

  /**
   * The table lets go of the oldest of its keys, a write still waiting to go among them. It never
   * goes: a later write of its key, with nothing before it, goes at once, and this one would land
   * after it.
   */
  it('drop a waiting write the table lets go of, rather than send it after a later one', async () => {
    const h = harness('fetch');
    const first = handOver(h, 'first');
    await writesStarted(h, 1);
    const waiting = handOver(h, 'waiting');
    await waiting.answered;
    for (let index = 0; index < 512; index += 1) {
      handOver(h, `value-${String(index)}`, `key-${String(index)}`);
    }
    await writesStarted(h, 513);

    expect(h.runtime.log).toHaveBeenCalledWith('fetch cache write dropped', {
      detail: 'waiting past the keys kept',
    });

    h.writes[0]!.resolve(committed(1));
    await first.landed();
    await waiting.landed();

    expect(h.writes).toHaveLength(513);
  });

  /**
   * A host that stalls the writes of several keys, each fetched again meanwhile, would have every
   * value waiting behind them kept until the patience ran out: a write waiting past the budget is
   * dropped, and says so, rather than kept.
   */
  it('drop a write waiting to go past the budget, rather than keep it', async () => {
    const h = harness('fetch');
    const first = handOver(h, 'first');
    await writesStarted(h, 1);
    const waiting = handOver(h, mebibytes(0).repeat(3));
    await waiting.answered;

    expect(h.runtime.log).toHaveBeenCalledWith('fetch cache write dropped', {
      detail: 'waiting past the byte budget',
    });

    h.writes[0]!.resolve(committed(1));
    await first.landed();
    await waiting.landed();

    expect(h.writes).toHaveLength(1);
    await expect(h.get()).resolves.toBe('first');
  });

  /**
   * The request that keeps a write alive may end under it, and what it left out then never settles
   * in another request. A write waits for the one before it only so long, and a write handed over
   * longer ago than a write can be out answers no read and holds no write back.
   */
  describe('when the write before has gone quiet', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('go once the one before them has been out for as long as a write waits', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const h = harness('fetch');
      handOver(h, 'lost');
      await writesStarted(h, 1);
      const after = handOver(h, 'after');
      await after.answered;
      await vi.advanceTimersByTimeAsync(4999);

      expect(h.writes).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      await writesStarted(h, 2);
      h.writes[1]!.resolve(committed(2));
      await after.landed();

      await expect(h.get()).resolves.toBe('after');
    });

    it('are not answered from, nor waited for, once handed over longer ago than a write lasts', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const h = harness('fetch');
      h.onRead(() => Promise.resolve(h.reply('regional', 1)));
      handOver(h, 'lost');
      await writesStarted(h, 1);

      await expect(h.get()).resolves.toBe('lost');
      expect(h.reads()).toBe(0);

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(h.get()).resolves.toBe('regional');
      expect(h.reads()).toBe(1);

      const later = handOver(h, 'later');
      await writesStarted(h, 2);
      h.writes[1]!.resolve(committed(2));
      await later.landed();
    });
  });

  it('are refused as a rejection, not a throw, by a host whose waitUntil has closed', async () => {
    const h = harness('fetch');
    const closed = new Error('waitUntil after the invocation ended');
    const context = {
      ...requestKeeping(h.runtime, []),
      waitUntil: () => {
        throw closed;
      },
    };
    let answer: Promise<void> | undefined;
    // What the handler returns, without awaiting it: a throw, before, fails the caller's frame.
    await withRequestContext(context, () => {
      answer = new PlatformFetchCache().set('key', fetched('new'), FETCH_CONTEXT);
      return Promise.resolve();
    });

    await expect(answer).rejects.toBe(closed);

    await writesStarted(h, 1);
    h.writes[0]!.resolve(committed(1));
  });
});
