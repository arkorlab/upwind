import type { ImagesConfig } from '@stayingupwind/core/images';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

/** Every terminal pattern refusal is an answer the host counts, before any source is fetched. */
const POST = '/posts/[slug]';
const POST_PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const QUADRATIC = String.raw`^/(?<slug>\w+\w+)!$`;
const CRAFTED_SOURCE = `/${'a'.repeat(2048)}`;
const CRAFTED_DOCUMENT = `/${'a'.repeat(4096)}`;
const STATUS = { badRequest: 400, unavailable: 503 } as const;
const LOOKUP = { pointer: 7 } as const;
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
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

interface Case {
  readonly name: string;
  readonly gated: boolean;
  readonly pattern: 'route' | 'local' | 'none';
  readonly document?: boolean;
  readonly throwObserver?: boolean;
  readonly status: number;
  readonly debug: string;
  readonly kind: 'passthrough' | 'asset';
  readonly outcomeKind: string;
  readonly pointerLookupMs?: number;
}

const CASES: readonly Case[] = [
  {
    name: 'a gated image source route budget refusal records one terminal point',
    gated: true,
    pattern: 'route',
    status: STATUS.unavailable,
    debug: 'error;reason=gate-pattern-budget',
    kind: 'passthrough',
    outcomeKind: 'gate-503',
    pointerLookupMs: LOOKUP.pointer,
  },
  {
    name: 'a gated image local-pattern budget refusal records one terminal point',
    gated: true,
    pattern: 'local',
    status: STATUS.unavailable,
    debug: 'error;reason=gate-pattern-budget',
    kind: 'passthrough',
    outcomeKind: 'gate-503',
    pointerLookupMs: LOOKUP.pointer,
  },
  {
    name: 'an ungated image pattern refusal keeps its existing single image point',
    gated: false,
    pattern: 'local',
    status: STATUS.badRequest,
    debug: 'error;reason=pattern-budget',
    kind: 'asset',
    outcomeKind: 'image',
  },
  {
    name: 'a normal gated image-source refusal keeps its existing single image point',
    gated: true,
    pattern: 'none',
    status: STATUS.badRequest,
    debug: 'error;reason=image-source-gated',
    kind: 'asset',
    outcomeKind: 'image',
  },
  {
    name: 'a document gate pattern refusal keeps its existing single terminal point',
    gated: true,
    pattern: 'route',
    document: true,
    status: STATUS.unavailable,
    debug: 'error;reason=gate-pattern-budget',
    kind: 'passthrough',
    outcomeKind: 'gate-503',
    pointerLookupMs: LOOKUP.pointer,
  },
  {
    name: 'a throwing host observer cannot change the gated image refusal',
    gated: true,
    pattern: 'route',
    throwObserver: true,
    status: STATUS.unavailable,
    debug: 'error;reason=gate-pattern-budget',
    kind: 'passthrough',
    outcomeKind: 'gate-503',
    pointerLookupMs: LOOKUP.pointer,
  },
];

/** A valid source if a regression unexpectedly dispatches one; no external network is needed. */
function image(): Response {
  const bytes = concatBytes([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    encodeUtf8('png'),
  ]);
  return new Response(bytes, { headers: { 'content-type': 'image/png' } });
}

/** The actual pointer router, its telemetry sink, and every optional downstream call. */
async function routed(row: Case) {
  const site = await seedSite({
    document: pprDocument(),
    pathname: POST,
    images:
      row.pattern === 'local'
        ? { ...IMAGES, localPatterns: [{ pathname: QUADRATIC, search: '' }] }
        : IMAGES,
    dynamicRoutes: [
      {
        sourceRegex: row.pattern === 'route' ? QUADRATIC : POST_PATTERN,
        route: POST,
        ...(row.gated && { gated: POST }),
      },
    ],
    ...(row.gated && { gates: { [POST]: 'checker' }, gatedPathnames: { [POST]: POST } }),
  });
  const points: EdgeMetric[] = [];
  const gate = vi.fn(() =>
    Promise.resolve(new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } })),
  );

  const dispatchApp = vi.fn(() => Promise.resolve(image()));
  const fetchImpl = vi.fn(() => Promise.resolve(image()));
  const transformImage = vi.fn(() =>
    Promise.resolve({ contentType: 'image/webp', body: new Blob(['transformed']).stream() }),
  );

  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp,
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
        if (row.throwObserver === true) throw new Error('the fixture observer threw');
      },
    },
  };
  const query = new URLSearchParams({
    url: row.pattern === 'none' ? '/posts/abc' : CRAFTED_SOURCE,
    w: '64',
    q: '75',
  });
  const request: IncomingRequest =
    row.document === true
      ? navigation(CRAFTED_DOCUMENT)
      : new Request(`https://site.example${IMAGES.path}?${query.toString()}`, {
          headers: { accept: 'image/webp,image/*,*/*;q=0.8', 'sec-fetch-dest': 'image' },
        });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host,
    pointer: site.pointer,
    pointerMs: LOOKUP.pointer,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return {
    response,
    points,
    gate,
    dispatchApp,
    fetchImpl,
    transformImage,
    projectId: site.pointer.projectId,
    manifestId: site.manifestId,
    policyId: site.pointer.policyId,
    pathname: new URL(request.url).pathname,
  };
}

describe('hosted image pattern-budget terminal metrics', () => {
  it.each(CASES)('$name', async (row) => {
    const result = await routed(row);

    expect({
      status: result.response.status,
      debug: result.response.headers.get(EDGE_DEBUG_HEADER),
    }).toStrictEqual({ status: row.status, debug: row.debug });
    expect(result.gate).not.toHaveBeenCalled();
    expect(result.dispatchApp).not.toHaveBeenCalled();
    expect(result.fetchImpl).not.toHaveBeenCalled();
    expect(result.transformImage).not.toHaveBeenCalled();
    expect(result.points).toHaveLength(1);
    expect(result.points[0]).toMatchObject({
      projectId: result.projectId,
      manifestId: result.manifestId,
      policyId: result.policyId,
      pathname: result.pathname,
      kind: row.kind,
      outcomeKind: row.outcomeKind,
      subrequests: 0,
    });
    expect(result.points[0]?.pointerLookupMs).toBe(row.pointerLookupMs);
  });
});
