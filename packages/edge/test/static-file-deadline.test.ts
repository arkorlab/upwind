import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeBindings } from '../src/bindings.ts';
import type { BlobWorker } from '../src/edge-runtime.ts';
import { readStaticFileStream } from '../src/handlers/static-file.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { StaticFileContext } from '../src/strategies/context.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const FILE_PATH = '/stored-manual.txt';
const FILE_BODY = 'the shipped manual';
const READ_MS = 2000;

async function fixture(blobWorker?: BlobWorker) {
  const site = await seedSite({ document: pprDocument(), files: { [FILE_PATH]: FILE_BODY } });
  const file = site.manifest.staticFiles?.[FILE_PATH];
  if (file === undefined) throw new Error('the fixture must ship its file');
  const pending = Promise.withResolvers<R2ObjectBody | null>();
  const entered = Promise.withResolvers<undefined>();
  const get = vi.fn((_key: string, _options?: R2GetOptions) => {
    entered.resolve(undefined);
    return pending.promise;
  });
  const bindings: EdgeBindings = { ...env, ARTIFACTS: { get } as unknown as R2Bucket };
  const runtime = {
    ...standaloneRuntime(bindings, { memory: createEdgeMemory(() => Date.now()) }),
    blobWorker,
  };
  const originalHost = standaloneHost(bindings);
  const metric = vi.fn(originalHost.observer.metric);
  const host = { ...originalHost, observer: { ...originalHost.observer, metric } };
  const ctx = createExecutionContext();
  const serve = (init: RequestInit = {}) => {
    const request = navigation(FILE_PATH, init);
    return serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env: bindings,
        runtime,
        ctx,
        host,
        pointer: site.pointer,
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({ kind: 'found', value: site.manifest }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: DEFAULT_DELIVERY_POLICY,
        }),
      },
    );
  };
  return { file, pending, entered, get, runtime, bindings, metric, ctx, serve };
}

function neverCancel(): Promise<void> {
  return new Promise(() => {});
}

function lateObject(size: number, cancel: () => Promise<void>): R2ObjectBody {
  return { size, body: new ReadableStream<Uint8Array>({ cancel }) } as R2ObjectBody;
}

describe('a direct shipped-file lookup has a storage deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['direct', 'blob-miss'] as const)(
    'answers 503 when the %s bucket lookup stalls and releases its late body without waiting',
    async (kind) => {
      const blob = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
      const test = await fixture(kind === 'direct' ? undefined : blob);
      const cancel = vi.fn(neverCancel);
      vi.spyOn(console, 'warn').mockReturnValue();
      vi.useFakeTimers();
      let answered = false;
      const response = test.serve().then((value) => {
        answered = true;
        return value;
      });
      await test.entered.promise;
      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      expect(answered).toBe(true);

      test.pending.resolve(lateObject(test.file.byteLength, cancel));
      await vi.advanceTimersByTimeAsync(0);

      const value = await response;

      expect(value.status).toBe(503);
      expect(value.headers.get('cache-control')).toBe('private, no-store');
      expect(cancel).toHaveBeenCalledExactlyOnceWith('static file read abandoned');
      expect(test.get).toHaveBeenCalledTimes(1);
      expect(test.metric.mock.calls.at(-1)?.[0].subrequests).toBe(kind === 'direct' ? 1 : 2);

      await value.body?.cancel();
      await waitOnExecutionContext(test.ctx);
    },
  );

  it('consumes a late storage rejection after answering its existing unavailable response', async () => {
    const test = await fixture();
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();
    let answered = false;
    const response = test.serve().then((value) => {
      answered = true;
      return value;
    });
    await test.entered.promise;
    await vi.advanceTimersByTimeAsync(READ_MS + 1);

    expect(answered).toBe(true);

    test.pending.reject(new Error('late bucket rejection'));
    await vi.advanceTimersByTimeAsync(0);

    const value = await response;

    expect(value.status).toBe(503);
    expect(test.metric.mock.calls.at(-1)?.[0].shellSource).toBe('unavailable');

    await value.body?.cancel();
    await waitOnExecutionContext(test.ctx);
  });

  it('still bounds a stream caller that supplies progress without owning a deadline', async () => {
    const test = await fixture();
    const progress = { signal: new AbortController().signal, requests: 0 };
    const context = { env: test.bindings, runtime: test.runtime } as StaticFileContext;
    vi.useFakeTimers();
    const result = readStaticFileStream(context, test.file, progress).catch((error: unknown) => {
      return error;
    });
    await test.entered.promise;
    await vi.advanceTimersByTimeAsync(READ_MS + 1);

    expect(await result).toBeInstanceOf(Error);
    expect(progress.requests).toBe(1);

    test.pending.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each([
    { headers: undefined, status: 200, body: FILE_BODY, options: undefined },
    {
      headers: { range: 'bytes=4-10' },
      status: 206,
      body: 'shipped',
      options: { range: { offset: 4, length: 7 } },
    },
  ])('keeps the timely $status response streaming with the same range call', async (answer) => {
    const test = await fixture();
    const pull = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pull();
          controller.enqueue(new TextEncoder().encode(answer.body));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = test.serve({ headers: answer.headers });
    await test.entered.promise;
    test.pending.resolve({ size: test.file.byteLength, body: stream } as R2ObjectBody);

    const value = await response;

    expect([value.status, pull.mock.calls.length]).toStrictEqual([answer.status, 0]);
    expect(test.get.mock.calls[0]).toStrictEqual([
      `blobs/${test.file.sha256}`,
      ...(answer.options === undefined ? [] : [answer.options]),
    ]);
    await expect(value.text()).resolves.toBe(answer.body);

    await waitOnExecutionContext(test.ctx);
  });

  it.each(['head', 'held', 'precondition', 'range'] as const)(
    'answers a manifest-only %s request without asking R2 or starting a deadline',
    async (kind) => {
      const test = await fixture();
      const init: RequestInit = {
        head: { method: 'HEAD' },
        held: { headers: { 'if-none-match': `"${test.file.sha256}"` } },
        precondition: { headers: { 'if-match': '"another"' } },
        range: { headers: { range: 'bytes=999-1000' } },
      }[kind];
      vi.useFakeTimers();

      const response = await test.serve(init);

      expect(response.status).toBe({ head: 200, held: 304, precondition: 412, range: 416 }[kind]);
      expect(test.get).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await response.body?.cancel();
      await waitOnExecutionContext(test.ctx);
    },
  );
});
