import { setImmediate } from 'node:timers/promises';

import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import { configureCacheHandlers, useCacheHandler } from '../src/cache/handlers.ts';
import type { CacheHost } from '../src/cache/host.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';

const NOW = 1_800_000_000_000;
const HOLD_MS = 5000;
const ENTRIES = 64;
const KEY = 'cached-function';
const CHUNKS = ['first ', 'second ', 'third'];
const VALUE = CHUNKS.join('');

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

/** A pull source with more chunks than an unread tee branch can prefetch before it stalls. */
function valueStream(cancel: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const chunk = CHUNKS[index];
      if (chunk === undefined) {
        controller.close();
      } else {
        index += 1;
        controller.enqueue(encoder.encode(chunk));
      }
    },
    cancel,
  });
}

function entryOf(value: ReadableStream<Uint8Array>, expire: number) {
  return { value, tags: [], stale: 0, timestamp: NOW, expire, revalidate: 60 };
}

/** A pending write must finish without another reader or a storage reply advancing it. */
function finishedBeforeNextTask(write: Promise<void>): Promise<boolean> {
  const finished = async (): Promise<boolean> => {
    await write;
    return true;
  };
  return Promise.race([finished(), setImmediate(false)]);
}

describe('use cache value stream ownership', () => {
  afterEach(() => {
    configureCacheHandlers(undefined);
  });

  it('releases a dynamic multi-chunk value without leaving a pending write', async () => {
    const setData = vi.fn(unasked);
    const runtime = runtimeOf(hostOf(setData));
    const behind: Promise<unknown>[] = [];
    const context = requestOf(runtime, behind);
    const cancelled = vi.fn();
    const handler = useCacheHandler('default');
    configureCacheHandlers(runtime);

    const entry = entryOf(valueStream(cancelled), 0);
    const write = context.run(() => handler.set(KEY, Promise.resolve(entry)));

    await expect(finishedBeforeNextTask(write)).resolves.toBe(true);
    expect(context.writes.pending).toBe(false);
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(setData).not.toHaveBeenCalled();
    expect(behind).toStrictEqual([]);
    await expect(handler.get(KEY, [])).resolves.toBeUndefined();
  });

  it('does not wait for the render copy to consume a dynamic value', async () => {
    const setData = vi.fn(unasked);
    const runtime = runtimeOf(hostOf(setData));
    const behind: Promise<unknown>[] = [];
    const context = requestOf(runtime, behind);
    const cancelled = vi.fn();
    // Next.js retains its own render copy before passing the other stream to the handler.
    const [render, stored] = valueStream(cancelled).tee();
    const handler = useCacheHandler('default');
    configureCacheHandlers(runtime);

    const write = context.run(() => handler.set(KEY, Promise.resolve(entryOf(stored, 0))));

    await expect(finishedBeforeNextTask(write)).resolves.toBe(true);
    expect(context.writes.pending).toBe(false);
    expect(setData).not.toHaveBeenCalled();
    expect(cancelled).not.toHaveBeenCalled();
    await expect(new Response(render).text()).resolves.toBe(VALUE);
  });

  it('holds detached bytes while storage is pending and preserves the render copy', async () => {
    const written = Promise.withResolvers<Awaited<ReturnType<CacheHost['setData']>>>();
    const setData = vi.fn(() => written.promise);
    const runtime = runtimeOf(hostOf(setData));
    const behind: Promise<unknown>[] = [];
    const context = requestOf(runtime, behind);
    const cancelled = vi.fn();
    const [render, stored] = valueStream(cancelled).tee();
    const handler = useCacheHandler('default');
    configureCacheHandlers(runtime);

    const write = context.run(() => handler.set(KEY, Promise.resolve(entryOf(stored, 3600))));

    await expect(finishedBeforeNextTask(write)).resolves.toBe(true);
    expect(context.writes.pending).toBe(true);
    expect(setData).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: KEY, valueBase64: btoa(VALUE) }),
    );

    const first = await handler.get(KEY, []);
    const second = await handler.get(KEY, []);

    await expect(new Response(first?.value).text()).resolves.toBe(VALUE);
    await expect(new Response(second?.value).text()).resolves.toBe(VALUE);
    await expect(new Response(render).text()).resolves.toBe(VALUE);

    written.resolve({ entryId: 'entry', generationId: 'generation', revision: 1 });
    await Promise.all(behind);

    expect(context.writes.pending).toBe(false);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
