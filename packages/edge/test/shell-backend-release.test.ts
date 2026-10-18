import { r2ArtifactKey, sha256Hex } from '@stayingupwind/core/artifact';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import { CacheBody } from '../src/cache/cache-body.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { kvShellStrategy } from '../src/strategies/shell-kv.ts';
import { loadShell } from '../src/strategies/shell-loader.ts';
import { r2ShellStrategy } from '../src/strategies/shell-r2.ts';
import { staticAssetsShellStrategy } from '../src/strategies/shell-static-assets.ts';

const BYTES = encodeUtf8('the native backend shell');
const READ_MS = 2000;
type ByteBackend = 'r2' | 'static-assets';

function context(backend: ByteBackend | 'kv', assets?: Fetcher): EdgeContext {
  const bindings: EdgeBindings = { ...env, ...(assets !== undefined && { ASSETS: assets }) };
  return {
    env: bindings,
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
      shell: { backend, memoryLru: true, cacheApiLayer: false },
    },
    cspNonce: false,
    cspNonceMode: 'enforce',
    cspStrictDynamic: false,
    cacheApi: false,
    assetMaxBytes: 1024,
    projectId: 'backend-release',
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

/** Only the native object fields this strategy consumes; its old reader delegates to the body. */
function objectWith(response: Response, size: number): R2ObjectBody {
  return {
    size,
    body: response.body,
    arrayBuffer: () => response.arrayBuffer(),
  } as unknown as R2ObjectBody;
}

async function fixture(backend: ByteBackend, size?: number) {
  const ref = await reference();
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn(() => pending.promise);
  // Only fetch is used by this explicit Static Assets binding fixture.
  const assets = { fetch } as unknown as Fetcher;
  const ctx = context(backend, assets);
  if (backend === 'r2') {
    vi.spyOn(env.ARTIFACTS, 'get').mockImplementation(async () => {
      const response = await pending.promise;
      return objectWith(response, size ?? ref.byteLength);
    });
  }
  return {
    ctx,
    ref,
    pending,
    strategy: backend === 'r2' ? r2ShellStrategy : staticAssetsShellStrategy,
  };
}

async function settled(pending: Promise<unknown>): Promise<'fulfilled' | 'rejected'> {
  try {
    await pending;
    return 'fulfilled';
  } catch {
    return 'rejected';
  }
}

describe('the backend shell body belongs to its existing two-second owner', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each<ByteBackend>(['r2', 'static-assets'])(
    'cancels a partial native %s body before returning the fallback result',
    async (backend) => {
      const subject = await fixture(backend);
      const source = new IdentityTransformStream();
      const writer = source.writable.getWriter();
      const writing = settled(writer.write(BYTES.subarray(0, 1)));
      const closed = settled(writer.closed);
      const response = new Response(source.readable);
      const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
      subject.pending.resolve(response);
      vi.spyOn(console, 'warn').mockReturnValue();
      vi.useFakeTimers();
      const loading = loadShell(subject.ref, subject.strategy, subject.ctx);
      try {
        // The native reader must consume its prefix before the owner clock advances.
        await expect(writing).resolves.toBe('fulfilled');

        await vi.advanceTimersByTimeAsync(READ_MS + 1);

        await expect(loading).resolves.toStrictEqual({
          kind: 'unavailable',
          detail: 'shell backend read timed out',
        });

        const nextWriting = settled(writer.write(BYTES.subarray(0, 1)));

        await expect(nextWriting).resolves.toBe('rejected');
        await expect(closed).resolves.toBe('rejected');
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(subject.ctx.runtime.memory.shells.get(subject.ref.sha256)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await settled(writer.abort());
        await writing;
        await closed;
        await loading;
        await waitOnExecutionContext(subject.ctx.ctx);
      }
    },
  );

  it.each<ByteBackend>(['r2', 'static-assets'])(
    'releases an unread native %s body whose headers arrive after the owner expired',
    async (backend) => {
      const subject = await fixture(backend);
      const source = new IdentityTransformStream();
      const writer = source.writable.getWriter();
      const closed = settled(writer.closed);
      const response = new Response(source.readable);
      const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
      vi.spyOn(console, 'warn').mockReturnValue();
      vi.useFakeTimers();
      const loading = loadShell(subject.ref, subject.strategy, subject.ctx);
      try {
        await vi.advanceTimersByTimeAsync(READ_MS + 1);

        await expect(loading).resolves.toStrictEqual({
          kind: 'unavailable',
          detail: 'shell backend read timed out',
        });

        subject.pending.resolve(response);
        await vi.advanceTimersByTimeAsync(0);
        const writing = settled(writer.write(BYTES.subarray(0, 1)));

        await expect(writing).resolves.toBe('rejected');
        await expect(closed).resolves.toBe('rejected');
        expect(arrayBuffer).not.toHaveBeenCalled();
        expect(response.body?.locked).toBe(false);
        expect(subject.ctx.runtime.memory.shells.get(subject.ref.sha256)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        subject.pending.resolve(response);
        await settled(writer.abort());
        await closed;
        await loading;
        await waitOnExecutionContext(subject.ctx.ctx);
      }
    },
  );

  it.each([-1, 1])(
    'keeps an R2 metadata size difference of %i corrupt before a pull',
    async (delta) => {
      const subject = await fixture('r2', BYTES.byteLength + delta);
      const cancel = vi.fn();
      const pull = vi.fn();
      const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
      const response = new Response(body);
      const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
      subject.pending.resolve(response);
      vi.spyOn(console, 'warn').mockReturnValue();

      const loaded = await loadShell(subject.ref, subject.strategy, subject.ctx);

      expect(loaded).toStrictEqual({ kind: 'corrupt', source: 'r2' });
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(pull).not.toHaveBeenCalled();
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(subject.ctx.runtime.memory.shells.get(subject.ref.sha256)).toBeUndefined();

      await waitOnExecutionContext(subject.ctx.ctx);
    },
  );

  it.each([-1, 1])(
    'keeps a native R2 EOF difference of %i corrupt after its body read',
    async (delta) => {
      const subject = await fixture('r2');
      const response = new Response(new Uint8Array(BYTES.byteLength + delta));
      const arrayBuffer = vi.spyOn(response, 'arrayBuffer');
      subject.pending.resolve(response);
      vi.spyOn(console, 'warn').mockReturnValue();

      const loaded = await loadShell(subject.ref, subject.strategy, subject.ctx);

      expect(loaded).toStrictEqual({ kind: 'corrupt', source: 'r2' });
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(subject.ctx.runtime.memory.shells.get(subject.ref.sha256)).toBeUndefined();

      await waitOnExecutionContext(subject.ctx.ctx);
    },
  );

  it('retains exact fast native R2 bytes and charges the backing sentinel capacity', async () => {
    const ref = await reference();
    const ctx = context('r2');
    const key = r2ArtifactKey(ref.sha256);
    await env.ARTIFACTS.put(key, BYTES);
    try {
      const loaded = await loadShell(ref, r2ShellStrategy, ctx);

      expect(loaded).toStrictEqual({
        kind: 'ok',
        read: { bytes: BYTES, source: 'r2', latencyMs: 0 },
      });
      expect(ctx.runtime.memory.budget.usedBytes).toBe(BYTES.byteLength + 1);
      expect(ctx.runtime.memory.shells.get(ref.sha256)).toStrictEqual(BYTES);
    } finally {
      await waitOnExecutionContext(ctx.ctx);
      await env.ARTIFACTS.delete(key);
    }
  });

  it.each([true, false])(
    'uses actual Static Assets body length with Content-Length=%s and an oversized wrong reference',
    async (withLength) => {
      const subject = await fixture('static-assets');
      const headers = withLength ? { 'content-length': String(BYTES.byteLength) } : {};
      const response = new Response(BYTES, { headers });
      const ref = { ...subject.ref, byteLength: Number.MAX_SAFE_INTEGER - 1 };
      // The spy calls this saved method with its original receiver through .call(this, result).
      // eslint-disable-next-line @typescript-eslint/unbound-method, vitest/unbound-method
      const originalFinish = CacheBody.prototype.finish;
      let capacity: number | undefined;
      let readBytes: Uint8Array | undefined;
      vi.spyOn(CacheBody.prototype, 'finish').mockImplementation(function recordFinishedBody(
        this: CacheBody,
        result,
      ) {
        const bytes = originalFinish.call(this, result);
        readBytes = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
        capacity = readBytes.buffer.byteLength;
        return bytes;
      });
      subject.pending.resolve(response);
      vi.spyOn(console, 'warn').mockReturnValue();

      const loaded = await loadShell(ref, subject.strategy, subject.ctx);

      expect(loaded).toStrictEqual({ kind: 'corrupt', source: 'static-assets' });
      expect(readBytes).toStrictEqual(BYTES);
      expect(capacity).toBe(withLength ? BYTES.byteLength + 1 : BYTES.byteLength);
      expect(subject.ctx.runtime.memory.shells.get(ref.sha256)).toBeUndefined();

      await waitOnExecutionContext(subject.ctx.ctx);
    },
  );

  it('bounds only the wait for opaque KV, then ignores its late bytes without a body reader', async () => {
    const ref = await reference();
    const ctx = context('kv');
    const pending = Promise.withResolvers<ArrayBuffer | null>();
    // View the same binding through the arrayBuffer overload used by the shell strategy.
    const shells: {
      get(
        key: string,
        options: { type: 'arrayBuffer'; cacheTtl?: number },
      ): Promise<ArrayBuffer | null>;
    } = env.EDGE_STATE;
    const get = vi.spyOn(shells, 'get').mockImplementation(() => pending.promise);
    const open = vi.spyOn(CacheBody.prototype, 'open');
    const stop = vi.spyOn(CacheBody.prototype, 'stop');
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();
    const loading = loadShell(ref, kvShellStrategy, ctx);
    try {
      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      await expect(loading).resolves.toStrictEqual({
        kind: 'unavailable',
        detail: 'shell backend read timed out',
      });
      expect(get).toHaveBeenCalledTimes(1);

      pending.resolve(new Uint8Array(BYTES).buffer);
      await vi.advanceTimersByTimeAsync(0);

      expect(open).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(ctx.runtime.memory.shells.get(ref.sha256)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve(null);
      await loading;
      await waitOnExecutionContext(ctx.ctx);
    }
  });
});
