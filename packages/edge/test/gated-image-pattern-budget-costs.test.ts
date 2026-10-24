import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { MIDDLEWARE_ONLY_HEADER } from '@stayingupwind/core/paas';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { blobObjectKey } from '@stayingupwind/host/storage';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
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
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const GATED_ROUTE = '/posts/[slug]';
const QUADRATIC = String.raw`^/(?<slug>\w+\w+)!$`;
const REWRITTEN = `/${'a'.repeat(4096)}`;

/** The same PNG prefix accepted by the existing image-source routing and warning fixtures. */
const PNG = concatBytes([
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  encodeUtf8('the first source was read before transformation failed'),
]);

const CASES = [
  {
    name: 'counts both source middleware dispatches before a routing pattern failure',
    kind: 'retry',
    middlewareDispatches: 1,
    appMiddlewareHeaders: ['1'],
    bucketReads: 0,
    transformBodies: [],
    subrequests: 2,
  },
  {
    name: 'counts the first source and failed transform before fallback routing fails',
    kind: 'fallback',
    middlewareDispatches: 2,
    appMiddlewareHeaders: [],
    bucketReads: 1,
    transformBodies: [PNG],
    subrequests: 4,
  },
] as const;

type Example = (typeof CASES)[number];

/** This rewrite reaches the same native budget failure as the corrected one-dispatch fixture. */
function rewritten(): Response {
  return new Response(null, {
    headers: { 'x-middleware-rewrite': `https://site.example${REWRITTEN}` },
  });
}

/** A retry uses the application's middleware-only response; fallback first lets storage answer. */
function sourceDispatches(kind: Example['kind']) {
  let attempts = 0;
  const middleware = vi.fn(() => {
    attempts += 1;
    if (kind === 'retry') return Promise.reject(new Error('source middleware failed'));
    return Promise.resolve(
      attempts === 1 ? new Response(null, { headers: { 'x-middleware-next': '1' } }) : rewritten(),
    );
  });
  const app = vi.fn<(request: Request) => Promise<Response>>(() => Promise.resolve(rewritten()));
  return { middleware, app };
}

/** A real hosted image request, retaining the corrected valid gate declaration and source path. */
async function refusedAfterCosts(example: Example) {
  const source = `/gated/${crypto.randomUUID()}.png`;
  const site = await seedSite({
    document: pprDocument(),
    pathname: GATED_ROUTE,
    dynamicRoutes: [
      {
        sourceRegex: '^/posts/(?<slug>[^/]+?)(?:/)?$',
        route: GATED_ROUTE,
        gated: GATED_ROUTE,
      },
    ],
    images: CONFIG,
    files: { [source]: 'replaced below by actual PNG bytes' },
    gates: { [GATED_ROUTE]: 'checker' },
    gatedPathnames: { [GATED_ROUTE]: GATED_ROUTE },
  });
  const sha256 = await sha256Hex(PNG);
  await env.ARTIFACTS.put(blobObjectKey(sha256), PNG);
  const manifest: ProjectManifest = {
    ...site.manifest,
    middleware: { matchers: [{ sourceRegex: '^/gated/' }] },
    reservedRoutes: [{ sourceRegex: QUADRATIC, beforeFiles: true }],
    staticFiles: {
      ...site.manifest.staticFiles,
      [source]: { sha256, byteLength: PNG.byteLength, contentType: 'image/png', immutable: false },
    },
  };
  const points: EdgeMetric[] = [];
  const { middleware, app } = sourceDispatches(example.kind);
  const gate = vi.fn(() => Promise.resolve(new Response('unexpected gate dispatch')));
  const fetchImpl = vi.fn(() => Promise.resolve(new Response('unexpected external fetch')));
  const transformBodies: Uint8Array[] = [];
  const transformImage = vi.fn(async (body: ReadableStream<Uint8Array>) => {
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    transformBodies.push(bytes);
    throw new Error('transform failed after consuming the first source');
  });
  const runtime = {
    ...standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (script, request) =>
        script === 'site-middleware' ? middleware() : app(request),
      fetchImpl,
      transformImage,
    }),
    // The first successful source has one actual bucket read and no blob-worker attempt.
    blobWorker: undefined,
  };
  const originalHost = standaloneHost(env);
  const host = {
    ...originalHost,
    gates: { answer: gate },
    observer: {
      ...originalHost.observer,
      metric(point: EdgeMetric): void {
        points.push(point);
      },
    },
  };
  const query = new URLSearchParams({ url: source, w: '64', q: '75' });
  const request: IncomingRequest = new Request(
    `https://site.example${CONFIG.path}?${query.toString()}`,
    {
      headers: { accept: 'image/webp', 'sec-fetch-dest': 'image' },
    },
  );
  const bucketGet = vi.spyOn(env.ARTIFACTS, 'get');
  const ctx = createExecutionContext();
  const response = await serveFromPointer(
    {
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host,
      pointer: {
        ...site.pointer,
        app: {
          ...site.pointer.app,
          deploymentId: 'dpl_site',
          scriptName: 'site-app',
          middlewareScriptName: 'site-middleware',
        },
      },
      pointerMs: 7,
      privateDelivery: false,
      cspReportingPath: undefined,
    },
    {
      manifestLookup: Promise.resolve({ kind: 'found', value: manifest }),
      policyLookup: Promise.resolve({
        kind: 'found',
        source: 'exact',
        policy: DEFAULT_DELIVERY_POLICY,
      }),
    },
  );
  await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return {
    response,
    points,
    middleware,
    app,
    gate,
    fetchImpl,
    transformImage,
    transformBodies,
    bucketGet,
    projectId: site.pointer.projectId,
    manifestId: site.manifestId,
    policyId: site.pointer.policyId,
  };
}

/** Terminal counts retain only work that the same refused request actually performed. */
describe('gated image pattern refusals after retry or transform costs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(CASES)('$name', async (example) => {
    const result = await refusedAfterCosts(example);

    expect({
      status: result.response.status,
      debug: result.response.headers.get(EDGE_DEBUG_HEADER),
    }).toStrictEqual({ status: 503, debug: 'error;reason=gate-pattern-budget' });
    expect(result.middleware).toHaveBeenCalledTimes(example.middlewareDispatches);
    expect(
      result.app.mock.calls.map(([request]) => request.headers.get(MIDDLEWARE_ONLY_HEADER)),
    ).toStrictEqual(example.appMiddlewareHeaders);
    expect(result.bucketGet).toHaveBeenCalledTimes(example.bucketReads);
    expect({
      calls: result.transformImage.mock.calls.length,
      bodies: result.transformBodies,
    }).toStrictEqual({ calls: example.transformBodies.length, bodies: example.transformBodies });
    expect([result.gate.mock.calls.length, result.fetchImpl.mock.calls.length]).toStrictEqual([
      0, 0,
    ]);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({
      projectId: result.projectId,
      manifestId: result.manifestId,
      policyId: result.policyId,
      pathname: CONFIG.path,
      kind: 'passthrough',
      outcomeKind: 'gate-503',
      subrequests: example.subrequests,
      pointerLookupMs: 7,
    });
  });
});
