import { buildProjectManifest } from '@stayingupwind/core/manifest';
import { GATE_ANSWER_HEADER, GATE_PASS } from '@stayingupwind/host/bindings';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { type GateInput, routeThroughGate } from '../src/handlers/gate.ts';
import { forwardingFor, type IncomingRequest } from '../src/request-context.ts';
import { standaloneHost } from '../src/standalone/index.ts';

const PATH = '/gated';
const ORIGIN = 'https://site.example';
const GENERATED_AT = '2026-10-24T00:00:00.000Z';

function input(validated = false, declared = true): GateInput {
  const request: IncomingRequest = new Request(`${ORIGIN}${PATH}`);
  const original = standaloneHost(env);
  const host = {
    ...original,
    gates: {
      answer: vi.fn(() =>
        Promise.resolve(new Response(null, { headers: { [GATE_ANSWER_HEADER]: GATE_PASS } })),
      ),
    },
  };
  return {
    request,
    url: new URL(request.url),
    routedHeaders: request.headers,
    host,
    forwarding: forwardingFor(request, host.sharedDomain, 'site.example'),
    manifest: buildProjectManifest({
      projectId: 'p',
      runId: 'r',
      generatedAt: GENERATED_AT,
      originHost: 'site.example',
      deployment: { dplId: 'dpl_gate_cache', assetSetHash: 'h', observedAt: GENERATED_AT },
      routes: [],
      app: { deploymentId: 'dpl_gate_cache', scriptName: 'app' },
      exactPathnames: [PATH],
      ...(declared && { gates: { [PATH]: 'checker' }, gatedPathnames: { [PATH]: PATH } }),
    }),
    validated,
    privateDelivery: false,
    cspReportingPath: undefined,
    cspNonce: undefined,
    passed: vi.fn(),
  };
}

/** The mock gate installed by the fixture, observed without borrowing a host method. */
function gateSpy(host: GateInput['host']) {
  const gates = host.gates;
  if (gates === undefined) throw new Error('the fixture has no gate');
  return vi.spyOn(gates, 'answer');
}

describe('a response served after a gate passes', () => {
  it.each([
    ['public, max-age=60, s-maxage=600', 'private, max-age=60'],
    ['public, private="Set-Cookie", max-age=60, s-maxage=600', 'private, max-age=60'],
    ['private, max-age=60', 'private, max-age=60'],
    ['no-store', 'no-store'],
  ])('keeps %s from shared caches', async (policy, expected) => {
    const asked = input();
    const response = new Response('held bytes', { headers: { 'cache-control': policy } });
    const route = vi.fn(() => Promise.resolve(response));

    const answer = await routeThroughGate(asked, route);

    expect(answer.headers.get('cache-control')).toBe(expected);
    await expect(answer.text()).resolves.toBe('held bytes');
    expect(route).toHaveBeenCalledTimes(1);
    expect(asked.passed).toHaveBeenCalledTimes(1);
  });

  it('removes CDN overrides from the admitted answer', async () => {
    const headers = {
      'cache-control': 'public, max-age=60, s-maxage=600',
      'cdn-cache-control': 'public, max-age=600',
      'cloudflare-cdn-cache-control': 'max-age=600',
      'surrogate-control': 'max-age=600',
    };
    const answer = await routeThroughGate(input(), () =>
      Promise.resolve(new Response('held bytes', { headers })),
    );

    const overrides = Object.keys(headers).filter((header) => header !== 'cache-control');

    expect(answer.headers.get('cache-control')).toBe('private, max-age=60');

    for (const name of overrides) {
      expect(answer.headers.has(name)).toBe(false);
    }

    await answer.arrayBuffer();
  });

  it('copies immutable headers while preserving a redirect', async () => {
    const answer = await routeThroughGate(input(), () =>
      Promise.resolve(Response.redirect(`${ORIGIN}/login`, 302)),
    );

    expect(answer.status).toBe(302);
    expect(answer.headers.get('location')).toBe(`${ORIGIN}/login`);
    expect(answer.headers.get('cache-control')).toBe('private, no-store');
    expect(answer.body).toBeNull();
  });

  it.each([
    ['validated', true, true],
    ['ungated', false, false],
  ] as const)('retains existing delivery for a %s request', async (_name, validated, declared) => {
    const asked = input(validated, declared);
    const original = new Response('public bytes', { headers: { 'cache-control': 'public' } });
    const gate = gateSpy(asked.host);
    const answer = await routeThroughGate(asked, () => Promise.resolve(original));

    expect(answer).toBe(original);
    expect(answer.headers.get('cache-control')).toBe('public');
    expect(gate).not.toHaveBeenCalled();
    expect(asked.passed).not.toHaveBeenCalled();

    await answer.arrayBuffer();
  });

  it('preserves a downstream native WebSocket upgrade', async () => {
    const pair = new WebSocketPair();
    pair[1].accept();
    try {
      const asked = input();
      asked.request.headers.set('upgrade', 'websocket');
      const answer = await routeThroughGate(asked, () => {
        return Promise.resolve(
          new Response(null, {
            // eslint-disable-next-line unicorn/no-invalid-response-options -- A native Worker upgrade carries its WebSocket beside status 101.
            status: 101,
            webSocket: pair[0],
          }),
        );
      });

      expect(answer.status).toBe(101);
      expect(answer.webSocket).toBe(pair[0]);
      expect(answer.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      pair[0].accept();
      pair[0].close(1000);
      pair[1].close(1000);
    }
  });
});
