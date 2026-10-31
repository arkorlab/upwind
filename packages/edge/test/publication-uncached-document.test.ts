import {
  admitPublication,
  decodeGenerationPack,
  encodeGenerationPack,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY, runtimeCacheOf } from '@stayingupwind/host/delivery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { serveCachedDocument, type CachedDocumentInput } from '../src/cache/document.ts';
import { documentPublicationTags } from '../src/handlers/document-publication.ts';
import { handleDocument, type DocumentInput } from '../src/handlers/document.ts';
import { gateGeneration } from '../src/handlers/gate-shell.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

const NOW = 1_800_000_000_000;
const ID = 'a'.repeat(64);
const resume = vi.hoisted(() =>
  vi.fn(() => ({ response: Promise.resolve(new Response('</body></html>')), abort: vi.fn() })),
);
vi.mock(import('../src/strategies/continuation-resume.ts'), () => {
  const resumeContinuation = { start: resume };
  return { resumeContinuation };
});

function gate(until?: number) {
  const html = new TextEncoder().encode('<html><body>gate values');
  const postponed = new TextEncoder().encode('state');
  return gateGeneration(
    {
      kind: 'shell',
      gate: 'authority',
      lookupMs: 0,
      shell: {
        header: {
          status: 200,
          headers: {
            'content-type': 'text/html',
            ...(until !== undefined && {
              'x-next-cache-tags': `upwind:publication:v1:${ID}:${String(until)}`,
            }),
          },
          route: '/items',
          htmlLength: html.byteLength,
          postponedLength: postponed.byteLength,
          seq: 1,
          id: 'gate',
        },
        html,
        postponed,
      },
    },
    '/items',
  );
}

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
    runtimeCache: { ...runtimeCacheOf(DEFAULT_DELIVERY_POLICY), generations: 'off' as const },
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
  const input: DocumentInput = {
    request: new Request<unknown, IncomingRequestCfProperties>('https://site.test/items', {
      headers: { 'accept-encoding': 'identity' },
    }),
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

function cachedFixture(source: 'record' | 'build', mode: 'head' | 'sandbox' | 'resume') {
  const until = NOW + 1000;
  const test = fixture(until);
  const key = { scopeId: 'scope', entryId: 'entry' };
  const tag = `upwind:publication:v1:${ID}:${String(until)}`;
  const headers = {
    'content-type': 'text/html',
    ...(mode === 'sandbox' && { 'content-security-policy': 'sandbox' }),
  };
  const html = new TextEncoder().encode('<html><body>old selected bytes');
  const postponed = new TextEncoder().encode('state');
  const decoded = decodeGenerationPack(
    encodeGenerationPack(
      {
        schemaVersion: 1,
        ...key,
        generationId: 'generation',
        seq: 2,
        revision: 7,
        source: 'runtime',
        kind: 'app-page',
        route: '/items',
        pathname: '/items',
        cacheTimestamp: NOW,
        producedAt: NOW,
        policy: policyFromBuild({ initialRevalidate: false }),
        status: 200,
        headers,
        tags: [{ kind: 'next-explicit', value: tag }],
        htmlSha256: 'c'.repeat(64),
        htmlLength: html.byteLength,
        postponedSha256: 'd'.repeat(64),
        postponedLength: postponed.byteLength,
        artifacts: [],
      },
      html,
      postponed,
    ),
  );
  if (decoded.kind !== 'ok') throw new Error('Invalid document fixture.');
  const entry = {
    ...test.input.entry,
    headers,
    cache: { ...test.input.entry.cache!, delivery: 'resume' as const },
  };
  const input: CachedDocumentInput = {
    ...test.input,
    entry,
    request: new Request('https://site.test/items', { method: mode === 'head' ? 'HEAD' : 'GET' }),
    key,
    settings: runtimeCacheOf(test.input.edge.policy),
    generationRead: {
      load: Promise.resolve(
        source === 'record'
          ? {
              kind: 'generation' as const,
              pack: decoded.pack,
              source: 'memory',
              lookupMs: 0,
              readBytes: undefined,
            }
          : { kind: 'none' as const, lookupMs: 0 },
      ),
      shell: Promise.resolve({ kind: 'ok', read: { bytes: html, source: 'memory', latencyMs: 0 } }),
    },
    member: undefined,
  };
  return { ...test, input, until };
}

describe('publication admission without generation-record caching', () => {
  beforeEach(() => {
    resume.mockClear();
  });

  it.each([undefined, NOW])(
    'rejects an ungranted or expired gate shell before starting its resume (%s)',
    async (until) => {
      const test = fixture();
      const response = await handleDocument({ ...test.input, generation: gate(until) });

      await expect(response.text()).resolves.toBe('fresh from runtime');
      expect(resume).not.toHaveBeenCalled();
    },
  );

  it('rechecks the original gate deadline before accepting response headers', async () => {
    const test = fixture();
    const clock = vi.spyOn(test.input.edge.runtime, 'now');
    resume.mockImplementationOnce(() => {
      clock.mockReturnValue(NOW + 1000);
      return { response: Promise.resolve(new Response('</body></html>')), abort: vi.fn() };
    });
    try {
      const response = await handleDocument({ ...test.input, generation: gate(NOW + 1000) });

      expect(response.status).toBe(503);
      await expect(response.text()).resolves.not.toContain('gate values');
      expect(resume).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('serves a valid gate shell with its own original grant and no extra resume call', async () => {
    const test = fixture();
    const response = await handleDocument({ ...test.input, generation: gate(NOW + 60_000) });

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('gate values');
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it.each(['x-next-cache-tags', 'X-Next-Cache-Tags'])(
    'reads only the selected publication header (%s) without parsing unused metadata',
    (name) => {
      const test = fixture();
      const tag = `upwind:publication:v1:${ID}:${String(NOW + 60_000)}`;
      const entry = { ...test.input.entry, headers: { [name]: tag, 'x-unused': 'a\0b' } };

      expect(documentPublicationTags({ entry })).toStrictEqual([tag]);
    },
  );

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
        expect.any(Object),
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

  it.each([
    ['record', 'head'],
    ['record', 'sandbox'],
    ['build', 'head'],
    ['build', 'sandbox'],
  ] as const)(
    'keeps independently admitted passthrough after the abandoned %s expires (%s)',
    async (source, mode) => {
      const test = cachedFixture(source, mode);
      const clock = vi.spyOn(test.input.edge.runtime, 'now');

      test.passthrough.mockImplementation(() => {
        clock.mockReturnValue(test.until);
        const tag = `upwind:publication:v1:${ID}:${String(NOW + 60_000)}`;
        return Promise.resolve(
          admitPublication(new Response('fresh from runtime'), [tag], test.until),
        );
      });

      try {
        const response = await serveCachedDocument(test.input);

        expect(response.status).toBe(200);
        await expect(response.text()).resolves.toBe('fresh from runtime');
        expect(test.passthrough).toHaveBeenCalledTimes(1);
        expect(resume).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(['record', 'build'] as const)(
    'rechecks the original %s deadline when its bytes compose',
    async (source) => {
      const test = cachedFixture(source, 'resume');
      const clock = vi.spyOn(test.input.edge.runtime, 'now');
      resume.mockImplementationOnce(() => {
        clock.mockReturnValue(test.until);
        return { response: Promise.resolve(new Response('</body></html>')), abort: vi.fn() };
      });
      try {
        const response = await serveCachedDocument(test.input);

        expect(response.status).toBe(503);
        await expect(response.text()).resolves.not.toContain('old selected bytes');
        expect(test.passthrough).not.toHaveBeenCalled();
        expect(resume).toHaveBeenCalledTimes(1);
      } finally {
        clock.mockRestore();
      }
    },
  );
});
