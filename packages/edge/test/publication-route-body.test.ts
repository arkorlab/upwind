import { policyFromBuild, type DecodedGenerationPack } from '@stayingupwind/core/cache';
import type { RouteBodyEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { describe, expect, it, vi } from 'vitest';

import { loadGeneration } from '../src/cache/generation-hold.ts';
import type { HostedGate } from '../src/handlers/hosted-gate.ts';
import { observeMetric } from '../src/handlers/observer.ts';
import { routeHostedBody, type RouteBodyInput } from '../src/handlers/route-body.ts';

const mocks = vi.hoisted(() => {
  return {
    entry: {
      kind: 'route-body' as const,
      pathname: '/icon',
      route: '/icon',
      entryId: 'entry',
      function: 'app',
    },
  };
});

// Routing and storage are boundaries; the real generation decision, body validation and final
// publication admission run without a Worker, a cache backend or a live deployment.
vi.mock(import('@stayingupwind/core/request'), async (original) => {
  return {
    ...(await original()),
    classifyRequest: vi.fn(() => ({ kind: 'route-body' as const, entry: mocks.entry })),
  };
});
vi.mock(import('../src/handlers/hosted-gate.ts'), () => {
  return {
    serveAfterMiddleware: vi.fn((_input: unknown, gate: HostedGate) =>
      gate.serve(undefined, 0, { headers: {}, conditioned: false }),
    ),
  };
});
vi.mock(import('../src/handlers/hosted-route.ts'), () => ({ offTheEdge: vi.fn() }));
vi.mock(import('../src/cache/condemned.ts'), () => {
  const condemnedIn = vi.fn(() => vi.fn<() => undefined>());
  return { condemnedIn };
});
vi.mock(import('../src/cache/generation-hold.ts'), () => {
  return {
    loadGeneration: vi.fn(),
    readServedAgain: vi.fn(),
  };
});
vi.mock(import('../src/cache/regenerate.ts'), () => {
  return {
    foregroundDocument: vi.fn(() => Promise.resolve(new Response('regenerate', { status: 503 }))),
    shouldAsk: vi.fn(),
    triggerDetached: vi.fn(),
  };
});
vi.mock(import('../src/handlers/observer.ts'), () => {
  return {
    observeMetric: vi.fn(),
    observeServed: vi.fn(),
  };
});

const NOW = 1_800_000_000_000;
const BODY = new TextEncoder().encode('image bytes');

function pack(source: 'build' | 'runtime'): DecodedGenerationPack {
  return {
    header: {
      schemaVersion: 1,
      scopeId: 'scope',
      entryId: 'entry',
      generationId: 'generation',
      seq: 1,
      revision: 1,
      source,
      kind: 'app-route',
      route: '/icon',
      pathname: '/icon',
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: false }),
      status: 200,
      headers: { 'content-type': 'image/png' },
      tags: [],
      htmlSha256: 'a'.repeat(64),
      htmlLength: BODY.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [
        {
          role: 'route-body',
          representationKey: 'route-body',
          artifactId: 'image',
          sha256: 'a'.repeat(64),
          byteLength: BODY.byteLength,
          contentType: 'image/png',
          encoding: 'identity',
        },
      ],
    },
    html: BODY,
    postponed: undefined,
  };
}

function scenario(
  source: 'build' | 'runtime',
  independent = true,
  tags: readonly string[] = [],
  now = () => NOW,
) {
  const publication = {
    version: 1 as const,
    identities: ['a'.repeat(64)],
    routes: ['/icon'],
    ...(independent && { independentBuild: ['/icon'] }),
  };
  const passthrough = vi.fn(() => Promise.resolve(new Response('regenerate', { status: 503 })));
  const input = {
    request: new Request('https://fixture.test/icon'),
    url: new URL('https://fixture.test/icon'),
    classifiedHeaders: new Headers(),
    entry: mocks.entry as RouteBodyEntry,
    passthrough,
    manifest: { cache: { scopeId: 'scope' }, publication },
    edge: {
      policy: DEFAULT_DELIVERY_POLICY,
      runtime: { now, memory: {} },
      host: {},
      manifestId: 'manifest',
      projectId: 'project',
      timings: {},
    },
  } as unknown as RouteBodyInput;
  const selected = pack(source);
  vi.mocked(loadGeneration).mockResolvedValue({
    kind: 'generation',
    pack: {
      ...selected,
      header: { ...selected.header, tags: tags.map((value) => ({ kind: 'next-explicit', value })) },
    },
    source: 'kv',
    readBytes: 1,
    lookupMs: 0,
  });
  return { input, passthrough };
}

describe('publication admission for seeded route bodies', () => {
  it('checks a required grant again after a valid record reaches composition', async () => {
    let current = NOW;
    const test = scenario(
      'build',
      false,
      [`upwind:publication:v1:${'a'.repeat(64)}:${String(NOW + 1000)}`],
      () => current,
    );
    vi.mocked(observeMetric).mockImplementationOnce(() => {
      current = NOW + 1000;
    });

    const response = await routeHostedBody(test.input);

    expect(response.status).toBe(503);
    await expect(response.text()).resolves.not.toContain('image bytes');
  });

  it('keeps the independent proof on a fresh build-source pack through final admission', async () => {
    const test = scenario('build');
    const response = await routeHostedBody(test.input);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('image bytes');
    expect(test.passthrough).not.toHaveBeenCalled();
  });

  it('does not exempt an ungranted runtime pack from the same route', async () => {
    const test = scenario('runtime');
    const response = await routeHostedBody(test.input);

    expect(response.status).toBe(503);
  });
});
