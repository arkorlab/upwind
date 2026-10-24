import type { HeaderRule } from '@stayingupwind/core/manifest';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import type { EdgeGates } from '../src/edge-host.ts';
import { layConfiguredOver } from '../src/handlers/configured-headers.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { navigation, pprDocument, seedSite } from './helpers/site.ts';

const POST = '/posts/[slug]';
const POST_PATTERN = '^/posts/(?<slug>[^/]+?)(?:/)?$';
const GATE_LOCATION = '/sign-in?returnTo=%2Fposts%2Fabc';
const CONFIGURED_LOCATION = '/configured-redirect';
const GATE_COOKIE = 'gate=1; Path=/';
const CONFIGURED_COOKIE = 'configured=1; Path=/';
const STATUS = { ok: 200, redirect: 307 } as const;

/** A real terminal gate route and the requests it hands to the gate or application. */
async function routed(method: 'GET' | 'HEAD', answer: Response, configuredLocation: boolean) {
  const headerRules: readonly HeaderRule[] = [
    {
      sourceRegex: POST_PATTERN,
      headers: {
        'set-cookie': CONFIGURED_COOKIE,
        'x-precedence': 'configured',
        ...(configuredLocation && { location: CONFIGURED_LOCATION }),
      },
    },
  ];
  const { pointer } = await seedSite({
    document: pprDocument(),
    pathname: POST,
    dynamicRoutes: [{ sourceRegex: POST_PATTERN, route: POST, gated: POST }],
    gates: { [POST]: 'checker' },
    gatedPathnames: { [POST]: POST },
    headerRules,
  });
  const gateRequests: string[] = [];
  const applicationRequests: string[] = [];
  const gates: EdgeGates = {
    answer: (_name, request) => {
      gateRequests.push(request.method);
      return Promise.resolve(answer);
    },
  };
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    dispatchApp: (_deployment, request) => {
      applicationRequests.push(request.method);
      return Promise.resolve(new Response('unexpected application dispatch'));
    },
  });
  const request = navigation('/posts/abc', { method });
  const ctx = createExecutionContext();
  const response = await serveFromPointer({
    request,
    url: new URL(request.url),
    env,
    ctx,
    runtime,
    host: { ...standaloneHost(env), gates },
    pointer,
    pointerMs: 0,
    privateDelivery: false,
    cspReportingPath: undefined,
  });
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body, gateRequests, applicationRequests };
}

/** A gate's own status, destination and cookies remain independent of routing header rules. */
function gateAnswer(method: 'GET' | 'HEAD', redirect: boolean): Response {
  return new Response(method === 'HEAD' ? null : 'gate answer', {
    status: redirect ? STATUS.redirect : STATUS.ok,
    headers: {
      'set-cookie': GATE_COOKIE,
      'x-precedence': 'gate',
      ...(redirect && { location: GATE_LOCATION }),
    },
  });
}

describe('terminal gate destinations', () => {
  it.each(['GET', 'HEAD'] as const)(
    'preserves the gate redirect Location for %s',
    async (method) => {
      const { response, body, gateRequests, applicationRequests } = await routed(
        method,
        gateAnswer(method, true),
        true,
      );

      expect([
        response.status,
        response.headers.get('location'),
        response.headers.get('x-precedence'),
        response.headers.getSetCookie(),
        body,
        gateRequests,
        applicationRequests,
      ]).toStrictEqual([
        STATUS.redirect,
        GATE_LOCATION,
        'configured',
        [GATE_COOKIE, CONFIGURED_COOKIE],
        method === 'HEAD' ? '' : 'gate answer',
        [method],
        [],
      ]);
    },
  );

  it.each(['GET', 'HEAD'] as const)(
    'does not add a possible routing redirect to a terminal %s',
    async (method) => {
      const { response, body, gateRequests, applicationRequests } = await routed(
        method,
        gateAnswer(method, false),
        true,
      );

      expect([
        response.status,
        response.headers.get('location'),
        response.headers.get('x-precedence'),
        response.headers.getSetCookie(),
        body,
        gateRequests,
        applicationRequests,
      ]).toStrictEqual([
        STATUS.ok,
        null,
        'configured',
        [GATE_COOKIE, CONFIGURED_COOKIE],
        method === 'HEAD' ? '' : 'gate answer',
        [method],
        [],
      ]);
    },
  );

  it.each(['GET', 'HEAD'] as const)(
    'keeps ordinary configured headers beside a gate redirect for %s',
    async (method) => {
      const { response, gateRequests, applicationRequests } = await routed(
        method,
        gateAnswer(method, true),
        false,
      );

      expect([
        response.status,
        response.headers.get('location'),
        response.headers.get('x-precedence'),
        response.headers.getSetCookie(),
        response.headers.get('cache-control'),
        gateRequests,
        applicationRequests,
      ]).toStrictEqual([
        STATUS.redirect,
        GATE_LOCATION,
        'configured',
        [GATE_COOKIE, CONFIGURED_COOKIE],
        'private, no-store',
        [method],
        [],
      ]);
    },
  );

  it('matches the existing Function response Location exclusion', () => {
    const answer = new Response(null, {
      status: STATUS.redirect,
      headers: { location: GATE_LOCATION },
    });
    const headers = new Headers(answer.headers);
    layConfiguredOver(
      headers,
      {
        headers: { location: CONFIGURED_LOCATION, 'x-precedence': 'configured' },
        conditioned: false,
      },
      answer,
      {
        forwarding: {
          previewDomain: 'example.test',
          previewHost: 'customer.example.test',
        },
        request: { method: 'GET' },
      },
    );

    expect([headers.get('location'), headers.get('x-precedence')]).toStrictEqual([
      GATE_LOCATION,
      'configured',
    ]);
  });
});
