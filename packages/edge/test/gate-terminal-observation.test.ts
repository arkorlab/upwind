import type { HeaderRule } from '@stayingupwind/core/manifest';
import { EDGE_DEBUG_HEADER } from '@stayingupwind/core/request';
import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeGates } from '../src/edge-host.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import type { IncomingRequest } from '../src/request-context.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite, type SiteOptions } from './helpers/site.ts';

/** Configured gate headers cross the ordinary response boundary and each terminal answer counts. */

const POST = '/posts/[slug]';
const POST_PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const GATE = 'checker';
const STATUS = { ok: 200, forbidden: 403, unavailable: 503 } as const;
const TIMING = { gate: 19 } as const;
const QUADRATIC = String.raw`^/(?<slug>\w+\w+)!$`;
const CRAFTED = `/${'a'.repeat(4096)}`;
const GATED: Omit<SiteOptions, 'document'> = {
  pathname: POST,
  dynamicRoutes: [{ sourceRegex: POST_PATTERN, route: POST, gated: POST }],
  gates: { [POST]: GATE },
  gatedPathnames: { [POST]: POST },
};

/** The request's one answer, metrics, and the work handed to the application's Function. */
async function routed(
  request: IncomingRequest,
  gates: EdgeGates | undefined,
  headerRules?: readonly HeaderRule[],
  settings: {
    readonly site?: Partial<SiteOptions>;
    readonly observer?: (point: EdgeMetric) => void;
    readonly now?: () => number;
    readonly sharedDomain?: string;
  } = {},
): Promise<{
  readonly response: Response;
  readonly points: readonly EdgeMetric[];
  readonly functionAsked: readonly string[];
  readonly projectId: string;
  readonly manifestId: string;
}> {
  const { pointer, manifestId } = await seedSite({
    document: pprDocument(),
    ...GATED,
    ...settings.site,
    ...(headerRules !== undefined && { headerRules }),
  });
  const points: EdgeMetric[] = [];
  const functionAsked: string[] = [];
  const base = standaloneHost(env);
  const host = {
    ...base,
    sharedDomain: settings.sharedDomain ?? base.sharedDomain,
    gates,
    observer: {
      ...base.observer,
      metric: (point: EdgeMetric): void => {
        points.push(point);
        settings.observer?.(point);
      },
    },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    ...(settings.now !== undefined && { now: settings.now }),
    dispatchApp: (_: string, dispatched: Request): Promise<Response> => {
      functionAsked.push(new URL(dispatched.url).pathname);
      return Promise.resolve(new Response('from the Function'));
    },
  });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host,
    pointer,
    pointerMs: 1,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  await response.arrayBuffer();
  await waitOnExecutionContext(ctx);
  return { response, points, functionAsked, projectId: pointer.projectId, manifestId };
}

/** The bound gate answers as a fresh call of `answer` does, keeping its stream request-local. */
function answering(answer: () => Response): EdgeGates {
  return { answer: () => Promise.resolve(answer()) };
}

/** Every request of the post matches one rule, independent of any gate-specific control header. */
function configured(headers: Readonly<Record<string, string>>): readonly HeaderRule[] {
  return [{ sourceRegex: POST_PATTERN, headers: { ...headers } }];
}

describe('terminal gate response header filtering', () => {
  it.each([
    'connection',
    'transfer-encoding',
    'keep-alive',
    'te',
    'trailer',
    'upgrade',
    'proxy-authenticate',
    'proxy-authorization',
    'content-length',
    'x-next-cache-tags',
    'x-arkor-secret',
  ])('keeps a configured %s field behind the normal response boundary', async (name) => {
    const { response } = await routed(
      navigation('/posts/abc'),
      answering(() => new Response('kept')),
      configured({ [name]: name === 'content-length' ? '7' : 'configured' }),
    );

    expect(response.status).toBe(STATUS.ok);
    expect(response.headers.has(name)).toBe(false);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe(`gate;name=${GATE}`);
  });

  it('removes fields a configured Connection nominates from both answer and rule', async () => {
    const { response } = await routed(
      navigation('/posts/abc'),
      answering(
        () => new Response('kept', { headers: { 'x-nominated': 'gate', 'x-safe': 'kept' } }),
      ),
      configured({ connection: 'X-Nominated, x-other', 'x-nominated': 'rule', 'x-other': 'rule' }),
    );

    expect(response.headers.has('connection')).toBe(false);
    expect(response.headers.has('x-nominated')).toBe(false);
    expect(response.headers.has('x-other')).toBe(false);
    expect(response.headers.get('x-safe')).toBe('kept');
  });

  it('keeps the gate hop fields filtered when a rule replaces Connection', async () => {
    const { response } = await routed(
      navigation('/posts/abc'),
      answering(() => {
        return new Response('kept', {
          headers: { connection: 'x-gate-hop', 'x-gate-hop': 'gate', 'x-safe': 'kept' },
        });
      }),
      configured({ connection: 'x-rule-hop', 'x-rule-hop': 'rule' }),
    );

    expect(response.headers.has('connection')).toBe(false);
    expect(response.headers.has('x-gate-hop')).toBe(false);
    expect(response.headers.has('x-rule-hop')).toBe(false);
    expect(response.headers.get('x-safe')).toBe('kept');
  });

  it('preserves configured ordinary headers and the order of repeated cookies', async () => {
    const { response } = await routed(
      navigation('/posts/abc'),
      answering(
        () =>
          new Response('kept', { headers: { 'x-safe': 'gate', 'set-cookie': 'gate=1; Path=/' } }),
      ),
      configured({ 'x-safe': 'rule', 'set-cookie': 'rule=1; Path=/' }),
    );

    expect(response.headers.get('x-safe')).toBe('rule');
    expect(response.headers.getSetCookie()).toStrictEqual(['gate=1; Path=/', 'rule=1; Path=/']);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('preserves a valid configured HEAD representation length', async () => {
    const { response } = await routed(
      navigation('/posts/abc', { method: 'HEAD' }),
      answering(() => new Response(null)),
      configured({ 'content-length': '7' }),
    );

    expect(response.headers.get('content-length')).toBe('7');
    expect(response.body).toBeNull();
  });

  it.each([false, true])(
    'preserves cookie Domain scoping and order on shared host %s',
    async (shared) => {
      const { response } = await routed(
        navigation('/posts/abc'),
        answering(
          () =>
            new Response('kept', { headers: { 'set-cookie': 'gate=1; Domain=.example; Path=/' } }),
        ),
        configured({ 'set-cookie': 'rule=1; Domain=.example; Path=/' }),
        { sharedDomain: shared ? 'example' : 'invalid' },
      );

      expect(response.headers.getSetCookie()).toStrictEqual(
        shared
          ? ['gate=1; Path=/', 'rule=1; Path=/']
          : ['gate=1; Domain=.example; Path=/', 'rule=1; Domain=.example; Path=/'],
      );
    },
  );
});

describe('terminal gate request metrics', () => {
  it.each([STATUS.ok, STATUS.forbidden, STATUS.unavailable])(
    'records exactly one point for a bound terminal status %s',
    async (status) => {
      const { response, points, functionAsked, projectId, manifestId } = await routed(
        navigation('/posts/abc'),
        answering(() => new Response('gate answer', { status })),
      );

      expect(response.status).toBe(status);
      expect(functionAsked).toStrictEqual([]);
      expect(points).toHaveLength(1);
      expect(points[0]).toMatchObject({
        projectId,
        manifestId,
        pathname: POST,
        subrequests: 1,
        pointerLookupMs: 1,
      });
    },
  );

  it('records an unavailable answer with no dispatch where no gate is bound', async () => {
    const { response, points, functionAsked } = await routed(navigation('/posts/abc'), undefined);

    expect(response.status).toBe(STATUS.unavailable);
    expect(functionAsked).toStrictEqual([]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ pathname: POST, subrequests: 0 });
  });

  it('records a failed gate dispatch without waking the application Function', async () => {
    const { response, points, functionAsked } = await routed(
      navigation('/posts/abc'),
      answering(() => {
        throw new Error('the gate failed');
      }),
    );

    expect(response.status).toBe(STATUS.unavailable);
    expect(functionAsked).toStrictEqual([]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ pathname: POST, subrequests: 1 });
  });

  it('records only the existing downstream point when a gate passes the request on', async () => {
    const { points, functionAsked } = await routed(
      navigation('/posts/abc', { headers: { rsc: '1' } }),
      answering(() => new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } })),
    );

    expect(functionAsked).toStrictEqual(['/posts/abc']);
    expect(points).toHaveLength(1);
    expect(points[0]?.outcomeKind).not.toMatch(/^gate/u);
  });

  it('records a pattern-budget rejection without dispatching any gate', async () => {
    const { response, points, functionAsked } = await routed(
      navigation(CRAFTED),
      answering(() => {
        throw new Error('the pattern budget must run before any gate');
      }),
      undefined,
      { site: { dynamicRoutes: [{ sourceRegex: QUADRATIC, route: POST, gated: POST }] } },
    );

    expect(response.status).toBe(STATUS.unavailable);
    expect(response.headers.get(EDGE_DEBUG_HEADER)).toBe('error;reason=gate-pattern-budget');
    expect(functionAsked).toStrictEqual([]);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ pathname: CRAFTED, subrequests: 0 });
  });

  it('keeps a throwing metric observer from changing a terminal gate answer', async () => {
    const { response, points } = await routed(
      navigation('/posts/abc'),
      answering(() => new Response('kept', { status: STATUS.forbidden })),
      undefined,
      {
        observer: () => {
          throw new Error('the host metric sink failed');
        },
      },
    );

    expect(response.status).toBe(STATUS.forbidden);
    expect(points).toHaveLength(1);
  });

  it('measures the gate wait with the host runtime clock', async () => {
    let now = 0;
    const { points } = await routed(
      navigation('/posts/abc'),
      answering(() => {
        now = TIMING.gate;
        return new Response('kept');
      }),
      undefined,
      { now: () => now },
    );

    expect(points).toHaveLength(1);
    expect(points[0]?.originFirstByteMs).toBe(TIMING.gate);
  });
});
