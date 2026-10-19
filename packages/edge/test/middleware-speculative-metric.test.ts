import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BlobWorker } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const FILE = '/manual.txt';
const BYTES = new TextEncoder().encode('the manual');
type Storage = 'bucket' | 'blob-hit' | 'blob-miss';
type Outcome = 'found' | 'missing' | 'failed';
type Answer = 'response' | 'redirect' | 'external' | 'external-unavailable' | 'continue';

function neverAcknowledges(): Promise<void> {
  return new Promise(() => {
    // The source owns this promise; releasing its body must not wait for acknowledgement.
  });
}

async function fixture(storage: Storage, answer: Answer, matched = true) {
  const site = await seedSite({ document: pprDocument(), files: { [FILE]: 'the manual' } });
  const file = site.manifest.staticFiles?.[FILE];
  if (file === undefined) throw new Error('the fixture must ship its file');
  const size = file.byteLength;
  const stored = await env.ARTIFACTS.get(`blobs/${file.sha256}`);
  if (stored === null) throw new Error('the seeded file must exist');
  const held: R2ObjectBody = stored;
  await held.body.cancel();
  const pending = Promise.withResolvers<R2ObjectBody | null>();
  const blobPending = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<undefined>();
  const bucket: { get(key: string): Promise<R2ObjectBody | null> } = env.ARTIFACTS;
  const get = vi.spyOn(bucket, 'get').mockImplementation(() => {
    entered.resolve(undefined);
    return pending.promise;
  });
  const cancel = vi.fn(neverAcknowledges);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(BYTES);
        controller.close();
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const blob = vi.fn<BlobWorker>(() => {
    if (storage === 'blob-hit') {
      entered.resolve(undefined);
      return blobPending.promise;
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  });
  const points: EdgeMetric[] = [];
  const baseHost = standaloneHost(env);
  const host = {
    ...baseHost,
    observer: {
      ...baseHost.observer,
      metric(point: EdgeMetric) {
        points.push(point);
      },
    },
  };
  const dispatched: string[] = [];
  const baseRuntime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (script) => {
      dispatched.push(script);
      switch (answer) {
        case 'redirect': {
          return Promise.resolve(
            new Response(null, {
              status: 307,
              headers: { location: 'https://site.example/login' },
            }),
          );
        }
        case 'external':
        case 'external-unavailable': {
          return Promise.resolve(
            new Response(null, {
              headers: { 'x-middleware-rewrite': 'https://elsewhere.example/manual' },
            }),
          );
        }
        case 'continue': {
          return Promise.resolve(new Response(null, { headers: { 'x-middleware-next': '1' } }));
        }
        case 'response': {
          return Promise.resolve(new Response('answered', { status: 401 }));
        }
      }
    },
    fetchImpl: () => {
      if (answer === 'external-unavailable') {
        return Promise.reject(new Error('external unavailable'));
      }
      return Promise.resolve(new Response('origin'));
    },
  });
  const runtime = { ...baseRuntime, blobWorker: storage === 'bucket' ? undefined : blob };
  const ctx = createExecutionContext();
  const serve = (init: RequestInit = {}) => {
    const request = navigation(FILE, init);
    return serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        runtime,
        ctx,
        host,
        pointer: {
          ...site.pointer,
          app: {
            deploymentId: 'dpl_site',
            scriptName: 'site-app',
            middlewareScriptName: 'site-middleware',
          },
        },
        pointerMs: 0,
        privateDelivery: false,
        cspReportingPath: undefined,
      },
      {
        manifestLookup: Promise.resolve({
          kind: 'found',
          value: {
            ...site.manifest,
            middleware: {
              matchers: [{ sourceRegex: matched ? '^/manual[.]txt$' : '^/elsewhere$' }],
            },
          },
        }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: DEFAULT_DELIVERY_POLICY,
        }),
      },
    );
  };
  let finished = false;
  function finish(outcome: Outcome = 'found') {
    if (finished) return;
    finished = true;
    if (outcome === 'failed') {
      pending.reject(new Error('bucket read failed'));
    } else {
      pending.resolve(outcome === 'missing' ? null : { ...held, size, body });
    }
    blobPending.resolve(new Response(body, { headers: { 'content-length': String(size) } }));
  }
  return { serve, finish, entered, get, blob, cancel, ctx, points, dispatched };
}

describe('a middleware answer counts the speculative read it abandons', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { storage: 'bucket', answer: 'response', outcome: 'found', count: 2, status: 401 },
    { storage: 'blob-hit', answer: 'redirect', outcome: 'found', count: 2, status: 307 },
    { storage: 'blob-miss', answer: 'external', outcome: 'found', count: 4, status: 200 },
    { storage: 'bucket', answer: 'external-unavailable', outcome: 'found', count: 3, status: 502 },
    { storage: 'blob-miss', answer: 'response', outcome: 'missing', count: 3, status: 401 },
    { storage: 'blob-miss', answer: 'redirect', outcome: 'failed', count: 3, status: 307 },
    { storage: 'bucket', answer: 'response', outcome: 'missing', count: 2, status: 401 },
    { storage: 'bucket', answer: 'redirect', outcome: 'failed', count: 2, status: 307 },
  ] satisfies readonly {
    readonly storage: Storage;
    readonly answer: Answer;
    readonly outcome: Outcome;
    readonly count: number;
    readonly status: number;
  }[])('$answer with late $storage / $outcome records one complete point', async (example) => {
    vi.spyOn(console, 'warn').mockReturnValue();
    const subject = await fixture(example.storage, example.answer);
    const loading = subject.serve();
    try {
      await subject.entered.promise;
      // The storage promise is still unresolved: awaiting the response proves it is not on TTFB.
      const response = await loading;

      expect(response.status).toBe(example.status);
      expect(subject.points).toStrictEqual([]);

      subject.finish(example.outcome);
      await waitOnExecutionContext(subject.ctx);

      expect(subject.points).toHaveLength(1);
      expect(subject.points[0]?.subrequests).toBe(example.count);
      expect(subject.cancel).toHaveBeenCalledTimes(example.outcome === 'found' ? 1 : 0);
      expect({
        bucket: subject.get.mock.calls.length,
        blob: subject.blob.mock.calls.length,
        dispatch: subject.dispatched,
      }).toStrictEqual({
        bucket: example.storage === 'blob-hit' ? 0 : 1,
        blob: example.storage === 'bucket' ? 0 : 1,
        dispatch: ['site-middleware'],
      });
      await response.body?.cancel();
    } finally {
      subject.finish();
      await loading;
      await waitOnExecutionContext(subject.ctx);
    }
  });

  it('does not defer a HEAD answer or invent a storage request', async () => {
    const subject = await fixture('bucket', 'redirect');
    try {
      const response = await subject.serve({ method: 'HEAD' });

      expect(response.status).toBe(307);
      expect(subject.get).not.toHaveBeenCalled();
      expect(subject.points).toHaveLength(1);
      expect(subject.points[0]?.subrequests).toBe(1);
    } finally {
      subject.finish();
      await waitOnExecutionContext(subject.ctx);
    }
  });

  it.each([true, false])(
    'keeps a served file counted once with middleware matching=%s',
    async (matched) => {
      const subject = await fixture('bucket', 'continue', matched);
      const loading = subject.serve();
      try {
        await subject.entered.promise;
        subject.finish();
        const response = await loading;

        await expect(response.text()).resolves.toBe('the manual');
        await waitOnExecutionContext(subject.ctx);

        expect(subject.points).toHaveLength(1);
        expect(subject.points[0]?.subrequests).toBe(matched ? 2 : 1);
        expect(subject.get).toHaveBeenCalledTimes(1);
      } finally {
        subject.finish();
        await loading;
        await waitOnExecutionContext(subject.ctx);
      }
    },
  );
});
