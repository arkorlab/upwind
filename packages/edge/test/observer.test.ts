import type { ImagesConfig } from '@stayingupwind/core/images';
import {
  FUNCTION_HEADER,
  MIDDLEWARE_ONLY_HEADER,
  MISDIRECTED_STATUS,
} from '@stayingupwind/core/paas';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeHost } from '../src/edge-host.ts';
import type { EdgeRuntime } from '../src/edge-runtime.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, type StandaloneEnv, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

/**
 * The host's observer (`EdgeHost.observer`) is the host's own code. One that throws is the host's
 * to mend, and changes no answer: none fails, and none is answered otherwise for it.
 */

const SITE = 'site.example';
const IMAGES: ImagesConfig = {
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
    { protocol: 'https', hostname: String.raw`^(?:^(?:cdn\.site\.example)$)$`, pathname: '^.*$' },
  ],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const OPTIMIZED = encodeUtf8('optimized');

function thrower(what: string): () => never {
  return () => {
    throw new Error(`the observer gave out on ${what}`);
  };
}

/** What an observer that keeps to its part does with what it is told: nothing, here. */
function quiet(): void {
  // Told, and nothing done with it.
}

/** A host whose observer throws on whatever `throwing` names, and is quiet otherwise. */
function hostThrowingOn(site: StandaloneEnv, throwing: readonly string[]): EdgeHost {
  const pick = (name: string): (() => void) => (throwing.includes(name) ? thrower(name) : quiet);
  return {
    ...standaloneHost(site),
    observer: {
      metric: pick('metric'),
      recordServed: pick('recordServed'),
      imageTransformed: pick('imageTransformed'),
    },
  };
}

/** A PNG by its signature, different every time so no test finds another's cache entry. */
function pngBytes(): Uint8Array {
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return concatBytes([signature, encodeUtf8(crypto.randomUUID())]);
}

/** The site's Function, its image sources on the internet, and an image service that answers. */
function runtimeOf(site: StandaloneEnv, png: Uint8Array): EdgeRuntime {
  return standaloneRuntime(site, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_scriptName, request) => {
      const { pathname } = new URL(request.url);
      if (pathname === '/') {
        return Promise.resolve(htmlResponse(pprDocument().suffix));
      }
      return Promise.resolve(
        new Response(`asked ${pathname}`, { headers: { 'cache-control': 'no-store' } }),
      );
    },
    fetchImpl: () =>
      Promise.resolve(new Response(png, { headers: { 'content-type': 'image/png' } })),
    transformImage: async (source) => {
      await new Response(source).arrayBuffer();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(OPTIMIZED);
          controller.close();
        },
      });
      return { contentType: 'image/webp', body };
    },
  });
}

/** A site as the edge serves it: its bindings, the pointer it is served by, and its host. */
interface Served {
  readonly site: StandaloneEnv;
  readonly pointer: EdgePointer;
  readonly host: EdgeHost;
  readonly runtime: EdgeRuntime;
  readonly lookups?: Parameters<typeof serveFromPointer>[1];
}

async function serve(
  served: Served,
  request: IncomingRequest,
): Promise<{ readonly response: Response; readonly bytes: Uint8Array }> {
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
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
    served.lookups,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  await waitOnExecutionContext(ctx);
  return { response, bytes };
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function imageOf(source: string): IncomingRequest {
  const query = `url=${encodeURIComponent(source)}&w=64&q=75`;
  return new Request(`https://${SITE}/_next/image?${query}`, {
    headers: { accept: 'image/webp,image/*,*/*;q=0.8', 'sec-fetch-dest': 'image' },
  });
}

function clientSignal(left: boolean): AbortSignal {
  const controller = new AbortController();
  if (left) controller.abort();
  return controller.signal;
}

interface HostedFallback {
  readonly target: 'file' | 'image';
  readonly mode: 'retry-failed' | 'retry-rewritten' | 'rewritten' | 'skipped' | 'unreachable';
}

/** The same dispatcher handles a middleware-only retry and the final application request. */
function hostedRuntime(example: HostedFallback, calls: boolean[]): EdgeRuntime {
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp:
      example.mode === 'unreachable'
        ? undefined
        : (script, request) => {
            const middlewareOnly = request.headers.get(MIDDLEWARE_ONLY_HEADER) === '1';
            calls.push(middlewareOnly);
            if (!middlewareOnly) return Promise.resolve(new Response('the application answered'));
            if (example.mode === 'retry-failed') {
              return Promise.reject(new Error('middleware failed'));
            }
            if (script === 'site-middleware' && example.mode === 'retry-rewritten') {
              return Promise.reject(new Error('the first middleware failed'));
            }
            const headers = { 'x-middleware-rewrite': `https://${SITE}/application-only` };
            return Promise.resolve(new Response(null, { headers }));
          },
  });
  // The factory treats an undefined override as its default service dispatcher.
  return example.mode === 'unreachable' ? { ...runtime, dispatchApp: undefined } : runtime;
}

/** A real hosted gate routes a file/image through its middleware, then the Function fallback. */
async function hostedFallback(example: HostedFallback) {
  const site = await seedSite({
    document: pprDocument(),
    files: { '/robots.txt': 'User-agent: *' },
    images: IMAGES,
  });
  const points: EdgeMetric[] = [];
  const calls: boolean[] = [];
  const originalHost = standaloneHost(env);
  const request =
    example.target === 'file' ? navigation('/robots.txt') : imageOf(`https://cdn.${SITE}/file.png`);
  const { response } = await serve(
    {
      site: env,
      runtime: hostedRuntime(example, calls),
      host: {
        ...originalHost,
        observer: {
          ...originalHost.observer,
          metric: (point) => {
            points.push(point);
          },
        },
      },
      pointer: {
        ...site.pointer,
        app: {
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          middlewareScriptName: 'site-middleware',
        },
      },
      lookups: {
        policyLookup: Promise.resolve({
          kind: 'found',
          policy: DEFAULT_DELIVERY_POLICY,
          source: 'exact',
        }),
        manifestLookup: Promise.resolve({
          kind: 'found',
          value: {
            ...site.manifest,
            middleware: {
              matchers: [{ sourceRegex: example.mode === 'skipped' ? '^/elsewhere$' : '^/.*$' }],
            },
          },
        }),
      },
    },
    request,
  );
  return { status: response.status, points, calls };
}

describe('hosted middleware fallback accounting', () => {
  it.each([
    { target: 'file', mode: 'retry-failed', calls: [true, true, false], subrequests: 3 },
    { target: 'image', mode: 'retry-failed', calls: [true, true, false], subrequests: 3 },
    { target: 'file', mode: 'retry-rewritten', calls: [true, true, false], subrequests: 3 },
    { target: 'image', mode: 'retry-rewritten', calls: [true, true, false], subrequests: 3 },
    { target: 'file', mode: 'rewritten', calls: [true, false], subrequests: 2 },
    { target: 'file', mode: 'skipped', calls: [], subrequests: 1 },
    { target: 'file', mode: 'unreachable', calls: [], subrequests: 0 },
  ] as const)('counts $target / $mode before the final answer', async (example) => {
    const result = await hostedFallback(example);

    expect(result.calls).toStrictEqual(example.calls);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.subrequests).toBe(example.subrequests);
    expect(result.status).toBe(example.mode === 'unreachable' ? 502 : 200);
  });
});

describe('continuation dispatch accounting', () => {
  it.each([
    { kind: 'unsent', sent: 0, fn: undefined, outcome: 'upstream-error' },
    { kind: 'client-left', sent: 0, fn: undefined, outcome: 'client-cancelled' },
    { kind: 'answered', sent: 1, fn: 'app', outcome: 'ok' },
    { kind: 'failed', sent: 1, fn: 'app', outcome: 'upstream-error' },
    { kind: 'redispatched', sent: 2, fn: 'app-2', outcome: 'ok' },
    { kind: 'redispatch-failed', sent: 2, fn: 'app-2', outcome: 'upstream-error' },
  ])('records only sent requests when $kind', async (example) => {
    const document = pprDocument();
    const { pointer } = await seedSite({ document });
    const points: EdgeMetric[] = [];
    const calls: string[] = [];
    const host = standaloneHost(env);
    const runtime = standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) });
    const served: Served = {
      site: env,
      pointer: {
        ...pointer,
        app: {
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          functions: { 'app-2': 'site-app-2' },
        },
      },
      host: {
        ...host,
        observer: {
          ...host.observer,
          metric: (point) => {
            points.push(point);
          },
        },
      },
      runtime: {
        ...runtime,
        dispatchApp:
          example.sent === 0
            ? undefined
            : (script) => {
                calls.push(script);
                if (script === 'site-app' && example.sent === 2) {
                  return Promise.resolve(
                    new Response(null, {
                      status: MISDIRECTED_STATUS,
                      headers: { [FUNCTION_HEADER]: 'app-2' },
                    }),
                  );
                }
                return example.kind.endsWith('failed')
                  ? Promise.reject(new Error('the continuation failed'))
                  : Promise.resolve(htmlResponse(document.suffix));
              },
      },
    };

    await serve(served, navigation('/', { signal: clientSignal(example.kind === 'client-left') }));

    expect(calls).toHaveLength(example.sent);
    expect(points).toHaveLength(1);
    expect({
      kind: points[0]?.kind,
      outcome: points[0]?.outcomeKind,
      subrequests: points[0]?.subrequests,
      fn: points[0]?.fn,
      redispatch: points[0]?.redispatch,
    }).toStrictEqual({
      kind: 'document',
      outcome: example.outcome,
      subrequests: 1 + example.sent,
      fn: example.fn,
      redispatch: example.sent === 2 ? 1 : 0,
    });
  });
});

describe('middleware calls in request totals', () => {
  it.each([
    { kind: 'resume', middleware: true, app: 1, storage: 1, document: true },
    { kind: 'head', middleware: true, app: 1, storage: 0, document: false },
    { kind: 'complete', middleware: true, app: 0, storage: 1, document: true },
    { kind: 'redispatched', middleware: true, app: 2, storage: 1, document: true },
    { kind: 'resume-failed', middleware: true, app: 1, storage: 1, document: true },
    { kind: 'rewritten', middleware: true, app: 1, storage: 0, document: false },
    { kind: 'rewrite-redispatched', middleware: true, app: 2, storage: 0, document: false },
    { kind: 'middleware-failed', middleware: true, app: 1, storage: 0, document: false },
    { kind: 'unreachable', middleware: false, app: 0, storage: 0, document: false },
  ])('counts each actual Function call when $kind', async (example) => {
    const partial = pprDocument();
    const document =
      example.kind === 'complete'
        ? {
            ...partial,
            shell: concatBytes([partial.shell, partial.suffix]),
            shellText: partial.shellText + partial.suffixText,
          }
        : partial;
    const site = await seedSite({ document });
    const points: EdgeMetric[] = [];
    const calls: string[] = [];
    const originalHost = standaloneHost(env);
    const controller = new AbortController();
    const runtime: EdgeRuntime = {
      ...standaloneRuntime(env, { memory: createEdgeMemory(() => Date.now()) }),
      dispatchApp: example.middleware
        ? (script) => {
            calls.push(script);
            if (script === 'site-middleware') {
              if (example.kind === 'middleware-failed') {
                return Promise.reject(new Error('middleware failed'));
              }
              return Promise.resolve(
                new Response(null, {
                  headers: example.kind.startsWith('rewrit')
                    ? { 'x-middleware-rewrite': `https://${SITE}/uncached` }
                    : { 'x-middleware-next': '1' },
                }),
              );
            }
            if (script === 'site-app' && example.app === 2) {
              return Promise.resolve(
                new Response(null, {
                  status: MISDIRECTED_STATUS,
                  headers: { [FUNCTION_HEADER]: 'app-2' },
                }),
              );
            }
            return example.kind === 'resume-failed'
              ? Promise.reject(new Error('resume failed'))
              : Promise.resolve(htmlResponse(document.suffix));
          }
        : undefined,
    };
    const routes = Object.fromEntries(
      Object.entries(site.manifest.routes).map(([path, entry]) => {
        return [
          path,
          example.kind === 'complete'
            ? {
                ...entry,
                cache: {
                  entryId: 'complete-entry',
                  kind: 'app-page' as const,
                  delivery: 'complete' as const,
                },
              }
            : entry,
        ];
      }),
    );
    const request = navigation('/', {
      method: example.kind === 'head' ? 'HEAD' : 'GET',
      signal: controller.signal,
    });
    const ctx = createExecutionContext();
    const response = await serveFromPointer(
      {
        request,
        url: new URL(request.url),
        env,
        ctx,
        runtime,
        host: {
          ...originalHost,
          observer: {
            ...originalHost.observer,
            metric: (point) => {
              points.push(point);
            },
          },
        },
        pointer: {
          ...site.pointer,
          app: {
            deploymentId: 'dpl_site',
            scriptName: 'site-app',
            middlewareScriptName: 'site-middleware',
            functions: { 'app-2': 'site-app-2' },
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
            routes,
            middleware: { matchers: [{ sourceRegex: '^/.*$' }] },
          },
        }),
        policyLookup: Promise.resolve({
          kind: 'found',
          source: 'exact',
          policy: DEFAULT_DELIVERY_POLICY,
        }),
      },
    );
    await response.arrayBuffer();
    await waitOnExecutionContext(ctx);

    const sent = Number(example.middleware) + example.app;
    const fn = example.app === 2 ? 'app-2' : 'app';

    expect(calls).toHaveLength(sent);
    expect(points).toHaveLength(1);
    expect(points[0]?.kind).toBe(example.document ? 'document' : 'passthrough');
    expect(points[0]?.subrequests).toBe(sent + example.storage);
    expect(points[0]?.redispatch).toBe(example.app === 2 ? 1 : 0);
    expect(points[0]?.fn).toBe(example.app === 0 ? undefined : fn);
  });
});

describe('an observer that throws', () => {
  /** Told before an answer goes out, or as it does, it neither fails one (Codex, upwind#179). */
  it('changes no answer, of whatever kind', async () => {
    const document = pprDocument();
    const { pointer } = await seedSite({
      document,
      files: { '/robots.txt': 'User-agent: *' },
      images: IMAGES,
      segments: { '/_tree': '0:["tree"]\n' },
    });
    const site = { ...env };
    const served: Served = {
      site,
      pointer,
      host: hostThrowingOn(site, ['metric', 'recordServed', 'imageTransformed']),
      runtime: runtimeOf(site, pngBytes()),
    };

    const page = await serve(served, navigation('/'));
    const handedOn = await serve(served, navigation('/api/hello'));
    const file = await serve(served, navigation('/robots.txt'));
    const asset = await serve(served, navigation('/_next/static/chunks/a.js'));
    const segment = await serve(
      served,
      new Request(`https://${SITE}/`, {
        headers: {
          rsc: '1',
          'next-router-prefetch': '1',
          'next-router-segment-prefetch': '/_tree',
        },
      }),
    );
    const image = await serve(served, imageOf(`https://cdn.${SITE}/a.png`));

    expect(text(page.bytes)).toBe(document.shellText + document.suffixText);
    expect(text(handedOn.bytes)).toBe('asked /api/hello');
    expect(text(file.bytes)).toBe('User-agent: *');
    expect(text(asset.bytes)).toBe('asked /_next/static/chunks/a.js');
    expect(text(segment.bytes)).toBe('0:["tree"]\n');
    expect(image.response.headers.get('content-type')).toBe('image/webp');
    expect(image.bytes).toStrictEqual(OPTIMIZED);
  });

  /**
   * Told once the service has answered, and not taken for the service failing: the source is not
   * fetched again and served untransformed in the result's place (Codex, upwind#179).
   */
  it('on an image transformed is not taken for the transformation failing', async () => {
    const { pointer } = await seedSite({ document: pprDocument(), images: IMAGES });
    const site = { ...env };
    let fetched = 0;
    const runtime = runtimeOf(site, pngBytes());
    const served: Served = {
      site,
      pointer,
      host: hostThrowingOn(site, ['imageTransformed']),
      runtime: {
        ...runtime,
        fetchImpl: (request, init) => {
          fetched += 1;
          return runtime.fetchImpl(request, init);
        },
      },
    };

    const { response, bytes } = await serve(served, imageOf(`https://cdn.${SITE}/b.png`));

    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(bytes).toStrictEqual(OPTIMIZED);
    expect(fetched).toBe(1);
  });
});
