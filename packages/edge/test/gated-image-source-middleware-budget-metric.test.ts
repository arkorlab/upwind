import type { ImagesConfig } from '@stayingupwind/core/images';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

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

/** A source's own middleware has run before its rewritten route exhausts the pattern budget. */
describe('a gated image pattern refusal after source middleware', () => {
  it('counts the source middleware dispatch in its sole terminal point', async () => {
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
      files: { [source]: 'the source must remain unread' },
      gates: { [GATED_ROUTE]: 'checker' },
      gatedPathnames: { [GATED_ROUTE]: GATED_ROUTE },
    });
    const manifest: ProjectManifest = {
      ...site.manifest,
      middleware: { matchers: [{ sourceRegex: '^/gated/' }] },
      reservedRoutes: [{ sourceRegex: QUADRATIC, beforeFiles: true }],
    };
    const points: EdgeMetric[] = [];
    const middleware = vi.fn(() => {
      return Promise.resolve(
        new Response(null, {
          headers: { 'x-middleware-rewrite': `https://site.example${REWRITTEN}` },
        }),
      );
    });
    const app = vi.fn(() => Promise.resolve(new Response('unexpected application dispatch')));
    const gate = vi.fn(() => Promise.resolve(new Response('unexpected gate dispatch')));
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('unexpected external fetch')));
    const transformImage = vi.fn(() => {
      return Promise.resolve({
        contentType: 'image/webp',
        body: new Blob(['unexpected']).stream(),
      });
    });
    const runtime = standaloneRuntime(env, {
      memory: createEdgeMemory(() => Date.now()),
      dispatchApp: (script) => (script === 'site-middleware' ? middleware() : app()),
      fetchImpl,
      transformImage,
    });
    const original = standaloneHost(env);
    const host = {
      ...original,
      gates: { answer: gate },
      observer: {
        ...original.observer,
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

    expect({
      status: response.status,
      debug: response.headers.get(EDGE_DEBUG_HEADER),
    }).toStrictEqual({
      status: 503,
      debug: 'error;reason=gate-pattern-budget',
    });
    expect(middleware).toHaveBeenCalledTimes(1);
    expect(app).not.toHaveBeenCalled();
    expect(gate).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(transformImage).not.toHaveBeenCalled();
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({
      projectId: site.pointer.projectId,
      manifestId: site.manifestId,
      policyId: site.pointer.policyId,
      pathname: CONFIG.path,
      kind: 'passthrough',
      outcomeKind: 'gate-503',
      subrequests: 1,
      pointerLookupMs: 7,
    });
  });
});
