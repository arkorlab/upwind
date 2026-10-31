import { admitPublication } from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { describe, expect, it, vi } from 'vitest';

import { handleDocument } from '../src/handlers/document.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const NOW = 1_800_000_000_000;
const ID = 'a'.repeat(64);

function fixture(until?: number, independent = false) {
  const entry: RouteEntry = {
    pathname: '/items',
    status: 200,
    headers: { 'content-type': 'text/html' },
    shell: {
      sha256: 'a'.repeat(64),
      byteLength: 3,
      contentType: 'text/html',
      encoding: 'identity',
    },
    cache: {
      entryId: 'entry',
      delivery: 'complete',
      kind: 'app-page',
      route: '/items',
      buildTags:
        until === undefined
          ? []
          : [{ kind: 'next-explicit', value: `upwind:publication:v1:${ID}:${String(until)}` }],
    },
  };
  const manifest = {
    ...buildProjectManifest({
      projectId: 'project',
      runId: 'run',
      originHost: 'site.test',
      generatedAt: '2026-10-31T00:00:00.000Z',
      deployment: { assetSetHash: 'assets', observedAt: '2026-10-31T00:00:00.000Z' },
      app: { deploymentId: 'deployment', scriptName: 'app' },
      routes: [entry],
    }),
    publication: {
      version: 1 as const,
      identities: [ID],
      routes: ['/items'],
      ...(independent && { independentBuild: ['/items'] }),
    },
  };
  const policy = {
    ...DEFAULT_DELIVERY_POLICY,
    runtimeCache: { ...DEFAULT_DELIVERY_POLICY.runtimeCache, generations: 'off' as const },
  };
  const edge = {
    env: {},
    runtime: { now: () => NOW, memory: createEdgeMemory(() => NOW) },
    ctx: { waitUntil: vi.fn() },
    policy,
    host: { names: {}, credentials: {} },
    validated: false,
    privateDelivery: false,
    cacheApi: false,
    projectId: 'project',
    manifestId: 'manifest',
    timings: {},
    app: manifest.app,
  } as unknown as EdgeContext;
  const passthrough = vi.fn(() => Promise.resolve(new Response('fresh from runtime')));
  const input = {
    request: new Request('https://site.test/items', { headers: { 'accept-encoding': 'identity' } }),
    entry,
    manifest,
    edge,
    middleware: undefined,
    generation: undefined,
    shellRead: Promise.resolve({
      kind: 'ok' as const,
      read: { bytes: new TextEncoder().encode('old'), source: 'memory' as const, latencyMs: 0 },
    }),
    resolved: {
      policy,
      shell: { id: 'kv' as const, getShell: () => Promise.resolve(undefined) },
      assets: {
        id: 'passthrough' as const,
        handle: () => Promise.reject(new Error('No asset is requested.')),
      },
    },
    passthrough,
  };
  return { input, passthrough };
}

describe('publication admission without generation-record caching', () => {
  it.each([undefined, NOW])(
    'never serves an ungranted or expired complete build (%s)',
    async (until) => {
      const test = fixture(until);
      const response = await handleDocument(test.input);

      await expect(response.text()).resolves.toBe('fresh from runtime');
      expect(test.passthrough).toHaveBeenCalledExactlyOnceWith(
        'publication-expired',
        undefined,
        '/items',
      );
    },
  );

  it('keeps a freshly admitted live fallback when only the unused shipped grant expires', async () => {
    const test = fixture(NOW + 1000);
    const clock = vi.spyOn(test.input.edge.runtime, 'now');

    test.passthrough.mockImplementation(() => {
      clock.mockReturnValue(NOW + 1000);
      const tag = `upwind:publication:v1:${ID}:${String(NOW + 60_000)}`;
      return Promise.resolve(
        admitPublication(new Response('fresh from runtime'), [tag], NOW + 1000),
      );
    });

    try {
      const response = await handleDocument({
        ...test.input,
        shellRead: Promise.resolve({ kind: 'missing' }),
      });

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('fresh from runtime');
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps an independently proven static build available', async () => {
    const test = fixture(undefined, true);
    const response = await handleDocument(test.input);

    expect(response.status).toBe(200);
    expect(test.passthrough).not.toHaveBeenCalled();
  });
});
