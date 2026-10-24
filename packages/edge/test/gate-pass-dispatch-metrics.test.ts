import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { manifestStateFromPointer } from '../src/preview/state.ts';
import { routeRequest, serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { htmlResponse, navigation, pprDocument, seedSite } from './helpers/site.ts';

const POST = '/posts/[slug]';
const PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const COUNTS = { document: 3 } as const;

interface Example {
  readonly id: string;
  readonly gate: 'pass' | 'terminal' | 'none';
  readonly path: string;
  readonly rsc: boolean;
  readonly method: string;
  readonly validated: boolean;
  readonly throwingObserver: boolean;
  readonly calls: readonly [number, number];
  readonly subrequests: number;
  readonly kvGets: number;
}

const CASES: readonly Example[] = [
  {
    id: 'passed payload',
    gate: 'pass',
    path: '/posts/abc',
    rsc: true,
    method: 'GET',
    validated: false,
    throwingObserver: false,
    calls: [1, 1],
    subrequests: 2,
    kvGets: 2,
  },
  {
    id: 'passed HEAD payload',
    gate: 'pass',
    path: '/posts/abc',
    rsc: true,
    method: 'HEAD',
    validated: false,
    throwingObserver: false,
    calls: [1, 1],
    subrequests: 2,
    kvGets: 2,
  },
  {
    id: 'passed document',
    gate: 'pass',
    path: '/posts/abc',
    rsc: false,
    method: 'GET',
    validated: false,
    throwingObserver: false,
    calls: [1, 1],
    subrequests: COUNTS.document,
    kvGets: COUNTS.document,
  },
  {
    id: 'terminal gate',
    gate: 'terminal',
    path: '/posts/abc',
    rsc: true,
    method: 'GET',
    validated: false,
    throwingObserver: false,
    calls: [1, 0],
    subrequests: 1,
    kvGets: 2,
  },
  {
    id: 'unmatched route',
    gate: 'pass',
    path: '/elsewhere',
    rsc: true,
    method: 'GET',
    validated: false,
    throwingObserver: false,
    calls: [0, 1],
    subrequests: 1,
    kvGets: 2,
  },
  {
    id: 'validated request',
    gate: 'pass',
    path: '/posts/abc',
    rsc: true,
    method: 'GET',
    validated: true,
    throwingObserver: false,
    calls: [0, 1],
    subrequests: 1,
    kvGets: 0,
  },
  {
    id: 'deployment without gate',
    gate: 'none',
    path: '/posts/abc',
    rsc: true,
    method: 'GET',
    validated: false,
    throwingObserver: false,
    calls: [0, 1],
    subrequests: 1,
    kvGets: 2,
  },
  {
    id: 'passed throwing observer',
    gate: 'pass',
    path: '/posts/abc',
    rsc: true,
    method: 'GET',
    validated: false,
    throwingObserver: true,
    calls: [1, 1],
    subrequests: 2,
    kvGets: 2,
  },
];

/** The gate and Function dispatch counts are observed independently of the emitted metric. */
async function measured(example: Example) {
  const document = pprDocument();
  const site = await seedSite({
    document,
    pathname: POST,
    dynamicRoutes: [
      { sourceRegex: PATTERN, route: POST, ...(example.gate !== 'none' && { gated: POST }) },
    ],
    ...(example.gate !== 'none' && {
      gates: { [POST]: 'checker' },
      gatedPathnames: { [POST]: POST },
    }),
  });
  const points: EdgeMetric[] = [];
  let gateCalls = 0;
  let functionCalls = 0;
  const base = standaloneHost(env);
  const host = {
    ...base,
    gates: {
      answer: () => {
        gateCalls += 1;
        return Promise.resolve(
          example.gate === 'terminal'
            ? new Response('denied', { status: 403 })
            : new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } }),
        );
      },
    },
    observer: {
      ...base.observer,
      metric: (point: EdgeMetric) => {
        points.push(point);
        if (example.throwingObserver) throw new Error('the observer failed');
      },
    },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: () => {
      functionCalls += 1;
      return Promise.resolve(
        example.rsc ? new Response('from the Function') : htmlResponse(document.suffix),
      );
    },
  });
  const kv = vi.spyOn(env.EDGE_STATE, 'get');
  const bucket = vi.spyOn(env.ARTIFACTS, 'get');
  const request = navigation(example.path, {
    method: example.method,
    ...(example.rsc && { headers: { rsc: '1' } }),
  });
  const ctx = createExecutionContext();
  const shared = { request, url: new URL(request.url), env, ctx, runtime, host };
  const response = await (example.validated
    ? routeRequest({
        ...shared,
        state: {
          ...manifestStateFromPointer({
            runtime,
            pointer: site.pointer,
            stored: { kind: 'found', value: site.manifest },
            pathname: example.path,
            privateDelivery: false,
            cspReportingPath: undefined,
          }),
          policy: DEFAULT_DELIVERY_POLICY,
          validated: true,
        },
        timings: { pointerMs: 1, manifestMs: 0, middlewareMs: 0 },
      })
    : serveFromPointer({
        ...shared,
        pointer: site.pointer,
        pointerMs: 1,
        privateDelivery: false,
        cspReportingPath: undefined,
      }));
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  const io = {
    gateCalls,
    functionCalls,
    kvGets: kv.mock.calls.length,
    bucketGets: bucket.mock.calls.length,
  };
  return { response, body, points, gateCalls, functionCalls, io };
}

describe('passed gate request dispatch totals', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(CASES)('counts $id without adding another metric', async (example) => {
    const result = await measured(example);

    expect(result.io).toStrictEqual({
      gateCalls: example.calls[0],
      functionCalls: example.calls[1],
      kvGets: example.kvGets,
      bucketGets: 0,
    });
    expect(result.response.status).toBe(example.gate === 'terminal' ? 403 : 200);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.subrequests).toBe(example.subrequests);
  });
});
