import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest, StaticFileEntry } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DispatchApp, TransformImage } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { manifestStateFromPointer } from '../src/preview/state.ts';
import { routeRequest, serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  contentSecurityPolicy: "script-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const ORIGIN = 'https://site.example';
const GATED = 'private, max-age=0, must-revalidate';
const CONTINUE = { 'x-middleware-next': '1' };

/** A PNG's signature and then `text`, which the test transformer hands back as its result. */
function png(text: string): Uint8Array {
  return concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeUtf8(text),
  ]);
}

async function shipped(bytes: Uint8Array): Promise<StaticFileEntry> {
  const sha256 = await sha256Hex(bytes);
  await env.ARTIFACTS.put(blobObjectKey(sha256), bytes);
  return { sha256, byteLength: bytes.byteLength, contentType: 'image/png', immutable: true };
}

function imageUrl(source: string): string {
  return `${ORIGIN}/_next/image?${new URLSearchParams({ url: source, w: '64', q: '75' }).toString()}`;
}

interface Asked {
  readonly headers?: Readonly<Record<string, string>>;
  /** Asked as a deployment's validation is, which runs no middleware. */
  readonly validated?: boolean;
}

/**
 * A site whose middleware covers the optimizer's path — and none of the files it optimizes — with
 * two images it ships under names of their own: what the middleware answers is the test's to say,
 * letting every request on until it says otherwise.
 */
async function serving() {
  const site = await seedSite({ document: pprDocument(), images: CONFIG });
  const first = `/_next/static/media/${crypto.randomUUID()}.png`;
  const second = `/_next/static/media/${crypto.randomUUID()}.png`;
  const bytes = { first: png(first), second: png(second) };
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/_next/image$' }] },
    staticFiles: { [first]: await shipped(bytes.first), [second]: await shipped(bytes.second) },
  };
  const middleware = vi.fn<DispatchApp>(() =>
    Promise.resolve(new Response(null, { headers: CONTINUE })),
  );
  // The source as its own result, so that what was optimized is told by its bytes.
  const transform = vi.fn<TransformImage>(async (source, options) => {
    const body = new Uint8Array(await new Response(source).arrayBuffer());
    return {
      contentType: options.format,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    };
  });
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: middleware,
    transformImage: transform,
  });
  const host = standaloneHost(env);
  const pointer: EdgePointer = {
    ...site.pointer,
    app: {
      deploymentId: 'dpl_site',
      scriptName: 'site-app',
      middlewareScriptName: 'site-middleware',
    },
  };
  const get = async (source: string, asked: Asked = {}) => {
    const request = new Request<unknown, IncomingRequestCfProperties>(imageUrl(source), {
      headers: { accept: 'image/webp', 'sec-fetch-dest': 'image', ...asked.headers },
    });
    const ctx = createExecutionContext();
    const shared = { request, url: new URL(request.url), env, ctx, runtime, host };
    const response = await (asked.validated === true
      ? routeRequest({
          ...shared,
          state: {
            ...manifestStateFromPointer({
              runtime,
              pointer,
              stored: { kind: 'found', value: manifest },
              pathname: shared.url.pathname,
              privateDelivery: false,
              cspReportingPath: undefined,
            }),
            policy: DEFAULT_DELIVERY_POLICY,
            cacheApi: false,
            validated: true,
            passthroughReason: 'validation',
            demotedRoutes: undefined,
          },
          timings: { pointerMs: undefined, manifestMs: 0, middlewareMs: undefined },
        })
      : serveFromPointer(
          { ...shared, pointer, pointerMs: 0, privateDelivery: false, cspReportingPath: undefined },
          {
            manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
            policyLookup: Promise.resolve({
              kind: 'found',
              source: 'exact',
              policy: DEFAULT_DELIVERY_POLICY,
            }),
          },
        ));
    const body = new Uint8Array(await response.arrayBuffer());
    await waitOnExecutionContext(ctx);
    return { response, body };
  };
  return { get, first, second, bytes, middleware, transform };
}

describe('an optimized image under a middleware that lets it on', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is kept, and answers the next request with what the middleware says to that one', async () => {
    const served = await serving();
    served.middleware
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { ...CONTINUE, 'set-cookie': 'visit=1; Path=/', 'x-visit': '1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          headers: { ...CONTINUE, 'set-cookie': 'visit=2; Path=/', 'x-visit': '2' },
        }),
      )
      // A rewrite onto the request's own URL changes nothing of it but the status it is given.
      .mockResolvedValueOnce(
        new Response(null, {
          status: 201,
          headers: { 'x-middleware-rewrite': imageUrl(served.first) },
        }),
      );
    const missed = await served.get(served.first);
    const read = vi.spyOn(env.ARTIFACTS, 'get');
    const hit = await served.get(served.first);
    const rewritten = await served.get(served.first);
    const revalidated = await served.get(served.first, {
      headers: { 'if-none-match': missed.response.headers.get('etag') ?? '' },
    });

    expect(missed.body).toStrictEqual(served.bytes.first);
    expect({
      cache: missed.response.headers.get('x-nextjs-cache'),
      edge: missed.response.headers.get(EDGE_DEBUG_HEADER),
    }).toStrictEqual({
      cache: 'MISS',
      edge: expect.stringMatching(/^image;src=images;.*;mw=hit$/u) as unknown,
    });
    expect(hit.body).toStrictEqual(served.bytes.first);
    expect({
      status: hit.response.status,
      cache: hit.response.headers.get('x-nextjs-cache'),
      edge: hit.response.headers.get(EDGE_DEBUG_HEADER),
      privacy: hit.response.headers.get('cache-control'),
      etag: hit.response.headers.get('etag'),
      cookies: hit.response.headers.getSetCookie(),
      visit: hit.response.headers.get('x-visit'),
    }).toStrictEqual({
      status: 200,
      cache: 'HIT',
      edge: expect.stringMatching(/^image;src=cache;.*;mw=hit$/u) as unknown,
      privacy: GATED,
      etag: missed.response.headers.get('etag'),
      cookies: ['visit=2; Path=/'],
      visit: '2',
    });
    expect({
      status: rewritten.response.status,
      cache: rewritten.response.headers.get('x-nextjs-cache'),
      cookies: rewritten.response.headers.getSetCookie(),
      visit: rewritten.response.headers.get('x-visit'),
      privacy: rewritten.response.headers.get('cache-control'),
    }).toStrictEqual({ status: 201, cache: 'HIT', cookies: [], visit: null, privacy: GATED });
    expect(rewritten.body).toStrictEqual(served.bytes.first);
    // A browser that holds the image is answered 304 from the entry, with nothing read again.
    expect({
      status: revalidated.response.status,
      privacy: revalidated.response.headers.get('cache-control'),
    }).toStrictEqual({ status: 304, privacy: GATED });
    // One source read and one transformation for all four, each run past the middleware.
    expect({
      transformed: served.transform.mock.calls.length,
      readAgain: read.mock.calls.length,
      middleware: served.middleware.mock.calls.length,
    }).toStrictEqual({ transformed: 1, readAgain: 0, middleware: 4 });
  });

  it('is kept under the parameters a middleware rewrote the request to, not those it asked', async () => {
    const served = await serving();
    let rewriting = true;
    served.middleware.mockImplementation((_script, request) => {
      const asked = new URL(request.url).searchParams.get('url');
      const rewrite = rewriting && asked === served.first;
      return Promise.resolve(
        new Response(null, {
          headers: rewrite ? { 'x-middleware-rewrite': imageUrl(served.second) } : CONTINUE,
        }),
      );
    });

    const rewritten = await served.get(served.first);
    const target = await served.get(served.second);
    rewriting = false;
    const asked = await served.get(served.first);

    expect([rewritten.body, target.body, asked.body]).toStrictEqual([
      served.bytes.second,
      served.bytes.second,
      served.bytes.first,
    ]);
    expect(
      [rewritten, target, asked].map(({ response }) => response.headers.get('x-nextjs-cache')),
    ).toStrictEqual(['MISS', 'HIT', 'MISS']);
    expect(served.transform).toHaveBeenCalledTimes(2);
  });

  it('is neither read nor kept by a validation, whose request no middleware is run for', async () => {
    const served = await serving();

    const validation = await served.get(served.first, { validated: true });
    const live = await served.get(served.first);
    const again = await served.get(served.first, { validated: true });
    const hit = await served.get(served.first);

    expect(
      [validation, live, again, hit].map(({ response }) => response.headers.get('x-nextjs-cache')),
    ).toStrictEqual(['MISS', 'MISS', 'MISS', 'HIT']);
    expect(again.response.headers.get('cache-control')).toBe('private, no-store');
    expect(hit.body).toStrictEqual(served.bytes.first);
    expect(served.transform).toHaveBeenCalledTimes(3);
    expect(served.middleware).toHaveBeenCalledTimes(2);
  });
});
