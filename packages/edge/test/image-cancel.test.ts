import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import {
  FUNCTION_HEADER,
  MISDIRECTED_STATUS,
  parseScopeRevision,
  SCOPE_REVISION_HEADER,
  scopeRevisionValue,
} from '@stayingupwind/core/paas';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { takeInvalidation } from '../src/cache/condemned.ts';
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

function begin(
  served: Serving,
  source: string,
  signal: AbortSignal,
  headers?: Readonly<Record<string, string>>,
) {
  const query = new URLSearchParams({ url: source, w: '64', q: '75' });
  const request = new Request<unknown, IncomingRequestCfProperties>(
    `https://site.example/_next/image?${query.toString()}`,
    {
      headers: { accept: 'image/webp', 'sec-fetch-dest': 'image', ...headers },
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

function shippedFile(served: Serving, path: string) {
  const file = served.manifest.staticFiles?.[path];
  if (file === undefined) throw new Error('missing shipped fixture');
  return file;
}

async function storedFile(served: Serving, path: string) {
  const file = shippedFile(served, path);
  const object = await served.site.ARTIFACTS.get(blobObjectKey(file.sha256));
  if (object === null) throw new Error('missing stored fixture');
  return object;
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

  it('dispatches a local image with its known scope receipt and preserves the image bytes', async () => {
    const scopeId = 'local-image-scope';
    const fetchSource = vi.fn<FetchImpl>(() => Promise.resolve(new Response(PNG)));
    const sourceBytes: Uint8Array[] = [];
    const transform = vi.fn(async (source: ReadableStream<Uint8Array>) => {
      sourceBytes.push(new Uint8Array(await new Response(source).arrayBuffer()));
      return { contentType: 'image/webp', body: new Blob([OPTIMIZED]).stream() };
    });
    const served = await serving(fetchSource, transform);
    const manifest: ProjectManifest = {
      ...served.manifest,
      cache: { keySchemaVersion: 1, scopeId },
    };
    takeInvalidation(served.runtime.memory, scopeId, { value: 'image', bound: '7' });
    const receipt = served.runtime.memory.invalidations.responseRevisionOf(scopeId);
    const forged = scopeRevisionValue({ revision: 999, invalidatedAt: Date.now() });
    const run = begin(
      {
        ...served,
        reads: {
          manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
          policyLookup: Promise.resolve({
            kind: 'found',
            source: 'exact',
            policy: DEFAULT_DELIVERY_POLICY,
          }),
        },
      },
      `/draw/${crypto.randomUUID()}.png`,
      new AbortController().signal,
      { [SCOPE_REVISION_HEADER]: forged },
    );
    try {
      const response = await run.response;

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('optimized');
      expect(fetchSource).toHaveBeenCalledTimes(1);
      expect(transform).toHaveBeenCalledTimes(1);
      expect(sourceBytes).toStrictEqual([PNG]);
      expect(fetchSource.mock.calls[0]?.[0].headers.get(SCOPE_REVISION_HEADER)).not.toBe(forged);
      expect(
        parseScopeRevision(
          fetchSource.mock.calls[0]?.[0].headers.get(SCOPE_REVISION_HEADER) ?? null,
        ),
      ).toStrictEqual({ revision: 7, invalidatedAt: receipt?.observedAt });
      expect(served.runtime.memory.scopes.get(scopeId)).toBeUndefined();
    } finally {
      await waitOnExecutionContext(run.ctx);
    }
  });

  it.each([
    { kind: 'missing-dispatch', sent: 0 },
    { kind: 'failed', sent: 1 },
    { kind: 'split-failed', sent: 2 },
  ])('counts local source requests actually sent when $kind', async (example) => {
    const fetchSource = vi.fn(() => Promise.resolve(new Response(PNG)));
    const transform = vi.fn(transformed);
    const served = await serving(fetchSource, transform);
    const app = {
      ...served.pointer.app!,
      ...(example.kind === 'split-failed' && { functions: { 'app-2': 'site-app-2' } }),
    };
    const dispatch = vi.fn((script: string) => {
      return example.kind === 'split-failed' && script === app.scriptName
        ? Promise.resolve(
            new Response(null, {
              status: MISDIRECTED_STATUS,
              headers: { [FUNCTION_HEADER]: 'app-2' },
            }),
          )
        : Promise.reject(new Error('the dispatched source failed'));
    });
    const metric = vi.spyOn(served.host.observer, 'metric');
    const run = begin(
      {
        ...served,
        pointer: { ...served.pointer, app },
        runtime: {
          ...served.runtime,
          dispatchApp: example.kind === 'missing-dispatch' ? undefined : dispatch,
        },
      },
      `/draw/${crypto.randomUUID()}.png`,
      new AbortController().signal,
    );

    await expect(run.response).resolves.toHaveProperty('status', 400);
    expect(metric.mock.calls.at(-1)?.[0].subrequests).toBe(example.sent);
    expect(dispatch).toHaveBeenCalledTimes(example.sent);
    expect(fetchSource).not.toHaveBeenCalled();
    expect(transform).not.toHaveBeenCalled();

    await waitOnExecutionContext(run.ctx);
  });

  it.each(['local', 'remote', 'blob'])(
    'refuses a %s source abandoned during the preceding cache lookup',
    async (kind) => {
      const entered = Promise.withResolvers<undefined>();
      const lookup = Promise.withResolvers<undefined>();
      const fetchSource = vi.fn(() => Promise.resolve(new Response(PNG)));
      const transform = vi.fn(transformed);
      const path = `/shipped/${crypto.randomUUID()}.png`;
      const served = await serving(
        fetchSource,
        transform,
        kind === 'blob' ? { [path]: 'unread' } : undefined,
      );
      const storage = vi.spyOn(served.site.ARTIFACTS, 'get');
      const metric = vi.spyOn(served.host.observer, 'metric');
      const cache = await caches.open(standaloneHost(served.site).names.imageCache);
      vi.spyOn(cache, 'match').mockImplementation(() => {
        entered.resolve(undefined);
        return lookup.promise;
      });
      vi.spyOn(caches, 'open').mockResolvedValue(cache);
      const client = new AbortController();
      const local = kind === 'blob' ? path : `/draw/${crypto.randomUUID()}.png`;
      const source = kind === 'remote' ? remote() : local;
      const run = begin(served, source, client.signal);
      await entered.promise;

      client.abort(new Error('client left during lookup'));
      lookup.resolve(undefined);

      await expect(run.response).resolves.toHaveProperty('status', 502);
      await expect((await run.response).text()).resolves.toBe('image request abandoned');
      expect(fetchSource).not.toHaveBeenCalled();
      expect(transform).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      expect(metric.mock.calls.at(-1)?.[0].subrequests).toBe(0);

      await waitOnExecutionContext(run.ctx);
    },
  );

  it.each(['bucket', 'blob-fallback'])(
    'abandons a shipped source while its %s storage lookup waits and releases the late body',
    async (kind) => {
      const path = `/shipped/${crypto.randomUUID()}.png`;
      const transform = vi.fn(transformed);
      const served = await serving(() => never<Response>(), transform, { [path]: 'unread' });
      const object = await storedFile(served, path);
      const cancel = vi.spyOn(object.body, 'cancel');
      const entered = Promise.withResolvers<undefined>();
      const late = Promise.withResolvers<typeof object>();
      const get = vi.spyOn(served.site.ARTIFACTS, 'get').mockImplementation(() => {
        entered.resolve(undefined);
        return late.promise;
      });
      const blob = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })));
      const metric = vi.spyOn(served.host.observer, 'metric');
      const client = new AbortController();
      vi.useFakeTimers();
      const run = begin(
        {
          ...served,
          runtime: { ...served.runtime, blobWorker: kind === 'bucket' ? undefined : blob },
        },
        path,
        client.signal,
      );
      let answered = false;
      void run.response
        .then(() => {
          answered = true;
          return null;
        })
        .catch(() => null);
      await entered.promise;
      client.abort(new Error('client left during storage'));
      await vi.advanceTimersByTimeAsync(0);
      const beforeStorageAnswered = answered;

      late.resolve(object);
      await vi.advanceTimersByTimeAsync(0);

      expect(beforeStorageAnswered).toBe(true);
      expect((await run.response).status).toBe(502);
      expect(cancel).toHaveBeenCalledWith('image source abandoned');
      expect(get).toHaveBeenCalledTimes(1);
      expect(blob).toHaveBeenCalledTimes(kind === 'bucket' ? 0 : 1);
      expect(metric.mock.calls.at(-1)?.[0].subrequests).toBe(kind === 'bucket' ? 1 : 2);
      expect(transform).not.toHaveBeenCalled();

      await waitOnExecutionContext(run.ctx);
    },
  );

  it('starts no bucket fallback after a shipped source was abandoned during its blob lookup', async () => {
    const path = `/shipped/${crypto.randomUUID()}.png`;
    const transform = vi.fn(transformed);
    const served = await serving(() => never<Response>(), transform, { [path]: 'unread' });
    const file = shippedFile(served, path);
    const late = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<AbortSignal | undefined>();
    const blob = vi.fn((_path: string, init: RequestInit) => {
      entered.resolve(init.signal ?? undefined);
      return late.promise;
    });
    const get = vi.spyOn(served.site.ARTIFACTS, 'get').mockResolvedValue(null);
    const metric = vi.spyOn(served.host.observer, 'metric');
    const cancel = vi.fn();
    const client = new AbortController();
    vi.useFakeTimers();
    const run = begin(
      { ...served, runtime: { ...served.runtime, blobWorker: blob } },
      path,
      client.signal,
    );
    const upstream = await entered.promise;
    client.abort(new Error('client left during blob lookup'));
    await vi.advanceTimersByTimeAsync(2100);
    late.resolve(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { etag: `"${file.sha256}"` },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(upstream?.aborted).toBe(true);
    expect((await run.response).status).toBe(502);
    expect(get).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith('image source abandoned');
    expect(metric.mock.calls.at(-1)?.[0].subrequests).toBe(1);
    expect(transform).not.toHaveBeenCalled();

    await waitOnExecutionContext(run.ctx);
  });

  it('bounds a shipped source storage lookup by the source deadline and releases its late body', async () => {
    const path = `/shipped/${crypto.randomUUID()}.png`;
    const served = await serving(() => never<Response>(), transformed, { [path]: 'unread' });
    const object = await storedFile(served, path);
    const cancel = vi.spyOn(object.body, 'cancel');
    const entered = Promise.withResolvers<undefined>();
    const late = Promise.withResolvers<typeof object>();
    vi.spyOn(served.site.ARTIFACTS, 'get').mockImplementation(() => {
      entered.resolve(undefined);
      return late.promise;
    });
    const client = new AbortController();
    vi.useFakeTimers();
    const run = begin(served, path, client.signal);
    let answered = false;
    void run.response
      .then(() => {
        answered = true;
        return null;
      })
      .catch(() => null);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(2001);

    expect(answered).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    const beforeStorageAnswered = answered;
    late.resolve(object);
    await vi.advanceTimersByTimeAsync(0);

    expect(beforeStorageAnswered).toBe(true);
    expect((await run.response).status).toBe(504);
    expect(cancel).toHaveBeenCalledWith('image source abandoned');

    await waitOnExecutionContext(run.ctx);
  });

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
