import { createHash } from 'node:crypto';

import type { Prerender } from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  encodeGenerationPack,
  packBodyDigests,
  type RouteEntryDescriptor,
  sharedShellTagOf,
} from '@stayingupwind/core/cache';
import {
  CACHE_OUTCOME_HEADER,
  CACHE_ROUTE_HEADER,
  CACHE_UPGRADE_HEADER,
  REGENERATE_HEADER,
  RESUME_PRERENDER_HEADER,
} from '@stayingupwind/core/paas';
import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import type { CacheHost, CommitRequest } from '../src/cache/host.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler, type InvokeInput } from '../src/node-bridge.ts';
import { getStore, type Store } from '../src/store.ts';

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const NOW = 1_800_000_000_000;
const HOLD_MS = 5000;
const ENTRIES = 64;
const SCOPE = 'partial-fallback';
const ROUTE = '/[slug]';
const FALLBACK = '<main><div data-fallback="true">Loading...</div>';
const UPGRADED = '<main><div id="slug" data-slug="two">two</div>Custom Data</main>';
const FLIGHT = 'flight:two';
const encoder = new TextEncoder();
const handler: NodeHandler = () => Promise.resolve();

function frozen(): number {
  return NOW;
}

function unasked(): Promise<never> {
  return Promise.reject(new Error('not asked by a partial fallback upgrade'));
}

/** Next.js 16.4's partialPrefetching fixture: /one was built; /two first gets this shell. */
function deployment(route = ROUTE): Store {
  const shell: Prerender = {
    id: route,
    route,
    pathname: route,
    parentOutputId: route,
    groupId: 1,
    routeType: 'fallback',
    response: 'initial',
    compute: 'resuming',
    renderingMode: 'PARTIALLY_STATIC',
    partialFallback: true,
    allowQuery: ['nxtPslug'],
    body: { sha256: 'html', byteLength: FALLBACK.length, contentType: 'text/html' },
    postponed: { sha256: 'state', byteLength: 5, contentType: 'application/json' },
    initialRevalidate: false,
  };
  const flight: Prerender = {
    ...shell,
    id: `${route}.rsc`,
    pathname: `${route}.rsc`,
    partialFallback: undefined,
    body: { sha256: 'flight', byteLength: 14, contentType: 'text/x-component' },
  };
  const nested = route !== ROUTE;
  const dynamic = {
    sourceRegex: nested
      ? '^/(?<nxtPslug>[^/]+?)/(?<nxtPid>[^/]+?)(?:/)?$'
      : '^/(?<nxtPslug>[^/]+?)(?:/)?$',
    destination: `${route}?nxtPslug=$nxtPslug${nested ? '&nxtPid=$nxtPid' : ''}`,
  };
  const prerenders = [shell, flight];
  const blobs: Record<string, string> = {
    html: FALLBACK,
    state: 'state',
    flight: 'flight:fallback',
  };
  return {
    manifest: {
      buildId: 'build',
      deploymentId: SCOPE,
      config: { basePath: '', i18n: null, cacheComponents: true, partialPrefetching: true },
      entrypoints: [{ id: route, pathname: route, kind: 'app-page' }],
      prerenders,
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [dynamic],
        onMatch: [],
        fallback: [],
        rsc: {
          header: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
        },
      },
    },
    pathnames: [route],
    slashSpellings: new Map(),
    dynamicRoutes: [dynamic],
    staticFiles: new Map(),
    shellsByRoute: new Map([
      [
        route,
        {
          pages: new Map(),
          patterns: [
            {
              pattern: nested ? /^\/[^/]+\/[^/]+\/?$/u : /^\/[^/]+\/?$/u,
              prerender: shell,
            },
          ],
        },
      ],
    ]),
    prerendersById: new Map(prerenders.map((each) => [each.id, each])),
    prerendersByPathname: new Map(prerenders.map((each) => [each.pathname, each])),
    renderedPages: new Set(),
    readBlob: (sha256: string) => encoder.encode(blobs[sha256]),
  } as unknown as Store;
}

/** The real lease, capture, upload, publish and record-reader paths run over this in-memory host. */
function cache() {
  const attempts = new Map<string, { entryId: string; descriptor: RouteEntryDescriptor }>();
  const artifacts = new Map<string, Uint8Array>();
  const records = new Map<string, Uint8Array>();
  const commits: CommitRequest[] = [];
  const startAttempt = vi.fn<CacheHost['startAttempt']>(async ({ entry }) => {
    const { entryId } = await deriveEntry(SCOPE, entry);
    const attemptId = `attempt-${String(attempts.size + 1)}`;
    attempts.set(attemptId, { entryId, descriptor: entry as RouteEntryDescriptor });
    return {
      kind: 'leased',
      attemptId,
      entryId,
      fencingToken: 1,
      leaseExpiresAt: NOW + 60_000,
      current: null,
    };
  });
  const fail = vi.fn<CacheHost['fail']>().mockResolvedValue(undefined);
  const host: CacheHost = {
    startAttempt,
    uploadArtifact: (upload) => {
      const sha256 = createHash('sha256').update(upload.bytes).digest('hex');
      artifacts.set(sha256, upload.bytes);
      return Promise.resolve({ sha256, byteLength: upload.bytes.byteLength });
    },
    heartbeat: () => Promise.resolve(),
    commit: async (attemptId, request) => {
      const attempt = attempts.get(attemptId);
      const primary = request.generation.outputs.find(
        (output) => output.representationKey === 'html',
      );
      const body = primary?.artifacts.find((artifact) => artifact.role === 'html');
      const html = body === undefined ? undefined : artifacts.get(body.sha256);
      if (attempt === undefined || html === undefined) throw new Error('the commit has no HTML');
      commits.push(request);
      const generationId = `generation-${attemptId}`;
      const { generation } = request;
      const record = encodeGenerationPack(
        {
          schemaVersion: 1,
          scopeId: SCOPE,
          entryId: attempt.entryId,
          generationId,
          seq: 1,
          source: 'runtime',
          ...attempt.descriptor,
          cacheTimestamp: generation.cacheTimestamp,
          producedAt: generation.producedAt,
          policy: generation.policy,
          status: generation.status,
          headers: generation.headers,
          tags: [...generation.tags],
          artifacts: generation.outputs
            .filter((output) => output.representationKey !== 'html')
            .flatMap((output) => {
              return output.artifacts.map((artifact) => {
                return {
                  ...artifact,
                  artifactId: artifact.sha256,
                  representationKey: output.representationKey,
                  encoding: 'identity' as const,
                };
              });
            }),
          revision: 1,
          ...(await packBodyDigests(html, undefined)),
        },
        html,
        undefined,
      );
      records.set(attempt.entryId, record);
      return { kind: 'published', generationId, record };
    },
    fail,
    readRecord: vi.fn<CacheHost['readRecord']>((entryId) => Promise.resolve(records.get(entryId))),
    readArtifact: (artifactId) => Promise.resolve(artifacts.get(artifactId)),
    getData: unasked,
    setData: unasked,
    getTags: () => Promise.resolve({ tags: [] }),
    tagsDelta: () => Promise.resolve({ revision: 0, truncated: false, tags: [] }),
    invalidate: unasked,
  };
  const runtime: CacheRuntime = {
    scopeId: SCOPE,
    host,
    tags: new TagState({ holdMs: HOLD_MS }),
    holdMs: HOLD_MS,
    clockOf: frozen,
    dataMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    dataStates: new TtlCache(Infinity, ENTRIES, frozen),
    dataWrites: new Map(),
    entryIds: new TtlCache(Infinity, ENTRIES, frozen),
    recordMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    recordReads: new Map(),
    regenerationMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    publishing: new TtlCache(HOLD_MS, ENTRIES, frozen),
    letGo: new WeakSet(),
    givenBack: new TtlCache(HOLD_MS, ENTRIES, frozen),
    artifactMemo: new TtlCache(Infinity, ENTRIES, frozen),
    log: vi.fn(),
  };
  return { runtime, startAttempt, commits, fail };
}

function requests(runtime: CacheRuntime, route = ROUTE, pathname = '/two') {
  const pending: Promise<unknown>[] = [];
  return {
    ask: (headers: Record<string, string> = {}, method = 'GET') => {
      return handleRequest({
        app: { entries: { [route]: () => ({ handler }) } },
        edge: { entries: {} },
        request: new Request(`https://app.test${pathname}`, { headers, method }),
        cache: runtime,
        waitUntil: (work) => {
          pending.push(work);
        },
        clock: NOW,
      });
    },
    drain: async () => {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
}

function upgradeHeaders(route = ROUTE): Record<string, string> {
  return {
    [RESUME_PRERENDER_HEADER]: route,
    [REGENERATE_HEADER]: 'background',
    [CACHE_ROUTE_HEADER]: route,
    [CACHE_UPGRADE_HEADER]: '1',
  };
}

function readerOf(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('the response has no body');
  return reader;
}

type CacheCallback = (entry: unknown, meta: { url: string }) => boolean | Promise<boolean>;

async function capture(input: InvokeInput, postponed?: string): Promise<Response> {
  const callback = input.requestMeta['onCacheEntryV2'] as CacheCallback | undefined;
  if (callback === undefined) throw new Error('the static render supplied no capture callback');
  await callback(
    {
      value: {
        kind: 'APP_PAGE',
        html: { toUnchunkedString: () => UPGRADED },
        rscData: encoder.encode(FLIGHT),
        postponed,
        status: 200,
        headers: {},
      },
      cacheControl: { revalidate: false },
    },
    { url: '/two' },
  );
  return new Response(null);
}

describe('partial fallback shell promotion', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it.each([undefined, 'still resumable'])(
    'keeps shared-class invalidation identity when the next render has postponed=%s',
    async (postponed) => {
      const { runtime, commits } = cache();
      const descriptor = {
        kind: 'app-page' as const,
        route: '/[slug]/[id]',
        pathname: '/two/[id]',
      };
      const { entryId } = await deriveEntry(SCOPE, descriptor);
      const pending: Promise<unknown>[] = [];
      vi.mocked(invokeNodeHandler).mockImplementation((input) => capture(input, postponed));

      const result = await withClock(NOW, () => {
        return regenerate({
          runtime,
          request: new Request('https://app.test/two/first'),
          handler,
          target: { descriptor, reason: 'manual' },
          previewToken: undefined,
          waitUntil: (work) => {
            pending.push(work);
          },
          run: (work) => work(),
        });
      });

      expect(result.kind).toBe('accepted');

      await Promise.all(pending);

      expect(commits[0]?.generation.tags).toContainEqual({
        kind: 'next-implicit',
        value: sharedShellTagOf(entryId),
      });
    },
  );

  it('serves the first fallback before publishing the route shell used by the next HTML and Flight requests', async () => {
    const { runtime, startAttempt, commits, fail } = cache();
    const { ask, drain } = requests(runtime);
    const suffix = Promise.withResolvers<undefined>();
    vi.mocked(invokeNodeHandler).mockImplementation(async (input) => {
      if (input.requestMeta['onCacheEntryV2'] !== undefined) return capture(input);
      await suffix.promise;
      return new Response('<div id="slug" data-slug="two">two</div></main>');
    });

    try {
      const first = await ask();
      const reader = readerOf(first);
      const chunk = await reader.read();

      expect({
        body: new TextDecoder().decode(chunk.value),
        attempts: startAttempt.mock.calls.length,
        commits: commits.length,
      }).toStrictEqual({ body: FALLBACK, attempts: 0, commits: 0 });

      suffix.resolve(undefined);
      while (!(await reader.read()).done) {
        // Consume the continuation before allowing a background prerender to begin.
      }
      await drain();

      expect(startAttempt).toHaveBeenCalledExactlyOnceWith({
        entry: { kind: 'app-page', route: ROUTE, pathname: '/two' },
        reason: 'miss',
        replaces: null,
      });
      expect(commits).toMatchObject([
        {
          fencingToken: 1,
          generation: {
            outputs: [{ pathname: '/two', response: 'complete', compute: 'static' }, {}],
          },
        },
      ]);

      await expect((await ask()).text()).resolves.toBe(UPGRADED);
      await expect((await ask({ rsc: '1', 'next-router-prefetch': '1' })).text()).resolves.toBe(
        FLIGHT,
      );

      // Another Edge isolate can still resume its generic build shell after this one published.
      await (await ask(upgradeHeaders())).text();
      await drain();

      expect(startAttempt).toHaveBeenCalledTimes(1);
      expect(fail).not.toHaveBeenCalled();
    } finally {
      suffix.resolve(undefined);
      await drain();
    }
  });

  it('keeps HEAD of the partial fallback free of rendering and background generation', async () => {
    const { runtime, startAttempt } = cache();
    const { ask, drain } = requests(runtime);

    const response = await ask({}, 'HEAD');
    await drain();

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(startAttempt).not.toHaveBeenCalled();
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('publishes the completed subset key after an Edge resume is cancelled', async () => {
    const route = '/[slug]/[id]';
    vi.mocked(getStore).mockReturnValue(deployment(route));
    const { runtime, startAttempt, commits } = cache();
    const { ask, drain } = requests(runtime, route, '/two/first');
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      if (input.requestMeta['onCacheEntryV2'] !== undefined) return capture(input);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('resume'));
            },
          }),
        ),
      );
    });

    const response = await ask(upgradeHeaders(route));

    expect(response.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');

    const reader = readerOf(response);
    await reader.read();

    expect(startAttempt).not.toHaveBeenCalled();

    await reader.cancel();
    await vi.waitFor(() => {
      expect(startAttempt).toHaveBeenCalledTimes(1);
    });
    await drain();

    expect(startAttempt).toHaveBeenCalledExactlyOnceWith({
      entry: { kind: 'app-page', route, pathname: '/two/[id]' },
      reason: 'miss',
      replaces: null,
    });
    expect(commits).toHaveLength(1);
    expect(vi.mocked(invokeNodeHandler).mock.calls[1]?.[0].url).toBe('/two/[id]');
  });
});
