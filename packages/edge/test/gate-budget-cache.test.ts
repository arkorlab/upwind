import { buildProjectManifest } from '@stayingupwind/core/manifest';
import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { DEFAULT_DELIVERY_POLICY, type EdgePointer } from '@stayingupwind/host/delivery';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import { stateFromPointer } from '../src/preview/state.ts';
import { routeRequest } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation } from './helpers/site.ts';

const PATH = '/gated';
const NOW = '2026-10-24T00:00:00.000Z';
const APP = { deploymentId: 'dpl_site', scriptName: 'site-app' };
const PUBLIC = 'public, max-age=60, s-maxage=600';
const PRIVATE = 'private, max-age=60';
const AGENT = 'a'.repeat(4096);

interface Scenario {
  readonly name: string;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cdn?: boolean;
  readonly status?: number;
  readonly location?: string;
  readonly declared?: boolean;
  readonly otherGate?: boolean;
  readonly validated?: boolean;
  readonly denied?: boolean;
  readonly rsc?: boolean;
  readonly lookupBudget?: boolean;
  readonly originCache?: string;
  readonly cache?: string;
  readonly gateCalls?: number;
  readonly appCalls?: number;
  readonly budget?: boolean;
  readonly subrequests?: number;
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'admitted GET' },
  { name: 'admitted HEAD', method: 'HEAD' },
  { name: 'admitted GET with CDN override inputs', cdn: true },
  { name: 'admitted HEAD with CDN override inputs', method: 'HEAD', cdn: true },
  { name: 'admitted redirect', status: 302, location: 'https://site.example/login' },
  { name: 'cookie request', headers: { cookie: 'session=one' }, budget: false },
  {
    name: 'authorization HEAD',
    method: 'HEAD',
    headers: { authorization: 'Bearer one' },
    budget: false,
  },
  { name: 'ungated deployment', declared: false, gateCalls: 0, cache: PUBLIC },
  { name: 'ungated route of a gated deployment', otherGate: true, gateCalls: 0, cache: PUBLIC },
  {
    name: 'validated request',
    validated: true,
    gateCalls: 0,
    cache: PRIVATE,
    budget: false,
    // A navigation checks the missing build shell before asking the application.
    subrequests: 2,
  },
  { name: 'POST', method: 'POST', gateCalls: 0, cache: PUBLIC, budget: false },
  {
    name: 'terminal gate',
    denied: true,
    status: 403,
    appCalls: 0,
    cache: 'private, no-store',
    budget: false,
  },
  { name: 'ordinary router response', rsc: true, budget: false },
  { name: 'existing no-store', originCache: 'no-store', cache: 'no-store' },
  { name: 'existing private cache policy', originCache: PRIVATE },
  {
    name: 'gate lookup budget',
    lookupBudget: true,
    status: 503,
    gateCalls: 0,
    appCalls: 0,
    cache: 'private, no-store',
    budget: false,
  },
];

/** The real classifier exhausts its allowance after the exact gate lookup, before any cache read. */
async function routed(scenario: Scenario) {
  const declared = scenario.declared !== false;
  const gatedRoute = scenario.otherGate === true ? '/other' : PATH;
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run_site',
    generatedAt: NOW,
    originHost: 'site.example',
    deployment: { dplId: APP.deploymentId, assetSetHash: 'a'.repeat(64), observedAt: NOW },
    routes: [
      {
        pathname: PATH,
        status: 200,
        shell: {
          sha256: 'a'.repeat(64),
          byteLength: 1,
          contentType: 'text/html; charset=utf-8',
          encoding: 'identity',
        },
        headers: { 'content-type': 'text/html; charset=utf-8' },
        cache: { entryId: 'entry', kind: 'pages', delivery: 'complete' },
      },
    ],
    app: APP,
    cache: { keySchemaVersion: 1, scopeId: APP.deploymentId },
    staticPages: [
      {
        pathname: PATH,
        route: PATH,
        entryId: 'entry',
        bypassFor: [{ type: 'header', key: 'user-agent', value: 'a+a+' }],
      },
    ],
    ...(declared && {
      gates: { [gatedRoute]: 'checker' },
      gatedPathnames: { [gatedRoute]: gatedRoute },
    }),
    ...(scenario.lookupBudget === true && {
      dynamicRoutes: [{ sourceRegex: '^/(a+a+)$', route: PATH, gated: PATH }],
    }),
  });
  let gates = 0;
  let applications = 0;
  let network = 0;
  const metrics: EdgeMetric[] = [];
  const method = scenario.method ?? 'GET';
  const request = navigation(scenario.lookupBudget === true ? `/${AGENT}` : PATH, {
    method,
    headers: {
      'user-agent': AGENT,
      ...scenario.headers,
      ...(scenario.rsc === true && { rsc: '1' }),
    },
  });
  const runtime = standaloneRuntime(env, {
    now: () => 0,
    memory: createEdgeMemory(() => 0),
    fetchImpl: () => {
      network += 1;
      return Promise.reject(new Error('unexpected network'));
    },
    dispatchApp: () => {
      applications += 1;
      return Promise.resolve(
        new Response(method === 'HEAD' ? null : 'application bytes', {
          status: scenario.status ?? 200,
          headers: {
            'cache-control': scenario.originCache ?? PUBLIC,
            ...(scenario.cdn === true && {
              'cdn-cache-control': 'public, max-age=600',
              'cloudflare-cdn-cache-control': 'max-age=600',
              'surrogate-control': 'max-age=600',
            }),
            ...(scenario.location !== undefined && { location: scenario.location }),
          },
        }),
      );
    },
  });
  const original = standaloneHost(env);
  const host = {
    ...original,
    gates: {
      answer: () => {
        gates += 1;
        return Promise.resolve(
          scenario.denied === true
            ? new Response('gate refusal', { status: 403 })
            : new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } }),
        );
      },
    },
    observer: {
      ...original.observer,
      metric: (metric: EdgeMetric): void => {
        metrics.push(metric);
      },
    },
  };
  const pointer: EdgePointer = {
    v: 1,
    projectId: 'site',
    originHost: 'site.example',
    mode: 'edge',
    deployment: { dplId: APP.deploymentId, assetSetHash: 'a'.repeat(64), observedAt: NOW },
    manifestId: 'manifest',
    policyId: DEFAULT_DELIVERY_POLICY.id,
    app: APP,
    ...(declared && { hasGates: true as const }),
    updatedAt: NOW,
  };
  const state = {
    ...stateFromPointer({
      runtime,
      pointer,
      stored: { kind: 'found', value: manifest },
      lookup: { kind: 'found', source: 'exact', policy: DEFAULT_DELIVERY_POLICY },
      pathname: PATH,
      privateDelivery: false,
      cspReportingPath: undefined,
    }),
    validated: scenario.validated === true,
  };
  const ctx = createExecutionContext();
  const response = await routeRequest({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host,
    state,
    timings: { pointerMs: 0, manifestMs: 0, middlewareMs: undefined },
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, gates, applications, network, metrics };
}

/** The response facts the routing scenarios observe. */
function observedAnswer(result: Awaited<ReturnType<typeof routed>>) {
  const headers = result.response.headers;
  return {
    status: result.response.status,
    gates: result.gates,
    applications: result.applications,
    network: result.network,
    cache: headers.get('cache-control'),
    cdn: ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control'].filter((name) =>
      headers.has(name),
    ),
    metrics: result.metrics.length,
    subrequests: result.metrics[0]?.subrequests,
    budget: headers.get('x-arkor-edge')?.includes('pattern-budget') ?? false,
    location: headers.get('location'),
    body: result.body,
  };
}

/** The same required facts and conditional checks as each scenario's delivery contract. */
function expectedAnswer(scenario: Scenario) {
  const gates = scenario.gateCalls ?? 1;
  const applications = scenario.appCalls ?? 1;
  return {
    status: scenario.status ?? 200,
    gates,
    applications,
    network: 0,
    cache: scenario.cache ?? PRIVATE,
    cdn: [],
    metrics: 1,
    subrequests: scenario.subrequests ?? gates + applications,
    ...(scenario.budget !== false && { budget: true }),
    ...(scenario.location !== undefined && { location: scenario.location }),
    ...(applications > 0 && { body: scenario.method === 'HEAD' ? '' : 'application bytes' }),
  };
}

describe('cache privacy when routing falls back after gate admission', () => {
  it.each(SCENARIOS)('preserves $name', async (scenario) => {
    const result = await routed(scenario);

    expect(observedAnswer(result)).toMatchObject(expectedAnswer(scenario));
  });
});
