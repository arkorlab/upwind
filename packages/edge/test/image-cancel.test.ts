import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EdgeHost } from '../src/edge-host.ts';
import type { EdgeRuntime, FetchImpl, TransformImage } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { type PointerReads, serveFromPointer } from '../src/route.ts';
import { standaloneHost, type StandaloneEnv, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [
    { protocol: 'https', hostname: String.raw`^(?:cdn\.site\.example)$`, pathname: '^.*$' },
  ],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const PNG = concatBytes([
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  new Uint8Array(2048),
]);
const OPTIMIZED = encodeUtf8('optimized');

interface Serving {
  readonly site: StandaloneEnv;
  readonly pointer: EdgePointer;
  readonly runtime: EdgeRuntime;
  readonly host: EdgeHost;
  readonly manifest: ProjectManifest;
  readonly reads?: PointerReads;
}

async function serving(
  fetchImpl: FetchImpl,
  transformImage: TransformImage,
  files?: Readonly<Record<string, string>>,
): Promise<Serving> {
  const { pointer, manifest } = await seedSite({ document: pprDocument(), images: CONFIG, files });
  const site = { ...env };
  const runtime = standaloneRuntime(site, {
    memory: createEdgeMemory(() => Date.now()),
    fetchImpl,
    dispatchApp: (_scriptName, request) => fetchImpl(request),
    transformImage,
  });
  return { site, pointer, runtime, manifest, host: standaloneHost(site) };
}

function begin(served: Serving, source: string, signal: AbortSignal) {
  const query = new URLSearchParams({ url: source, w: '64', q: '75' });
  const request = new Request<unknown, IncomingRequestCfProperties>(
    `https://site.example/_next/image?${query.toString()}`,
    {
      headers: { accept: 'image/webp', 'sec-fetch-dest': 'image' },
      signal,
    },
  );
  const ctx = createExecutionContext();
  const response = serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env: served.site,
      ctx,
      runtime: served.runtime,
      host: served.host,
      pointer: served.pointer,
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    served.reads,
  );
  // Old-source proofs deliberately end with a request still waiting on its old deadline.
  void response.catch(() => {
    // The request's eventual failure is not an unhandled promise after the assertion failed.
  });
  return { response, ctx };
}

function remote(): string {
  return `https://cdn.site.example/${crypto.randomUUID()}.png`;
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {
    // A fetch or service which ignores cancellation, as a host's override may.
  });
}

async function transformed(source: ReadableStream<Uint8Array>) {
  await new Response(source).arrayBuffer();
  return { contentType: 'image/webp', body: new Blob([OPTIMIZED]).stream() };
}

describe('an image request whose client leaves', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(['local', 'remote'])(
    'refuses a %s source abandoned during the preceding cache lookup',
    async (kind) => {
      const entered = Promise.withResolvers<undefined>();
      const lookup = Promise.withResolvers<undefined>();
      const fetchSource = vi.fn(() => Promise.resolve(new Response(PNG)));
      const transform = vi.fn(transformed);
      const served = await serving(fetchSource, transform);
      const cache = await caches.open(standaloneHost(served.site).names.imageCache);
      vi.spyOn(cache, 'match').mockImplementation(() => {
        entered.resolve(undefined);
        return lookup.promise;
      });
      vi.spyOn(caches, 'open').mockResolvedValue(cache);
      const client = new AbortController();
      const source = kind === 'local' ? `/draw/${crypto.randomUUID()}.png` : remote();
      const run = begin(served, source, client.signal);
      await entered.promise;

      client.abort(new Error('client left during lookup'));
      lookup.resolve(undefined);

      await expect(run.response).resolves.toHaveProperty('status', 502);
      await expect((await run.response).text()).resolves.toBe('image request abandoned');
      expect(fetchSource).not.toHaveBeenCalled();
      expect(transform).not.toHaveBeenCalled();

      await waitOnExecutionContext(run.ctx);
    },
  );

  it('refuses a source abandoned after source middleware without losing its dispatch count', async () => {
    const entered = Promise.withResolvers<undefined>();
    const middleware = Promise.withResolvers<Response>();
    const fetchSource = vi.fn(() => {
      entered.resolve(undefined);
      return middleware.promise;
    });
    const transform = vi.fn(transformed);
    const path = `/gated/${crypto.randomUUID()}.png`;
    const served = await serving(fetchSource, transform, { [path]: 'unread' });
    const app = {
      deploymentId: 'dpl_site',
      scriptName: 'site-app',
      middlewareScriptName: 'site-middleware',
    };
    const manifest: ProjectManifest = {
      ...served.manifest,
      middleware: { matchers: [{ sourceRegex: '^/gated/' }] },
    };
    const reads: PointerReads = {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: Promise.resolve({
        kind: 'found',
        source: 'exact',
        policy: DEFAULT_DELIVERY_POLICY,
      }),
    };
    const metric = vi.spyOn(served.host.observer, 'metric');
    const client = new AbortController();
    const run = begin(
      { ...served, pointer: { ...served.pointer, app }, reads },
      path,
      client.signal,
    );
    await entered.promise;

    client.abort(new Error('client left during middleware'));
    middleware.resolve(
      new Response(null, { headers: { 'x-middleware-rewrite': 'https://elsewhere.example/file' } }),
    );

    await expect(run.response).resolves.toHaveProperty('status', 502);
    expect(metric.mock.calls.at(-1)?.[0].subrequests).toBe(1);
    expect(fetchSource).toHaveBeenCalledTimes(1);
    expect(transform).not.toHaveBeenCalled();

    await waitOnExecutionContext(run.ctx);
  });

  it('refuses a source abandoned between remote redirect hops without losing the first hop', async () => {
    const client = new AbortController();
    const redirected = vi.fn(() => {
      client.abort(new Error('client left between redirects'));
    });
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: redirected }), {
      status: 302,
      headers: { location: remote() },
    });
    const fetchSource = vi.fn(() => Promise.resolve(response));
    const transform = vi.fn(transformed);
    const served = await serving(fetchSource, transform);
    const metric = vi.spyOn(served.host.observer, 'metric');
    const run = begin(served, remote(), client.signal);

    await expect(run.response).resolves.toHaveProperty('status', 502);
    expect(redirected).toHaveBeenCalledWith('image source redirected');
    expect(metric.mock.calls.at(-1)?.[0].subrequests).toBe(1);
    expect(fetchSource).toHaveBeenCalledTimes(1);
    expect(transform).not.toHaveBeenCalled();

    await waitOnExecutionContext(run.ctx);
  });

  it.each(['local', 'remote'])(
    'cancels a pending %s source without waiting for its deadline',
    async (kind) => {
      const asked = Promise.withResolvers<Request>();
      const transform = vi.fn(transformed);
      const served = await serving((request) => {
        asked.resolve(request);
        return never<Response>();
      }, transform);
      vi.useFakeTimers();
      const client = new AbortController();
      const source = kind === 'local' ? `/draw/${crypto.randomUUID()}.png` : remote();
      const run = begin(served, source, client.signal);
      const upstream = await asked.promise;

      client.abort(new Error('client left'));

      expect(upstream.signal.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(0);

      expect((await run.response).status).toBe(400);
      expect(transform).not.toHaveBeenCalled();
    },
  );

  it('cancels a source while its existing signature read waits for bytes', async () => {
    const asked = Promise.withResolvers<undefined>();
    const cancel = vi.fn();
    const transform = vi.fn(transformed);
    const served = await serving(() => {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>(
            {
              pull() {
                asked.resolve(undefined);
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        ),
      );
    }, transform);
    vi.useFakeTimers();
    const client = new AbortController();
    const run = begin(served, remote(), client.signal);
    await asked.promise;

    client.abort(new Error('client left'));
    await vi.advanceTimersByTimeAsync(0);

    expect(cancel).toHaveBeenCalledWith('client left');
    expect((await run.response).status).toBe(502);
    expect(transform).not.toHaveBeenCalled();
  });

  it('cuts a pending transformation, releases its late answer, and starts no fallback fetch', async () => {
    const given = Promise.withResolvers<ReadableStream<Uint8Array>>();
    const late = Promise.withResolvers<Awaited<ReturnType<TransformImage>>>();
    const cancelSource = vi.fn();
    const cancelLate = vi.fn();
    const fetchSource = vi.fn(() => {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(PNG);
            },
            cancel: cancelSource,
          }),
        ),
      );
    });
    const served = await serving(fetchSource, (source) => {
      given.resolve(source);
      return late.promise;
    });
    vi.useFakeTimers();
    const client = new AbortController();
    const run = begin(served, remote(), client.signal);
    const input = await given.promise;

    client.abort(new Error('client left'));
    await vi.advanceTimersByTimeAsync(0);

    expect(cancelSource).toHaveBeenCalledWith('client left');
    expect((await run.response).status).toBe(502);
    await expect(new Response(input).arrayBuffer()).rejects.toThrow('client left');

    late.resolve({ contentType: 'image/webp', body: new ReadableStream({ cancel: cancelLate }) });
    await vi.advanceTimersByTimeAsync(0);

    expect(cancelLate).toHaveBeenCalledWith('image transformation abandoned');
    expect(fetchSource).toHaveBeenCalledTimes(1);
  });

  it('cancels a fallback fetch already waiting for its source', async () => {
    const fallback = Promise.withResolvers<Request>();
    let calls = 0;
    const served = await serving(
      (request) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(new Response(PNG));
        }
        fallback.resolve(request);
        return never<Response>();
      },
      () => Promise.reject(new Error('service failed')),
    );
    vi.useFakeTimers();
    const client = new AbortController();
    const run = begin(served, remote(), client.signal);
    const upstream = await fallback.promise;

    client.abort(new Error('client left'));

    expect(upstream.signal.aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(0);

    expect((await run.response).status).toBe(400);
    expect(calls).toBe(2);
  });

  it('cancels a transformed result while its existing bounded read waits for bytes', async () => {
    const reading = Promise.withResolvers<undefined>();
    const cancel = vi.fn();
    const served = await serving(
      () => Promise.resolve(new Response(PNG)),
      () => {
        return Promise.resolve({
          contentType: 'image/webp',
          body: new ReadableStream<Uint8Array>(
            {
              pull() {
                reading.resolve(undefined);
              },
              cancel,
            },
            { highWaterMark: 0 },
          ),
        });
      },
    );
    vi.useFakeTimers();
    const client = new AbortController();
    const run = begin(served, remote(), client.signal);
    await reading.promise;

    client.abort(new Error('client left'));
    await vi.advanceTimersByTimeAsync(0);

    expect(cancel).toHaveBeenCalledWith('client left');
    expect((await run.response).status).toBe(502);
  });

  it('still serves the source after an ordinary service failure while its client remains', async () => {
    const fetchSource = vi.fn(() => Promise.resolve(new Response(PNG)));
    const served = await serving(fetchSource, () => Promise.reject(new Error('service failed')));
    const client = new AbortController();

    const run = begin(served, remote(), client.signal);
    const response = await run.response;

    expect(response.status).toBe(200);
    await expect(new Response(response.body).arrayBuffer()).resolves.toStrictEqual(PNG.buffer);

    await waitOnExecutionContext(run.ctx);

    expect(fetchSource).toHaveBeenCalledTimes(2);
  });

  it('keeps the ordinary upstream refusal while its client remains', async () => {
    const transform = vi.fn(transformed);
    const served = await serving(
      () => Promise.resolve(new Response('missing', { status: 404 })),
      transform,
    );
    const run = begin(served, remote(), new AbortController().signal);
    const response = await run.response;

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe(
      '"url" parameter is valid but upstream response is invalid',
    );
    expect(transform).not.toHaveBeenCalled();

    await waitOnExecutionContext(run.ctx);
  });
});
