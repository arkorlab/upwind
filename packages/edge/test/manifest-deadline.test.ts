import { serializeManifest } from '@stayingupwind/core/manifest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import type { BlobWorker } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { getManifest } from '../src/preview/manifest.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const READ_MS = 2000;
const HEDGE_MS = 50;
const COPY_MS = 1000;
const HEADER_DELAY_MS = 750;
const FALLBACK = 'the application still answers';

async function fixture(durable: 'missing' | 'stalled' = 'missing') {
  const site = await seedSite({ document: pprDocument() });
  const bytes = new TextEncoder().encode(serializeManifest(site.manifest));
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new TypeError('owned manifest buffer required');
  const kv = Promise.withResolvers<ArrayBuffer | null>();
  const bucket = Promise.withResolvers<R2ObjectBody | null>();
  if (durable === 'missing') bucket.resolve(null);
  const get = vi.fn(() => kv.promise);
  const getObject = vi.fn(() => bucket.promise);
  const bindings: EdgeBindings = {
    ...env,
    EDGE_STATE: { get } as unknown as KVNamespace,
    ARTIFACTS: { get: getObject } as unknown as R2Bucket,
  };
  const dispatch = vi.fn(() => Promise.resolve(htmlResponse(FALLBACK)));
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: dispatch,
  });
  const ctx = createExecutionContext();
  const request = navigation('/');
  return {
    site,
    bytes: bytes.buffer,
    kv,
    bucket,
    get,
    getObject,
    bindings,
    runtime,
    ctx,
    dispatch,
    serve: () => {
      return serveFromPointer({
        request,
        url: new URL(request.url),
        env: bindings,
        runtime,
        ctx,
        host: standaloneHost(env),
        pointer: { ...site.pointer, selectedPolicy: 'builtin' },
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      });
    },
    release: () => {
      kv.resolve(null);
      bucket.resolve(null);
    },
  };
}

function settleLateKv(
  subject: Awaited<ReturnType<typeof fixture>>,
  late: 'bytes' | 'rejection',
): void {
  if (late === 'bytes') subject.kv.resolve(subject.bytes);
  else subject.kv.reject(new Error('late binding rejection'));
}

/** The authority answers independently of whether the cached copy can finish. */
function answerBucket(test: Awaited<ReturnType<typeof fixture>>): void {
  const response = new Response(test.bytes);
  test.bucket.resolve({
    size: test.bytes.byteLength,
    body: response.body,
    arrayBuffer: () => response.arrayBuffer(),
  } as unknown as R2ObjectBody);
}

function blockedCopy(phase: 'headers' | 'body') {
  const pending = Promise.withResolvers<Response>();
  const cancelled = vi.fn();
  const signals: (AbortSignal | null | undefined)[] = [];
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
      cancel: cancelled,
    }),
  );
  const blobWorker = vi.fn<BlobWorker>((_path, options) => {
    signals.push(options.signal);
    return phase === 'headers' ? pending.promise : Promise.resolve(response);
  });
  return { pending, response, cancelled, signals, blobWorker };
}

describe('a cold manifest cannot outlive its backend read budget', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['missing', 'stalled'] as const)(
    'falls back to the application when KV stalls and durable is %s',
    async (durable) => {
      const test = await fixture(durable);
      vi.spyOn(console, 'warn').mockReturnValue();
      vi.useFakeTimers();
      let answered = false;
      const response = (async () => {
        const value = await test.serve();
        answered = true;
        return value;
      })();
      try {
        await vi.advanceTimersByTimeAsync(HEDGE_MS);

        expect(test.getObject).toHaveBeenCalledTimes(1);
        expect(answered).toBe(false);

        await vi.advanceTimersByTimeAsync(READ_MS + 1);

        expect(answered).toBe(true);

        const value = await response;

        await expect(value.text()).resolves.toBe(FALLBACK);
        expect(value.headers.get('x-arkor-edge')).toContain('manifest-unavailable');
        expect(test.dispatch).toHaveBeenCalledTimes(1);
        expect(test.runtime.memory.absentManifests.get(test.site.manifestId)).toBeUndefined();
      } finally {
        test.release();

        const value = await response;
        if (!value.bodyUsed) await value.body?.cancel();
        await waitOnExecutionContext(test.ctx);
      }
    },
  );

  it('does not put a deadline or a read in front of a held manifest', async () => {
    const test = await fixture();

    test.runtime.memory.manifests.set(
      test.site.manifestId,
      test.site.manifest,
      test.bytes.byteLength,
    );

    vi.useFakeTimers();
    try {
      const read = await getManifest(test.bindings, test.runtime, test.site.manifestId);

      expect(read.kind === 'found' && read.value).toBe(test.site.manifest);
      expect(test.get).not.toHaveBeenCalled();
      expect(test.getObject).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      test.release();
    }
  });

  it('clears the cold deadline when KV answers before the hedge', async () => {
    const test = await fixture();

    test.kv.resolve(test.bytes);

    vi.useFakeTimers();
    try {
      const read = await getManifest(test.bindings, test.runtime, test.site.manifestId);

      expect(read.kind).toBe('found');
      expect(test.get).toHaveBeenCalledTimes(1);
      expect(test.getObject).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      test.release();
    }
  });

  it.each(['bytes', 'rejection'] as const)(
    'consumes late KV %s without adoption or an absence hold, then retries',
    async (late) => {
      const test = await fixture();
      vi.spyOn(console, 'warn').mockReturnValue();
      vi.useFakeTimers();
      const reading = getManifest(test.bindings, test.runtime, test.site.manifestId);
      let result: Awaited<typeof reading> | undefined;
      const observed = (async () => {
        result = await reading;
      })();
      try {
        await vi.advanceTimersByTimeAsync(READ_MS + HEDGE_MS + 1);

        expect(result?.kind).toBe('unavailable');

        settleLateKv(test, late);
        await vi.advanceTimersByTimeAsync(0);

        expect(test.runtime.memory.manifests.get(test.site.manifestId)).toBeUndefined();
        expect(test.runtime.memory.absentManifests.get(test.site.manifestId)).toBeUndefined();

        test.get.mockResolvedValue(test.bytes);

        const next = await getManifest(test.bindings, test.runtime, test.site.manifestId);

        expect(next.kind).toBe('found');
        expect(test.get).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        test.release();

        await observed;
      }
    },
  );

  it('bounds the sequential validation read without holding an absence', async () => {
    const test = await fixture();
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof getManifest>> | undefined;
    const reading = (async () => {
      result = await getManifest(test.bindings, test.runtime, test.site.manifestId, {
        live: false,
        holdAbsence: false,
      });
    })();
    try {
      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      expect(result?.kind).toBe('unavailable');
      expect(test.getObject).toHaveBeenCalledTimes(1);
      expect(test.runtime.memory.absentManifests.get(test.site.manifestId)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      test.release();

      await reading;
    }
  });

  it('releases late durable headers without starting their body buffer', async () => {
    const test = await fixture('stalled');

    test.kv.resolve(null);

    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const arrayBuffer = vi.fn(() => Promise.resolve(test.bytes));
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();
    let result: Awaited<ReturnType<typeof getManifest>> | undefined;
    const reading = (async () => {
      result = await getManifest(test.bindings, test.runtime, test.site.manifestId);
    })();
    try {
      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      // The durable failure leaves KV's missing answer standing, without holding that absence.
      expect(result?.kind).toBe('missing');

      test.bucket.resolve({
        size: test.bytes.byteLength,
        body,
        arrayBuffer,
      } as unknown as R2ObjectBody);

      await vi.advanceTimersByTimeAsync(0);

      expect(cancelled).toHaveBeenCalledTimes(1);
      expect(arrayBuffer).not.toHaveBeenCalled();
      expect(test.runtime.memory.manifests.get(test.site.manifestId)).toBeUndefined();
      expect(test.runtime.memory.absentManifests.get(test.site.manifestId)).toBeUndefined();
    } finally {
      test.release();

      await reading;
    }
  });

  it('reserves bucket time even when both copy and bucket remain stalled', async () => {
    const test = await fixture('stalled');

    test.kv.resolve(null);

    const pending = Promise.withResolvers<Response>();
    const blobWorker = vi.fn(() => pending.promise);
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();
    const runtime = { ...test.runtime, blobWorker };
    let result: Awaited<ReturnType<typeof getManifest>> | undefined;
    const reading = (async () => {
      result = await getManifest(test.bindings, runtime, test.site.manifestId);
    })();
    try {
      await vi.advanceTimersByTimeAsync(COPY_MS);

      expect(result).toBeUndefined();
      expect(test.getObject).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(READ_MS - COPY_MS + 1);

      expect(result?.kind).toBe('missing');
      expect(blobWorker).toHaveBeenCalledTimes(1);
      expect(test.runtime.memory.absentManifests.get(test.site.manifestId)).toBeUndefined();
    } finally {
      pending.resolve(new Response(null, { status: 404 }));

      test.release();

      await reading;
    }
  });

  it.each(['headers', 'body'] as const)(
    'reads the healthy bucket before the overall deadline when copy %s stall',
    async (phase) => {
      const test = await fixture('stalled');
      test.kv.resolve(null);
      answerBucket(test);
      const copy = blockedCopy(phase);
      const runtime = { ...test.runtime, blobWorker: copy.blobWorker };
      vi.spyOn(console, 'warn').mockReturnValue();
      vi.useFakeTimers();
      const read = getManifest(test.bindings, runtime, test.site.manifestId);
      try {
        await vi.advanceTimersByTimeAsync(COPY_MS);

        const answer = await read;

        expect(answer.kind).toBe('found');
        expect(test.getObject).toHaveBeenCalledTimes(1);
        expect(test.dispatch).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);

        // A late header answer is abandoned too; it cannot replace the authority's accepted bytes.
        copy.pending.resolve(copy.response);
        await vi.advanceTimersByTimeAsync(0);

        expect(copy.cancelled).toHaveBeenCalledTimes(1);
        expect(runtime.memory.manifests.get(test.site.manifestId)).toBeDefined();
      } finally {
        copy.pending.resolve(copy.response);
        test.release();
        await read;
      }
    },
  );

  it('charges slow headers against the same copy body stage budget', async () => {
    const test = await fixture('stalled');
    test.kv.resolve(null);
    answerBucket(test);
    const copy = blockedCopy('headers');
    const runtime = { ...test.runtime, blobWorker: copy.blobWorker };
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();
    const read = getManifest(test.bindings, runtime, test.site.manifestId);
    try {
      await vi.advanceTimersByTimeAsync(HEADER_DELAY_MS);
      copy.pending.resolve(copy.response);
      await vi.advanceTimersByTimeAsync(COPY_MS - HEADER_DELAY_MS);

      expect((await read).kind).toBe('found');
      expect(copy.cancelled).toHaveBeenCalledTimes(1);
      expect(test.getObject).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      copy.pending.resolve(copy.response);
      test.release();
      await read;
    }
  });

  it('accepts a timely copy without asking the bucket', async () => {
    const test = await fixture('stalled');
    test.kv.resolve(null);
    const blobWorker = vi.fn<BlobWorker>(() => Promise.resolve(new Response(test.bytes)));
    const runtime = { ...test.runtime, blobWorker };
    vi.useFakeTimers();
    try {
      const answer = await getManifest(test.bindings, runtime, test.site.manifestId);

      expect(answer.kind).toBe('found');
      expect(blobWorker).toHaveBeenCalledTimes(1);
      expect(test.getObject).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      test.release();
    }
  });
});
