import { sha256Hex } from '@stayingupwind/core/artifact';
import { deriveEntry, encodeGenerationPack, policyFromBuild } from '@stayingupwind/core/cache';
import { buildProjectManifest, type RouteEntry } from '@stayingupwind/core/manifest';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type DispatchInput,
  foregroundDocument,
  regenerationHeaders,
  shouldAsk,
  triggerDetached,
} from '../src/cache/regenerate.ts';
import { followResume } from '../src/handlers/document-upstream.ts';
import { type DocumentInput, handleDocument } from '../src/handlers/document.ts';
import { type HostedDocumentInput, routeHostedDocument } from '../src/handlers/hosted-document.ts';
import { middlewareMatches, runMiddleware } from '../src/handlers/middleware.ts';
import type { SegmentInput } from '../src/handlers/segment.ts';
import { createEdgeMemory, memberEntryKey } from '../src/memory/caches.ts';
import type { EdgeContext } from '../src/strategies/context.ts';
import { loadShell, type ShellLoadResult } from '../src/strategies/shell-loader.ts';

function documentModule() {
  return {
    handleDocument: vi.fn((input: DocumentInput) => {
      input.generation?.onServed?.();
      return Promise.resolve(new Response(input.generation?.pack.header.pathname ?? 'build'));
    }),
  };
}
function segmentModule() {
  return {
    handleSegment: vi.fn((input: SegmentInput) => {
      const response = new Response(input.segment.artifact.sha256);
      return Promise.resolve(response);
    }),
  };
}
vi.mock(import('../src/handlers/document.ts'), documentModule);
vi.mock(import('../src/handlers/segment.ts'), segmentModule);
vi.mock(import('../src/handlers/middleware.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal()),
    middlewareMatches: vi.fn(() => false),
    runMiddleware: vi.fn(),
  };
});
vi.mock(import('../src/strategies/shell-loader.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal()),
    loadShell: vi.fn<() => Promise<ShellLoadResult>>(() => Promise.resolve({ kind: 'missing' })),
  };
});
vi.mock(import('../src/cache/regenerate.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal()),
    foregroundDocument: vi.fn((edge: EdgeContext, input: DispatchInput) => {
      return Promise.resolve(
        new Response('foreground', {
          headers: regenerationHeaders(edge, 'foreground', input.target),
        }),
      );
    }),
    triggerDetached: vi.fn(() => ({ record: vi.fn() })),
  };
});

const NOW = 1_800_000_000_000;
const SCOPE = 'dpl_partial_wiring';
const ROUTE = '/[slug]';
const ARTIFACT = {
  sha256: 'a'.repeat(64),
  byteLength: 10,
  contentType: 'text/html',
  encoding: 'identity' as const,
};
const ENTRY: RouteEntry = {
  pathname: ROUTE,
  status: 200,
  shell: ARTIFACT,
  headers: {},
  prerenderId: ROUTE,
  partialFallback: { route: ROUTE },
  segments: { '/_tree': { artifact: ARTIFACT } },
  payload: { artifact: ARTIFACT },
  bypassFor: [{ type: 'header', key: 'next-action' }],
};

async function record(stale = false): Promise<ArrayBuffer> {
  const { entryId } = await deriveEntry(SCOPE, {
    kind: 'app-page',
    route: ROUTE,
    pathname: '/two',
  });
  const html = new TextEncoder().encode('completed two');
  const postponed = new TextEncoder().encode('resume two');
  return new Uint8Array(
    encodeGenerationPack(
      {
        schemaVersion: 1,
        scopeId: SCOPE,
        entryId,
        generationId: 'gen_two',
        seq: 1,
        revision: 1,
        source: 'runtime',
        kind: 'app-page',
        route: ROUTE,
        pathname: '/two',
        cacheTimestamp: stale ? NOW - 2000 : NOW,
        producedAt: NOW,
        policy: policyFromBuild({ initialRevalidate: 1, initialExpiration: 300 }),
        status: 200,
        headers: { 'content-type': 'text/html' },
        tags: [],
        htmlSha256: await sha256Hex(html),
        htmlLength: html.byteLength,
        postponedSha256: await sha256Hex(postponed),
        postponedLength: postponed.byteLength,
        artifacts: [
          {
            artifactId: 'rsc_two',
            role: 'rsc',
            representationKey: 'rsc',
            sha256: 'c'.repeat(64),
            byteLength: 3,
            contentType: 'text/x-component',
            encoding: 'identity',
            storageRef: 'blobs/two-rsc',
          },
        ],
      },
      html,
      postponed,
    ),
  ).buffer;
}

function fixture(
  currentRecord = vi.fn<() => Promise<ArrayBuffer | undefined>>(() => Promise.resolve(undefined)),
  entry = ENTRY,
) {
  const tasks: Promise<unknown>[] = [];
  const clock = { now: NOW };
  const kv = vi.fn(() => Promise.resolve(null));
  const policy = {
    ...DEFAULT_DELIVERY_POLICY,
    runtimeCache: {
      generations: 'on' as const,
      holdMs: 5000,
      regenerateCooldownMs: 5000,
      concreteUpgrade: false,
    },
  };
  const manifest = buildProjectManifest({
    projectId: 'project',
    runId: 'run',
    originHost: 'app.test',
    generatedAt: '2026-10-18T00:00:00.000Z',
    deployment: { assetSetHash: 'assets', observedAt: '2026-10-18T00:00:00.000Z' },
    app: { deploymentId: SCOPE, scriptName: 'app' },
    cache: { keySchemaVersion: 1, scopeId: SCOPE },
    routes: [entry],
  });
  const edge = {
    env: { CACHE_STATE: { get: kv } },
    ctx: {
      waitUntil: (task: Promise<unknown>) => {
        tasks.push(task);
      },
    },
    runtime: { now: () => clock.now, memory: createEdgeMemory(() => clock.now) },
    policy,
    host: { currentRecord, credentials: { cookies: [], headers: [] } },
    app: manifest.app,
    manifestId: 'manifest',
    projectId: 'project',
    validated: false,
  } as unknown as EdgeContext;
  const passthrough = vi.fn(() => Promise.resolve(new Response('function')));
  const input = (pathname = '/two', init: RequestInit = {}): HostedDocumentInput => {
    const request = new Request(`https://app.test${pathname}`, init);
    return {
      request,
      url: new URL(request.url),
      edge,
      manifest,
      classification: { kind: 'document', entry },
      classifiedHeaders: request.headers,
      passthrough,
      resolved: { shell: { id: 'memory', getShell: vi.fn() } },
    } as unknown as HostedDocumentInput;
  };
  return {
    edge,
    input,
    passthrough,
    kv,
    clock,
    currentRecord,
    tasks,
    drain: async () => {
      while (tasks.length > 0) await Promise.all(tasks.splice(0));
    },
  };
}

function lastDocument(): DocumentInput {
  const call = vi.mocked(handleDocument).mock.calls.at(-1);
  if (call === undefined) throw new Error('the request must compose a document');
  return call[0];
}

async function reservedDocument(kind: 'build' | 'held', signal: AbortSignal) {
  const test =
    kind === 'build' ? fixture() : fixture(vi.fn().mockResolvedValue(await record(true)));
  if (kind === 'held') {
    await routeHostedDocument(test.input());

    await test.drain();

    test.clock.now = NOW + 5001;
  }
  await routeHostedDocument(test.input('/two', { signal }));
  return { test, document: lastDocument() };
}

function asksForRegeneration(document: DocumentInput): boolean {
  return (document.generation?.regeneration ?? document.buildRegeneration) !== undefined;
}

function gatedInput(
  sample: ReturnType<typeof fixture>,
  kind: 'head' | 'validation' | 'disabled' | 'bypass',
): HostedDocumentInput {
  if (kind === 'head') return sample.input('/two', { method: 'HEAD' });
  if (kind === 'bypass') return sample.input('/two', { headers: { 'next-action': 'action' } });
  const initial = sample.input();
  if (kind === 'validation') return { ...initial, edge: { ...initial.edge, validated: true } };
  return {
    ...initial,
    edge: {
      ...initial.edge,
      policy: {
        ...initial.edge.policy,
        runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'off' },
      },
    },
  };
}

describe('partial fallback document and router wiring', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe.each(['build', 'held'] as const)('%s shell cooldown', (kind) => {
    it.each(['rejection', 'clientAbort'] as const)(
      'permits an immediate retry after a pre-answer %s',
      async (failure) => {
        const client = new AbortController();
        const { test, document } = await reservedDocument(kind, client.signal);

        expect(asksForRegeneration(document)).toBe(true);

        const pending = Promise.withResolvers<Response>();
        const error = new Error('resume did not answer');
        const followed = followResume(document, {
          response: pending.promise,
          abort: () => {
            pending.reject(error);
          },
        });

        const abandon = {
          rejection: () => {
            pending.reject(error);
          },
          clientAbort: () => {
            client.abort();
          },
        };
        abandon[failure]();
        await followed.upstream;
        followed.clientLeft();
        await routeHostedDocument(test.input());

        expect(asksForRegeneration(lastDocument())).toBe(true);

        await test.drain();
      },
    );

    it('preserves the cooldown after the runtime answers the resume', async () => {
      const client = new AbortController();
      const { test, document } = await reservedDocument(kind, client.signal);
      const followed = followResume(document, {
        response: Promise.resolve(new Response()),
        abort: vi.fn(),
      });
      await followed.upstream;
      client.abort();
      followed.clientLeft();
      await routeHostedDocument(test.input());

      expect(asksForRegeneration(lastDocument())).toBe(false);

      await test.drain();
    });

    it('preserves a newer reservation when the older resume rejects', async () => {
      const { test, document } = await reservedDocument(kind, new AbortController().signal);
      const pending = Promise.withResolvers<Response>();
      const followed = followResume(document, { response: pending.promise, abort: vi.fn() });
      shouldAsk(test.edge, memberEntryKey(SCOPE, ROUTE, '/two'), {
        ...DEFAULT_RUNTIME_CACHE_SETTINGS,
        regenerateCooldownMs: 0,
      });
      pending.reject(new Error('older resume failed'));
      await followed.upstream;
      followed.clientLeft();
      await routeHostedDocument(test.input());

      expect(asksForRegeneration(lastDocument())).toBe(false);

      await test.drain();
    });
  });

  it('serves the first build shell while an authority read remains pending, without inventing a generation', async () => {
    const gate = Promise.withResolvers<ArrayBuffer | undefined>();
    const test = fixture(vi.fn(() => gate.promise));
    const response = await routeHostedDocument(test.input());

    await expect(response.text()).resolves.toBe('build');
    expect(lastDocument().generation).toBeUndefined();
    expect(lastDocument().buildRegeneration).toMatchObject({
      'x-arkor-regenerate': 'background',
      'x-arkor-cache-route': ROUTE,
      'x-arkor-cache-upgrade': '1',
    });
    expect(lastDocument().buildRegeneration).not.toHaveProperty('x-arkor-generation');

    gate.resolve(undefined);

    await test.drain();
  });

  it('asks once per completion cooldown even after its key has been derived', async () => {
    const test = fixture();
    await routeHostedDocument(test.input());

    await test.drain();

    await routeHostedDocument(test.input());

    expect(lastDocument().buildRegeneration).toBeUndefined();
    expect(test.kv).not.toHaveBeenCalled();
  });

  it('keeps the completion cooldown after adopting a record which becomes stale within it', async () => {
    const test = fixture(vi.fn().mockResolvedValue(await record()));
    await routeHostedDocument(test.input());

    await test.drain();

    test.clock.now += 1001;

    await routeHostedDocument(test.input());

    expect(lastDocument().generation?.validity).toBe('stale');
    expect(lastDocument().generation?.regeneration).toBeUndefined();

    test.clock.now = NOW + 5001;

    await routeHostedDocument(test.input());

    expect(lastDocument().generation?.regeneration).toHaveProperty(
      'x-arkor-regenerate',
      'background',
    );

    await test.drain();
  });

  it('shares the initial HTML completion cooldown with stale Flight prefetches', async () => {
    const test = fixture(vi.fn().mockResolvedValue(await record()));
    await routeHostedDocument(test.input());

    await test.drain();

    const prefetch = () => {
      const input = test.input('/two', { headers: { rsc: '1', 'next-router-prefetch': '1' } });
      return routeHostedDocument({
        ...input,
        classification: { kind: 'rsc-payload', entry: ENTRY },
      });
    };

    test.clock.now += 1001;

    await prefetch();

    expect(triggerDetached).not.toHaveBeenCalled();

    test.clock.now = NOW + 5001;

    await prefetch();

    expect(vi.mocked(triggerDetached)).toHaveBeenCalledTimes(1);

    await test.drain();
  });

  it.each([
    { keyed: false, expired: false },
    { keyed: true, expired: false },
    { keyed: false, expired: true },
    { keyed: true, expired: true },
  ])(
    'preserves completion identity when keyed=$keyed and expired=$expired',
    async ({ keyed, expired }) => {
      const entry: RouteEntry = {
        ...ENTRY,
        partialFallback: { route: ROUTE, ...(keyed && { keyedBy: ['slug'] }) },
      };
      const test = fixture(vi.fn().mockResolvedValue(await record()), entry);
      await routeHostedDocument(test.input());

      await test.drain();

      test.clock.now += expired ? 301_000 : 5001;

      const response = await routeHostedDocument(test.input());
      const headers = expired
        ? response.headers
        : new Headers(lastDocument().generation?.regeneration);

      const { entryId } = await deriveEntry(SCOPE, {
        kind: 'app-page',
        route: ROUTE,
        pathname: '/two',
      });
      const member = expired
        ? vi.mocked(foregroundDocument).mock.calls.at(-1)?.[1].target.member
        : lastDocument().generation?.member;

      expect(headers.get('x-arkor-cache-entry')).toBe(entryId);
      expect(headers.get('x-arkor-cache-upgrade')).toBe(keyed ? null : '1');
      expect(member).toBe(true);

      await test.drain();
    },
  );

  it('keeps an unused middleware shell preload alive when the completed record answers first', async () => {
    const test = fixture(vi.fn().mockResolvedValue(await record()));
    await routeHostedDocument(test.input());

    await test.drain();

    const pending = Promise.withResolvers<ShellLoadResult>();
    vi.mocked(loadShell).mockReturnValueOnce(pending.promise);
    vi.mocked(middlewareMatches).mockReturnValueOnce(true);
    const input = test.input();
    vi.mocked(runMiddleware).mockResolvedValueOnce({
      kind: 'continue',
      url: input.url,
      rewritten: false,
      requestHeaders: input.request.headers,
      responseHeaders: new Headers(),
      setCookie: undefined,
      middlewareMs: 0,
    });

    const response = await routeHostedDocument(input);

    await expect(response.text()).resolves.toBe('/two');
    expect(vi.mocked(loadShell)).toHaveBeenCalledTimes(1);
    expect(test.tasks).toContain(pending.promise);

    pending.resolve({ kind: 'missing' });

    await test.drain();
  });

  it('serves the completed shell on the next request and never borrows it for another URL', async () => {
    const test = fixture(vi.fn().mockResolvedValue(await record()));
    await routeHostedDocument(test.input());

    await test.drain();

    const response = await routeHostedDocument(test.input());

    await expect(response.text()).resolves.toBe('/two');
    expect(lastDocument().generation?.pack.header.pathname).toBe('/two');
    expect(lastDocument().buildRegeneration).toBeUndefined();

    const unrelated = await routeHostedDocument(test.input('/three'));

    await expect(unrelated.text()).resolves.toBe('build');
    expect(lastDocument().generation).toBeUndefined();
    expect(test.kv).not.toHaveBeenCalled();

    await test.drain();
  });

  it('refreshes a stale completed record through its authority rather than the ordinary KV loader', async () => {
    const test = fixture(vi.fn().mockResolvedValue(await record(true)));
    await routeHostedDocument(test.input());

    await test.drain();

    test.clock.now += 5001;

    await routeHostedDocument(test.input());

    await test.drain();

    expect(lastDocument().generation?.validity).toBe('stale');
    expect(lastDocument().generation?.regeneration).toHaveProperty('x-arkor-generation', 'gen_two');
    expect(test.kv).not.toHaveBeenCalled();
  });

  it.each(['head', 'validation', 'disabled', 'bypass'] as const)(
    'does not start an upgrade for a %s request',
    async (kind) => {
      const test = fixture();
      await routeHostedDocument(gatedInput(test, kind));

      await test.drain();

      expect(test.currentRecord).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(handleDocument)
          .mock.calls.every(([document]) => document.buildRegeneration === undefined),
      ).toBe(true);
    },
  );

  it('uses only the completed member’s Flight and leaves another member to the Function', async () => {
    const test = fixture(vi.fn().mockResolvedValue(await record()));
    await routeHostedDocument(test.input());

    await test.drain();

    const initial = test.input('/two', { headers: { rsc: '1', 'next-router-prefetch': '1' } });
    const response = await routeHostedDocument({
      ...initial,
      classification: { kind: 'rsc-payload', entry: ENTRY },
    });

    await expect(response.text()).resolves.toBe('c'.repeat(64));

    const other = test.input('/three', { headers: { rsc: '1', 'next-router-prefetch': '1' } });
    const missing = await routeHostedDocument({
      ...other,
      classification: { kind: 'rsc-payload', entry: ENTRY },
    });

    await expect(missing.text()).resolves.toBe('function');
    expect(test.kv).not.toHaveBeenCalled();

    await test.drain();
  });
});
