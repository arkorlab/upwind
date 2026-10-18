import { sha256Hex, staticAssetShellPath } from '@stayingupwind/core/artifact';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY, type ShellRead } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CacheBody } from '../src/cache/cache-body.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { loadShell } from '../src/strategies/shell-loader.ts';

const BYTES = encodeUtf8('the cached shell');

function context(): EdgeContext {
  vi.spyOn(caches.default, 'put').mockResolvedValue();
  return {
    env,
    ctx: createExecutionContext(),
    runtime: standaloneRuntime(env, { memory: createEdgeMemory(() => 100), now: () => 100 }),
    host: standaloneHost(env),
    forwarding: {
      previewDomain: 'example.test',
      previewHost: 'customer.example.test',
      clientIp: undefined,
    },
    app: undefined,
    originalUrl: undefined,
    policy: {
      ...DEFAULT_DELIVERY_POLICY,
      shell: { backend: 'kv', memoryLru: false, cacheApiLayer: true },
    },
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
}

async function reference() {
  return {
    sha256: await sha256Hex(BYTES),
    byteLength: BYTES.byteLength,
    contentType: 'text/html',
    encoding: 'identity' as const,
  };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const BACKEND: ShellRead = { bytes: BYTES, source: 'kv', latencyMs: 0 };

async function buffered(body: CacheBody, hit: Response, expected?: number) {
  const pending = body.open(hit, expected);
  if (pending === undefined) throw new Error('missing read');
  return body.finish(await pending);
}

function nativeBytes(bytes: Uint8Array) {
  const source: UnderlyingSource<Uint8Array> = {
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  };
  Reflect.set(source, 'type', 'bytes');
  return new ReadableStream<Uint8Array>(source);
}

describe('giving up a shell copy that lost its race', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('cuts the native buffer consumer while a stalled source never acknowledges cancellation', async () => {
    const started = Promise.withResolvers<undefined>();
    const acknowledgment = Promise.withResolvers<undefined>();
    const cancelled = vi.fn(() => acknowledgment.promise);
    const source = new ReadableStream<Uint8Array>({
      pull() {
        started.resolve(undefined);
      },
      cancel: cancelled,
    });
    const body = new CacheBody();
    const reading = buffered(body, new Response(source));
    try {
      await started.promise;
      body.stop();

      await expect(reading).rejects.toThrow('cache body no longer needed');
      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      body.stop();
      acknowledgment.resolve(undefined);
    }
  });

  it('preserves an empty response on its native body path', async () => {
    const original = new Response(null);
    const body = new CacheBody();

    await expect(buffered(body, original)).resolves.toStrictEqual(new ArrayBuffer(0));

    body.stop();
  });

  it.each(['resolved', 'pending', 'rejected'] as const)(
    'cuts a native byte reader without waiting for %s cancellation',
    async (acknowledgment) => {
      const ack = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      const cancel = vi.fn(() => {
        if (acknowledgment === 'pending') return ack.promise;
        if (acknowledgment === 'rejected') return Promise.reject(new Error('cancel failed'));
        return Promise.resolve();
      });
      const source: UnderlyingSource<Uint8Array> = {
        pull() {
          started.resolve(undefined);
        },
        cancel,
      };
      Reflect.set(source, 'type', 'bytes');
      const input = new ReadableStream<Uint8Array>(source);
      const body = new CacheBody();
      const reading = buffered(body, new Response(input), BYTES.byteLength);
      try {
        await started.promise;
        body.stop();

        await expect(reading).rejects.toThrow(/cache body no longer needed|reader|released/iu);
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        ack.resolve(undefined);
        body.stop();
      }
    },
  );

  it.each([-1, 1])('refuses a %i-byte length difference at EOF', async (difference) => {
    const input = nativeBytes(new Uint8Array(BYTES.byteLength + difference));

    await expect(buffered(new CacheBody(), new Response(input), BYTES.byteLength)).rejects.toThrow(
      'cache body length mismatch',
    );
  });

  it('returns exact native bytes without including the sentinel capacity', async () => {
    const input = nativeBytes(new Uint8Array(BYTES));
    const found = await buffered(new CacheBody(), new Response(input), BYTES.byteLength);

    expect(found).toStrictEqual(BYTES);
    expect(found.byteLength).toBe(BYTES.byteLength);
  });

  it('rejects a manifest length inconsistent with stored metadata before a body pull', () => {
    const cancel = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const hit = new Response(body, { headers: { 'content-length': String(BYTES.byteLength) } });

    expect(() => new CacheBody().open(hit, Number.MAX_SAFE_INTEGER)).toThrow(
      'cache body length mismatch',
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
  });

  it.each(['invalid', '-1', '1.5', '0x10'])(
    'keeps the cancellable fallback for an invalid %s length',
    async (length) => {
      const hit = new Response(BYTES, { headers: { 'content-length': length } });

      await expect(buffered(new CacheBody(), hit)).resolves.toStrictEqual(BYTES.buffer);
    },
  );

  it('reads a native Cache API shell saved without an explicit length', async () => {
    const base = context();
    const ctx = {
      ...base,
      policy: { ...base.policy, shell: { ...base.policy.shell, memoryLru: true } },
    };
    vi.restoreAllMocks();
    const ref = await reference();
    // The shell's public key is used by loadShell; the write has the normal unmodified headers.
    const actualKey = new Request(
      `https://${ctx.host.names.cacheKeyHost}${staticAssetShellPath(ref.sha256)}`,
    );
    await caches.default.put(
      actualKey,
      new Response(BYTES, {
        headers: { 'cache-control': 'public, max-age=3600' },
      }),
    );
    const hit = await caches.default.match(actualKey);

    expect(hit?.headers.get('content-length')).toBe(String(BYTES.byteLength));

    await hit?.body?.cancel();
    const backend = Promise.withResolvers<ShellRead | undefined>();
    try {
      const loaded = await loadShell(ref, { id: 'kv', getShell: () => backend.promise }, ctx);

      expect(ctx.runtime.memory.budget.usedBytes).toBe(BYTES.byteLength + 1);
      expect(loaded).toStrictEqual({
        kind: 'ok',
        read: { bytes: BYTES, source: 'cache-api', latencyMs: 0 },
      });
    } finally {
      backend.resolve(BACKEND);
      await waitOnExecutionContext(ctx.ctx);
      await caches.default.delete(actualKey);
    }
  });

  it.each(['resolved', 'pending', 'rejected'] as const)(
    'cancels its open reader when the backend wins with %s cancellation',
    async (acknowledgment) => {
      const ctx = context();
      const ref = await reference();
      const backend = Promise.withResolvers<ShellRead | undefined>();
      const started = Promise.withResolvers<undefined>();
      const cancelled = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        // A deliberate loss of the race is not a storage failure to log.
      });
      const acknowledgmentPending = Promise.withResolvers<undefined>();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(BYTES.subarray(0, 1));
        },
        pull() {
          started.resolve(undefined);
        },
        cancel() {
          cancelled();
          if (acknowledgment === 'pending') return acknowledgmentPending.promise;
          if (acknowledgment === 'rejected') return Promise.reject(new Error('cancel failed'));
          return Promise.resolve();
        },
      });
      vi.spyOn(caches.default, 'match').mockResolvedValue(new Response(body));
      const loading = loadShell(ref, { id: 'kv', getShell: () => backend.promise }, ctx);
      try {
        await started.promise;
        backend.resolve(BACKEND);
        const loaded = await loading;

        expect(loaded).toStrictEqual({ kind: 'ok', read: BACKEND });
        expect(cancelled).toHaveBeenCalledTimes(1);

        await nextTurn();

        expect(warn).not.toHaveBeenCalled();
      } finally {
        backend.resolve(BACKEND);
        acknowledgmentPending.resolve(undefined);
        await loading;
        await waitOnExecutionContext(ctx.ctx);
      }
    },
  );

  it('releases a late hit before reading it after the backend answered', async () => {
    const ctx = context();
    const ref = await reference();
    const pending = Promise.withResolvers<Response | undefined>();
    const cancelled = vi.fn();
    const pull = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel: cancelled }, { highWaterMark: 0 });
    vi.spyOn(caches.default, 'match').mockImplementation(() => pending.promise);
    const loaded = await loadShell(
      ref,
      { id: 'kv', getShell: () => Promise.resolve(BACKEND) },
      ctx,
    );
    pending.resolve(new Response(body));
    await nextTurn();

    expect(loaded).toStrictEqual({ kind: 'ok', read: BACKEND });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();

    await waitOnExecutionContext(ctx.ctx);
  });

  it('cancels a stalled body at the existing deadline before the backend answers', async () => {
    const ctx = context();
    const ref = await reference();
    vi.useFakeTimers();
    const pending = Promise.withResolvers<ShellRead | undefined>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    vi.spyOn(caches.default, 'match').mockResolvedValue(new Response(body));
    const loading = loadShell(ref, { id: 'kv', getShell: () => pending.promise }, ctx);
    try {
      await vi.advanceTimersByTimeAsync(101);

      expect(cancelled).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve(BACKEND);
      await loading;
      await waitOnExecutionContext(ctx.ctx);
    }
  });

  it('keeps fast cache bytes unchanged while starting the backend in parallel', async () => {
    const ctx = context();
    const ref = await reference();
    const pending = Promise.withResolvers<ShellRead | undefined>();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES.subarray(0, 3));
        controller.enqueue(BYTES.subarray(3));
        controller.close();
      },
      cancel: cancelled,
    });
    const getShell = vi.fn(() => pending.promise);
    const match = vi.spyOn(caches.default, 'match').mockResolvedValue(new Response(body));
    const loading = loadShell(ref, { id: 'kv', getShell }, ctx);
    try {
      expect(getShell).toHaveBeenCalledTimes(1);
      expect(match).toHaveBeenCalledTimes(1);

      const loaded = await loading;

      expect(loaded).toStrictEqual({
        kind: 'ok',
        read: { bytes: BYTES, source: 'cache-api', latencyMs: 0 },
      });
      expect(cancelled).not.toHaveBeenCalled();
    } finally {
      pending.resolve(BACKEND);
      await loading;
      await waitOnExecutionContext(ctx.ctx);
    }
  });

  it('keeps a missing cache and backend missing', async () => {
    const ctx = context();
    const ref = await reference();
    vi.spyOn(caches.default, 'match').mockResolvedValue(undefined);
    const loaded = await loadShell(
      ref,
      { id: 'kv', getShell: () => Promise.resolve(undefined) },
      ctx,
    );

    expect(loaded).toStrictEqual({ kind: 'missing' });

    await waitOnExecutionContext(ctx.ctx);
  });
});
