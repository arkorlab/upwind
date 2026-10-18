import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlobWorker } from '../src/edge-runtime.ts';
import { readStaticFileStream } from '../src/handlers/static-file.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import type { StandaloneEnv } from '../src/standalone/env.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import type { StaticFileContext } from '../src/strategies/context.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const FILE_PATH = '/stored-manual.txt';
const FILE_BODY = 'the shipped manual';
const READ_MS = 2000;

type BucketRead = (key: string, options?: R2GetOptions) => Promise<R2ObjectBody | null>;

async function fixture(blobWorker?: BlobWorker) {
  const site = await seedSite({ document: pprDocument(), files: { [FILE_PATH]: FILE_BODY } });
  const file = site.manifest.staticFiles?.[FILE_PATH];
  if (file === undefined) throw new Error('the fixture must ship its file');
  const pending = Promise.withResolvers<R2ObjectBody | null>();
  const entered = Promise.withResolvers<undefined>();
  const get = vi.fn<BucketRead>(() => {
    entered.resolve(undefined);
    return pending.promise;
  });
  const bindings: StandaloneEnv = { ...env, ARTIFACTS: { get } as unknown as R2Bucket };
  const runtime = {
    ...standaloneRuntime(bindings, { memory: createEdgeMemory(() => Date.now()) }),
    blobWorker,
  };
  const originalHost = standaloneHost(bindings);
  const metric = vi.fn<typeof originalHost.observer.metric>();
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

async function settled(read: Promise<unknown>): Promise<unknown> {
  try {
    return await read;
  } catch (error) {
    return error;
  }
}

function neverCancel(): Promise<void> {
  return new Promise(() => {
    // The source never acknowledges cancellation; the response must not wait for it.
  });
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
      const subject = await fixture(kind === 'direct' ? undefined : blob);
      const cancel = vi.fn(neverCancel);
      vi.spyOn(console, 'warn').mockReturnValue();
      vi.useFakeTimers();
      let answered = false;
      const response = (async () => {
        const value = await subject.serve();
        answered = true;
        return value;
      })();
      await subject.entered.promise;
      await vi.advanceTimersByTimeAsync(READ_MS + 1);

      expect(answered).toBe(true);

      subject.pending.resolve(lateObject(subject.file.byteLength, cancel));
      await vi.advanceTimersByTimeAsync(0);

      const value = await response;

      expect(value.status).toBe(503);
      expect(value.headers.get('cache-control')).toBe('private, no-store');
      expect(cancel).toHaveBeenCalledExactlyOnceWith('static file read abandoned');
      expect(subject.get).toHaveBeenCalledTimes(1);
      expect(subject.metric.mock.calls.at(-1)?.[0].subrequests).toBe(kind === 'direct' ? 1 : 2);

      await value.body?.cancel();
      await waitOnExecutionContext(subject.ctx);
    },
  );

  it('consumes a late storage rejection after answering its existing unavailable response', async () => {
    const subject = await fixture();
    vi.spyOn(console, 'warn').mockReturnValue();
    vi.useFakeTimers();
    let answered = false;
    const response = (async () => {
      const value = await subject.serve();
      answered = true;
      return value;
    })();
    await subject.entered.promise;
    await vi.advanceTimersByTimeAsync(READ_MS + 1);

    expect(answered).toBe(true);

    subject.pending.reject(new Error('late bucket rejection'));
    await vi.advanceTimersByTimeAsync(0);

    const value = await response;

    expect(value.status).toBe(503);
    expect(subject.metric.mock.calls.at(-1)?.[0].shellSource).toBe('unavailable');

    await value.body?.cancel();
    await waitOnExecutionContext(subject.ctx);
  });

  it('still bounds a stream caller that supplies progress without owning a deadline', async () => {
    const subject = await fixture();
    const progress = { signal: new AbortController().signal, requests: 0 };
    const context = { env: subject.bindings, runtime: subject.runtime } as StaticFileContext;
    vi.useFakeTimers();
    const result = settled(readStaticFileStream(context, subject.file, progress));
    await subject.entered.promise;
    await vi.advanceTimersByTimeAsync(READ_MS + 1);

    await expect(result).resolves.toBeInstanceOf(Error);
    expect(progress.requests).toBe(1);

    subject.pending.resolve(null);
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
    const subject = await fixture();
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
    const response = subject.serve(answer.headers === undefined ? {} : { headers: answer.headers });
    await subject.entered.promise;
    subject.pending.resolve({ size: subject.file.byteLength, body: stream } as R2ObjectBody);

    const value = await response;

    expect([value.status, pull.mock.calls.length]).toStrictEqual([answer.status, 0]);
    expect(subject.get.mock.calls[0]).toStrictEqual([
      `blobs/${subject.file.sha256}`,
      ...(answer.options === undefined ? [] : [answer.options]),
    ]);
    await expect(value.text()).resolves.toBe(answer.body);

    await waitOnExecutionContext(subject.ctx);
  });

  it.each(['head', 'held', 'precondition', 'range'] as const)(
    'answers a manifest-only %s request without asking R2 or starting a deadline',
    async (kind) => {
      const subject = await fixture();
      const init: RequestInit = {
        head: { method: 'HEAD' },
        held: { headers: { 'if-none-match': `"${subject.file.sha256}"` } },
        precondition: { headers: { 'if-match': '"another"' } },
        range: { headers: { range: 'bytes=999-1000' } },
      }[kind];
      vi.useFakeTimers();

      const response = await subject.serve(init);

      expect(response.status).toBe({ head: 200, held: 304, precondition: 412, range: 416 }[kind]);
      expect(subject.get).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await response.body?.cancel();
      await waitOnExecutionContext(subject.ctx);
    },
  );
});
