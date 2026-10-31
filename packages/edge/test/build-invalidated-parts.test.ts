import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  decodeGenerationPack,
  encodeGenerationPack,
  policyFromBuild,
} from '@stayingupwind/core/cache';
import type { RouteEntry } from '@stayingupwind/core/manifest';
import {
  DEFAULT_DELIVERY_POLICY,
  DEFAULT_RUNTIME_CACHE_SETTINGS,
} from '@stayingupwind/host/delivery';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationLoad } from '../src/cache/generation-loader.ts';
import {
  composePagesData,
  composePayload,
  composeSegment,
  type PartInput,
} from '../src/handlers/hosted-parts.ts';
import { InvalidationMemory } from '../src/memory/invalidations.ts';

// Exercise real generation decisions and the exact build fence, with storage and dispatch mocked.
const mocks = vi.hoisted(() => {
  return {
    load: vi.fn<() => Promise<GenerationLoad>>(),
    part: vi.fn((input: { generation?: unknown }) => {
      const body = input.generation === undefined ? 'old build part' : 'current runtime part';
      return Promise.resolve(new Response(body));
    }),
    readAgain: vi.fn(),
    regenerate: vi.fn(),
  };
});

vi.mock(import('../src/cache/generation-hold.ts'), () => {
  const generationAsHeld = mocks.load;
  return { generationAsHeld, readServedAgain: mocks.readAgain };
});
vi.mock(import('../src/cache/member.ts'), () => ({ upgradesMember: () => false }));
vi.mock(import('../src/cache/partial-fallback.ts'), () => ({ partialFallbackInHand: vi.fn() }));
vi.mock(import('../src/cache/regenerate.ts'), () => {
  const shouldAsk = vi.fn(() => false);
  return { shouldAsk, triggerDetached: mocks.regenerate };
});
vi.mock(import('../src/memory/caches.ts'), () => ({ memberEntryKey: vi.fn() }));
vi.mock(import('../src/strategies/shell-loader.ts'), () => ({ finishShellBody: vi.fn() }));
vi.mock(import('../src/handlers/hosted-route.ts'), () => {
  return {
    generationKeyOf: () => ({ scopeId: 'scope', entryId: 'entry' }),
    requestAsLeft: (input: { readonly request: Request }) => {
      const headers = input.request.headers;
      return { headers, url: new URL(input.request.url) };
    },
  };
});
vi.mock(import('../src/handlers/middleware.ts'), () => {
  const dispatchedFor = vi.fn(() => 0);
  return {
    dispatchedFor,
    routedHeaders: (_edge: unknown, _rules: unknown, headers: Headers) => headers,
  };
});
vi.mock(import('../src/handlers/segment.ts'), () => ({ handleSegment: mocks.part }));

const NOW = 1_800_000_000_000;
const KEY = { scopeId: 'scope', entryId: 'entry' };
const DEPLOYMENT = 'deployment-before-scope-discovery';
const PARTS = ['payload', 'segment', 'data'] as const;
type Part = (typeof PARTS)[number];
const MISSING_LOADS = [
  { kind: 'none', lookupMs: 0 },
  { kind: 'unusable', lookupMs: 0, reason: 'corrupt' },
  { kind: 'unavailable', lookupMs: 0, detail: 'storage unavailable', held: undefined },
] satisfies GenerationLoad[];
const MISSING_PARTS = PARTS.flatMap((part) => MISSING_LOADS.map((load) => ({ part, load })));
const ROLE = { payload: 'rsc', segment: 'segment', data: 'pages-data' } as const;
const REPRESENTATION = { payload: 'rsc', segment: 'segment:/tree', data: 'pages-data' } as const;
const REASON = { payload: 'rsc-payload', segment: 'segment-prefetch', data: 'pages-data' } as const;
const MIDDLEWARE = { kind: 'skipped', reason: 'unmatched' } as const;
const BUILD_PART = {
  artifact: {
    sha256: 'a'.repeat(64),
    byteLength: 1,
    contentType: 'text/plain',
    encoding: 'identity' as const,
  },
};

function fixture(kind: Part) {
  const headers = new Headers({ rsc: '1' });
  if (kind === 'segment') headers.set('next-router-segment-prefetch', '/tree');
  const request = new Request<unknown, IncomingRequestCfProperties>(
    'https://app.example/update-tag-test',
    {
      headers,
    },
  );
  const invalidations = new InvalidationMemory(() => NOW);
  const passthrough = vi.fn(() => Promise.resolve(new Response('fresh Function part')));
  const input: PartInput = {
    request,
    url: new URL(request.url),
    edge: {
      app: { deploymentId: DEPLOYMENT },
      // A host with no scope signals, which a generation read then looks at none of.
      host: {},
      runtime: { now: () => NOW, memory: { invalidations, generations: new Map() } },
      policy: {
        ...DEFAULT_DELIVERY_POLICY,
        runtimeCache: { ...DEFAULT_RUNTIME_CACHE_SETTINGS, generations: 'on' },
      },
    } as unknown as PartInput['edge'],
    manifest: {
      headerRules: [],
      foldedHeaderRules: [],
      dynamicRoutes: [],
    } as unknown as PartInput['manifest'],
    resolved: {} as PartInput['resolved'],
    passthrough,
  };
  const entry: RouteEntry = {
    pathname: '/update-tag-test',
    status: 200,
    headers: {},
    shell: BUILD_PART.artifact,
    cache: {
      entryId: KEY.entryId,
      kind: kind === 'data' ? 'pages' : 'app-page',
      delivery: 'complete',
      buildTags: [{ kind: 'next-explicit', value: 'test-update-tag' }],
    },
    payload: BUILD_PART,
    segments: { '/tree': BUILD_PART },
    pagesData: BUILD_PART,
  };
  return { input, entry, invalidations, passthrough };
}

function answer(kind: Part, sample: ReturnType<typeof fixture>): Promise<Response> {
  const compose = {
    data: composePagesData,
    payload: composePayload,
    segment: composeSegment,
  };
  return compose[kind](sample.input, sample.entry, MIDDLEWARE);
}

async function freshLoad(
  kind: Part,
  source: 'runtime' | 'build' = 'runtime',
): Promise<GenerationLoad> {
  const html = new TextEncoder().encode('current generation');
  const bytes = encodeGenerationPack(
    {
      schemaVersion: 1,
      ...KEY,
      generationId: 'current',
      seq: 2,
      revision: 7,
      source,
      kind: kind === 'data' ? 'pages' : 'app-page',
      route: '/update-tag-test',
      pathname: '/update-tag-test',
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: false }),
      status: 200,
      headers: {},
      tags: [{ kind: 'next-explicit', value: 'test-update-tag' }],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [
        {
          artifactId: 'part',
          sha256: 'b'.repeat(64),
          byteLength: 1,
          contentType: 'text/plain',
          encoding: 'identity',
          role: ROLE[kind],
          representationKey: REPRESENTATION[kind],
          storageRef: 'blobs/current-part',
        },
      ],
    },
    html,
    undefined,
  );
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('current router-part fixture did not decode');
  return {
    kind: 'generation',
    pack: decoded.pack,
    source: 'memory',
    lookupMs: 0,
    readBytes: undefined,
  };
}

describe('router parts after a known immediate build invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(MISSING_PARTS)(
    'rejects the immutable $part part when the matching record is $load.kind',
    async ({ part: kind, load }) => {
      const sample = fixture(kind);
      mocks.load.mockResolvedValue(load);
      sample.invalidations.takeResponse(KEY.scopeId, ['test-update-tag'], 7);

      const response = await answer(kind, sample);

      await expect(response.text()).resolves.toBe('fresh Function part');
      expect(sample.passthrough).toHaveBeenCalledExactlyOnceWith(
        REASON[kind],
        MIDDLEWARE,
        sample.entry.pathname,
        undefined,
      );
      expect(mocks.part).not.toHaveBeenCalled();
    },
  );

  it.each(PARTS)('keeps unrelated immediate bounds off a %s build part', async (kind) => {
    const sample = fixture(kind);
    mocks.load.mockResolvedValue({ kind: 'none', lookupMs: 0 });
    sample.invalidations.takeResponse(KEY.scopeId, ['other-tag'], 7);

    const response = await answer(kind, sample);

    await expect(response.text()).resolves.toBe('old build part');
    expect(sample.passthrough).not.toHaveBeenCalled();
  });

  it.each(MISSING_PARTS)(
    'binds a provisional Action receipt before selecting a $part build part from $load.kind',
    async ({ part: kind, load }) => {
      const sample = fixture(kind);
      mocks.load.mockResolvedValue(load);
      sample.invalidations.takeResponse(DEPLOYMENT, ['test-update-tag'], 7);

      const response = await answer(kind, sample);

      await expect(response.text()).resolves.toBe('fresh Function part');
      expect(sample.passthrough).toHaveBeenCalledExactlyOnceWith(
        REASON[kind],
        MIDDLEWARE,
        sample.entry.pathname,
        undefined,
      );
      expect(mocks.part).not.toHaveBeenCalled();
      expect(sample.invalidations.of(KEY.scopeId)?.tags.get('test-update-tag')).toBe(7);
    },
  );

  it.each(PARTS)(
    'does not turn windowed invalidation into a foreground %s build render',
    async (kind) => {
      const sample = fixture(kind);
      mocks.load.mockResolvedValue({ kind: 'none', lookupMs: 0 });
      sample.invalidations.takeEach(KEY.scopeId, {
        atOnce: [],
        windowed: [{ tag: 'test-update-tag', revision: 7 }],
      });

      const response = await answer(kind, sample);

      await expect(response.text()).resolves.toBe('old build part');
      expect(sample.passthrough).not.toHaveBeenCalled();
    },
  );

  it.each(PARTS)(
    'accepts a current build %s record without reapplying the absence-only fence',
    async (kind) => {
      const sample = fixture(kind);
      mocks.load.mockResolvedValue(await freshLoad(kind, 'build'));
      sample.invalidations.takeResponse(KEY.scopeId, ['test-update-tag'], 7);

      const response = await answer(kind, sample);

      await expect(response.text()).resolves.toBe('old build part');
      expect(sample.passthrough).not.toHaveBeenCalled();
      expect(mocks.load).toHaveBeenCalledTimes(1);
      expect(mocks.readAgain).not.toHaveBeenCalled();
    },
  );

  it.each(PARTS)(
    'keeps independent build %s records available under publication admission',
    async (kind) => {
      const sample = fixture(kind);
      sample.input.manifest.publication = {
        version: 1,
        identities: ['a'.repeat(64)],
        routes: ['/update-tag-test'],
        independentBuild: ['/update-tag-test'],
      };
      mocks.load.mockResolvedValue(await freshLoad(kind, 'build'));

      const response = await answer(kind, sample);

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe('old build part');
      expect(sample.passthrough).not.toHaveBeenCalled();
      expect(mocks.load).toHaveBeenCalledTimes(1);
    },
  );

  it.each(PARTS)(
    'serves a current runtime %s with no foreground dispatch or extra record lookup',
    async (kind) => {
      const sample = fixture(kind);
      mocks.load.mockResolvedValue(await freshLoad(kind));
      sample.invalidations.takeResponse(KEY.scopeId, ['test-update-tag'], 7);

      const response = await answer(kind, sample);

      await expect(response.text()).resolves.toBe('current runtime part');
      expect(sample.passthrough).not.toHaveBeenCalled();
      expect(mocks.load).toHaveBeenCalledExactlyOnceWith(
        sample.input.edge,
        KEY,
        sample.input.edge.policy.runtimeCache,
        {},
      );
      expect(mocks.regenerate).not.toHaveBeenCalled();
      expect(mocks.readAgain).not.toHaveBeenCalled();
    },
  );
});
