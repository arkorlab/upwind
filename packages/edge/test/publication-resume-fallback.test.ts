import { sha256Hex } from '@stayingupwind/core/artifact';
import { resourceSnapshotTag } from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import { parseResumePublicationHeader, PUBLICATION_RESUME_HEADER } from '@stayingupwind/core/paas';
import { NEXT_RESUME_HEADER } from '@stayingupwind/core/request';
import { DEFAULT_DELIVERY_POLICY, type ShellRead } from '@stayingupwind/host/delivery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleDocument, type DocumentInput } from '../src/handlers/document.ts';
import { observeRequestMetric } from '../src/handlers/observer.ts';
import { fetchUpstream } from '../src/handlers/upstream.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import type { EdgeMetric } from '../src/observability/metrics.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import type { ShellLoadResult } from '../src/strategies/shell-loader.ts';

vi.mock(import('../src/handlers/upstream.ts'), async (original) => {
  const imported = await original();
  return { ...imported, fetchUpstream: vi.fn() };
});

const NOW = 1_800_000_000_000;
const ID = 'a'.repeat(64);
const GRANT = `upwind:publication:v1:${ID}:${String(NOW + 60_000)}`;
const WITNESS = resourceSnapshotTag({ resourceId: 'b'.repeat(64), version: 7 });

function fixture(tags: readonly string[]) {
  const html = new TextEncoder().encode('<html><body>old selected prefix');
  const entry: RouteEntry = {
    pathname: '/items',
    status: 200,
    headers: { 'content-type': 'text/html', 'x-selected-only': 'old' },
    prerenderId: '/items',
    shell: {
      sha256: 'a'.repeat(64),
      byteLength: html.byteLength,
      contentType: 'text/html',
      encoding: 'identity',
    },
    cache: {
      entryId: 'entry',
      delivery: 'resume',
      kind: 'app-page',
      route: '/items',
      buildTags: tags.map((value) => ({ kind: 'next-explicit', value })),
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
      version: 3 as const,
      valueObservers: true as const,
      resourceSnapshots: true as const,
      identities: [ID],
      routes: ['/items'],
    },
  };
  const tasks: Promise<unknown>[] = [];
  const metric = vi.fn<EdgeContext['host']['observer']['metric']>();
  const edge = {
    runtime: { now: () => NOW, memory: createEdgeMemory(() => NOW) },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    policy: DEFAULT_DELIVERY_POLICY,
    host: {
      names: {},
      credentials: { cookies: [], headers: [] },
      observer: { metric, recordServed: vi.fn(), imageTransformed: vi.fn() },
    },
    forwarding: { previewDomain: 'test', previewHost: 'site.test', clientIp: undefined },
    validated: false,
    privateDelivery: false,
    cacheApi: false,
    projectId: 'project',
    manifestId: 'manifest',
    timings: {},
    app: manifest.app,
  } as unknown as EdgeContext;
  const passthrough = vi.fn<DocumentInput['passthrough']>(() =>
    Promise.resolve(new Response('fresh complete document', { headers: { 'x-fresh': 'yes' } })),
  );
  const onBuildAbandoned = vi.fn();
  const input: DocumentInput = {
    request: new Request('https://site.test/items', { headers: { 'accept-encoding': 'identity' } }),
    entry,
    manifest,
    edge,
    middleware: undefined,
    generation: undefined,
    shellRead: Promise.resolve({
      kind: 'ok',
      read: { bytes: html, source: 'memory', latencyMs: 0 },
    }),
    resolved: {
      policy: DEFAULT_DELIVERY_POLICY,
      shell: { id: 'kv', getShell: () => Promise.resolve(undefined) },
      assets: { id: 'passthrough', handle: () => Promise.reject(new Error('No asset requested.')) },
    },
    onBuildAbandoned,
    passthrough,
  };
  return { input, passthrough, onBuildAbandoned, tasks, metric };
}

function recordFallback(world: ReturnType<typeof fixture>, input: DocumentInput): void {
  world.passthrough.mockImplementation((_reason, _middleware, _route, waited) => {
    observeRequestMetric({ ...input.edge, abandonedShells: waited?.abandonedShells }, {
      subrequests: 1,
    } as EdgeMetric);
    return Promise.resolve(new Response('fresh complete document'));
  });
}

async function encodedFixture(source: 'backend' | 'missing' | 'memory') {
  const world = fixture([GRANT, WITNESS, 'resource:unsafe\0tag']);
  const compressed = new Blob(['encoded shell'])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
  const sha256 = await sha256Hex(bytes);
  const pending = Promise.withResolvers<ShellRead | undefined>();
  const getShell = vi.fn(() => pending.promise);
  if (source === 'memory')
    world.input.edge.runtime.memory.shells.set(sha256, bytes, bytes.byteLength);
  const policy = {
    ...DEFAULT_DELIVERY_POLICY,
    shell: { ...DEFAULT_DELIVERY_POLICY.shell, memoryLru: true, cacheApiLayer: false },
  };
  const input: DocumentInput = {
    ...world.input,
    request: new Request(world.input.request, { headers: { 'accept-encoding': 'gzip' } }),
    edge: { ...world.input.edge, policy },
    entry: {
      ...world.input.entry,
      shellEncodings: {
        gzip: {
          sha256,
          byteLength: bytes.byteLength,
          contentType: 'text/html',
          encoding: 'gzip',
          crc32: 0,
        },
      },
    },
    resolved: { ...world.input.resolved, policy, shell: { id: 'kv', getShell } },
  };
  recordFallback(world, input);
  return {
    ...world,
    input,
    getShell,
    finish: () => {
      pending.resolve(source === 'missing' ? undefined : { bytes, source: 'kv', latencyMs: 0 });
    },
  };
}

describe('selected publication handoff refusal', () => {
  beforeEach(() => {
    vi.mocked(fetchUpstream).mockReset();
    vi.mocked(fetchUpstream).mockResolvedValue(new Response('</body></html>'));
  });

  it('returns an undispatched build regeneration ask and accounts for its late shell after expiry', async () => {
    const world = fixture([`upwind:publication:v1:${ID}:${String(NOW)}`, WITNESS]);
    const pending = Promise.withResolvers<ShellLoadResult>();
    const input: DocumentInput = { ...world.input, shellRead: pending.promise };
    recordFallback(world, input);
    const response = await handleDocument(input);

    await expect(response.text()).resolves.toBe('fresh complete document');

    pending.resolve({ kind: 'ok', read: { bytes: new Uint8Array(), source: 'kv', latencyMs: 0 } });
    await Promise.all(world.tasks);

    expect(world.onBuildAbandoned).toHaveBeenCalledTimes(1);
    expect(world.metric.mock.calls[0]?.[0].subrequests).toBe(2);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  it.each([
    { source: 'backend' as const, calls: 1, subrequests: 2 },
    { source: 'missing' as const, calls: 1, subrequests: 2 },
    { source: 'memory' as const, calls: 0, subrequests: 1 },
  ])(
    'accounts for a discarded $source encoding without waiting to send the fresh answer',
    async ({ source, calls, subrequests }) => {
      const world = await encodedFixture(source);
      const response = await handleDocument(world.input);

      await expect(response.text()).resolves.toBe('fresh complete document');

      world.finish();
      await Promise.all(world.tasks);

      expect(world.getShell).toHaveBeenCalledTimes(calls);
      expect(world.metric.mock.calls[0]?.[0].subrequests).toBe(subrequests);
    },
  );

  it.each([
    {
      name: 'oversized valid witness union',
      tags: [
        GRANT,
        WITNESS,
        ...Array.from({ length: 40 }, (_, id) => `resource:${String(id)}:${'x'.repeat(220)}`),
      ],
    },
    { name: 'unsafe canonical resource', tags: [GRANT, WITNESS, 'resource:with\0metadata'] },
  ])(
    'renders a fresh whole document for $name without sending the old prefix',
    async ({ tags }) => {
      const world = fixture(tags);
      const response = await handleDocument(world.input);

      await expect(response.text()).resolves.toBe('fresh complete document');
      expect(response.headers.has('x-selected-only')).toBe(false);
      expect(response.headers.get('x-fresh')).toBe('yes');
      expect(world.passthrough).toHaveBeenCalledExactlyOnceWith(
        'publication-handoff-unavailable',
        undefined,
        '/items',
        expect.any(Object),
      );
      expect(world.onBuildAbandoned).toHaveBeenCalledTimes(1);
      expect(fetchUpstream).not.toHaveBeenCalled();

      await Promise.all(world.tasks);
    },
  );

  it('retains every selected witness and original bound on a resumable document', async () => {
    const tags = [GRANT, WITNESS, 'resource:original'];
    const world = fixture(tags);
    const response = await handleDocument(world.input);

    await expect(response.text()).resolves.toContain('old selected prefix');
    expect(world.passthrough).not.toHaveBeenCalled();
    expect(fetchUpstream).toHaveBeenCalledTimes(1);

    const request = vi.mocked(fetchUpstream).mock.calls[0]?.[2];

    expect(request?.headers.get(NEXT_RESUME_HEADER)).toBe('1');
    expect(
      parseResumePublicationHeader(request?.headers.get(PUBLICATION_RESUME_HEADER) ?? null),
    ).toStrictEqual([GRANT, 'resource:original', WITNESS]);

    await Promise.all(world.tasks);
  });

  it('does not hide an unrelated continuation construction failure', async () => {
    const world = fixture([GRANT, WITNESS]);
    vi.mocked(fetchUpstream).mockImplementationOnce(() => {
      throw new TypeError('Unrelated construction failure.');
    });

    await expect(handleDocument(world.input)).rejects.toThrow('Unrelated construction failure.');
    expect(world.passthrough).not.toHaveBeenCalled();
  });
});
