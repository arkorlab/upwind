import { encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readCopy } from '../src/cache/generation-copy.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const BYTES = encodeUtf8('the complete delivery record');
const NOW = 100;
const MAX_AGE_MS = 1000;

async function fixture() {
  const edge: EdgeContext = {
    env,
    ctx: createExecutionContext(),
    runtime: standaloneRuntime(env, { memory: createEdgeMemory(() => NOW), now: () => NOW }),
    host: standaloneHost(env),
    forwarding: {
      previewDomain: 'example.test',
      previewHost: 'customer.example.test',
      clientIp: undefined,
    },
    app: undefined,
    originalUrl: undefined,
    policy: DEFAULT_DELIVERY_POLICY,
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: true,
    assetMaxBytes: 1024,
    projectId: 'site',
    manifestId: 'a'.repeat(64),
    colo: undefined,
    validated: false,
    demotedRoutes: undefined,
    privateDelivery: false,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: 0 },
  };
  const cache = await caches.open(edge.host.names.recordCache);
  const open = vi.spyOn(caches, 'open').mockResolvedValue(cache);
  const match = vi.spyOn(cache, 'match');
  return { edge, cache, open, match };
}

function copy(body: ReadableStream<Uint8Array> | null, keptAt = NOW): Response {
  return new Response(body, {
    headers: { 'x-arkor-kept-at': String(keptAt), 'x-arkor-revision': '3' },
  });
}

function holdLookup(
  test: Awaited<ReturnType<typeof fixture>>,
  late: 'lookup' | 'open',
  hit: Response,
) {
  const pending = Promise.withResolvers<Response | undefined>();
  const pendingCache = Promise.withResolvers<Cache>();
  if (late === 'lookup') test.match.mockImplementation(() => pending.promise);
  else {
    test.open.mockImplementation(() => pendingCache.promise);

    test.match.mockResolvedValue(hit);
  }
  return () => {
    pending.resolve(hit);
    pendingCache.resolve(test.cache);
  };
}

describe('giving up a record copy after its existing read deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['resolved', 'pending', 'rejected'] as const)(
    'cancels an active body without waiting for %s cancellation',
    async (acknowledgment) => {
      const { edge, match } = await fixture();
      vi.useFakeTimers();
      const ack = Promise.withResolvers<undefined>();
      const latePull = Promise.withResolvers<undefined>();
      const cancelled = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(BYTES.subarray(0, 1));
        },
        pull: () => latePull.promise,
        cancel() {
          cancelled();
          if (acknowledgment === 'pending') return ack.promise;
          if (acknowledgment === 'rejected') return Promise.reject(new Error('cancel failed'));
          return Promise.resolve();
        },
      });
      match.mockResolvedValue(copy(body));
      const reading = readCopy(edge, 'record', MAX_AGE_MS);
      try {
        await vi.advanceTimersByTimeAsync(101);

        await expect(reading).resolves.toBeUndefined();
        expect(cancelled).toHaveBeenCalledTimes(1);

        latePull.reject(new Error('pull failed after cancellation'));
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        latePull.resolve(undefined);
        ack.resolve(undefined);
        await reading;
      }
    },
  );

  it.each(['lookup', 'open'] as const)(
    'releases a response after a late cache %s before reading it',
    async (late) => {
      const test = await fixture();
      vi.useFakeTimers();
      const cancelled = vi.fn();
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        { pull, cancel: cancelled },
        { highWaterMark: 0 },
      );
      const hit = copy(body);
      const release = holdLookup(test, late, hit);
      const reading = readCopy(test.edge, 'record', MAX_AGE_MS);
      try {
        await vi.advanceTimersByTimeAsync(101);

        await expect(reading).resolves.toBeUndefined();

        release();
        await vi.advanceTimersByTimeAsync(0);

        expect(cancelled).toHaveBeenCalledTimes(1);
        expect(pull).not.toHaveBeenCalled();
      } finally {
        release();
        await reading;
      }
    },
  );

  it('keeps the fast copy bytes and stamps on one native arrayBuffer read', async () => {
    const { edge, match } = await fixture();
    const arrayBuffer = vi.spyOn(Response.prototype, 'arrayBuffer');
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.subarray(0, 3));
        controller.enqueue(BYTES.subarray(3));
        controller.close();
      },
      cancel: cancelled,
    });
    match.mockResolvedValue(copy(body));
    const found = await readCopy(edge, 'record', MAX_AGE_MS);

    expect(found).toStrictEqual({ keptAt: NOW, revision: 3, bytes: BYTES.buffer });
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it.each(['x-arkor-kept-at', 'x-arkor-revision'] as const)(
    'releases a copy without %s without buffering',
    async (missing) => {
      const { edge, match } = await fixture();
      const cancelled = vi.fn();
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        { pull, cancel: cancelled },
        { highWaterMark: 0 },
      );
      const hit = copy(body);
      hit.headers.delete(missing);
      match.mockResolvedValue(hit);
      const found = await readCopy(edge, 'record', MAX_AGE_MS);

      expect(found).toBeUndefined();
      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(pull).not.toHaveBeenCalled();
    },
  );

  it('keeps an expired copy absent', async () => {
    const { edge, match } = await fixture();
    match.mockResolvedValue(copy(new Response(BYTES).body, 0));

    await expect(readCopy(edge, 'record', 1)).resolves.toBeUndefined();
  });

  it('keeps a cache miss absent without a body read', async () => {
    const { edge, match } = await fixture();
    const arrayBuffer = vi.spyOn(Response.prototype, 'arrayBuffer');
    match.mockResolvedValue(undefined);

    await expect(readCopy(edge, 'record', MAX_AGE_MS)).resolves.toBeUndefined();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('preserves a null body as an empty native buffer', async () => {
    const { edge, match } = await fixture();
    match.mockResolvedValue(copy(null));

    await expect(readCopy(edge, 'record', MAX_AGE_MS)).resolves.toStrictEqual({
      keptAt: NOW,
      revision: 3,
      bytes: new ArrayBuffer(0),
    });
  });

  it('keeps a failed body absent and consumes its rejection', async () => {
    const { edge, match } = await fixture();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('read failed'));
      },
    });
    match.mockResolvedValue(copy(body));

    await expect(readCopy(edge, 'record', MAX_AGE_MS)).resolves.toBeUndefined();
  });
});
