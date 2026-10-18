import { createHash } from 'node:crypto';

import type { Prerender } from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  encodeGenerationPack,
  packBodyDigests,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import type { CacheHost, CommitRequest } from '../src/cache/host.ts';
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
const SCOPE = 'on-demand-rsc';
const STATIC_ROUTE = '/fully-static-params/[top]';
const PARTIAL_ROUTE = '/required-fallback-params/[top]/[bottom]';
const RSC_HEADERS = { rsc: '1' };
const encoder = new TextEncoder();
const handler: NodeHandler = () => Promise.resolve();

function frozen(): number {
  return NOW;
}

function unasked(): Promise<never> {
  return Promise.reject(new Error('not used by an on-demand RSC navigation'));
}

/** A blocking fallback, with neither a built body nor an explicit ensureStatic setting. */
function deployment(partial: boolean): Store {
  const route = partial ? PARTIAL_ROUTE : STATIC_ROUTE;
  const shell: Prerender = {
    id: route,
    route,
    pathname: route,
    parentOutputId: route,
    groupId: 1,
    routeType: 'fallback',
    renderingMode: 'PARTIALLY_STATIC',
    allowQuery: ['nxtPtop'],
    initialRevalidate: false,
  };
  const dynamic = {
    sourceRegex: partial
      ? '^/required-fallback-params/(?<nxtPtop>[^/]+?)/(?<nxtPbottom>[^/]+?)(?:/)?$'
      : '^/fully-static-params/(?<nxtPtop>[^/]+?)(?:/)?$',
    destination: `${route}?nxtPtop=$nxtPtop${partial ? '&nxtPbottom=$nxtPbottom' : ''}`,
  };
  return {
    manifest: {
      buildId: 'build',
      deploymentId: SCOPE,
      config: { basePath: '', i18n: null, cacheComponents: true },
      entrypoints: [{ id: route, pathname: route, kind: 'app-page' }],
      prerenders: [shell],
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
              pattern: partial
                ? /^\/required-fallback-params\/[^/]+\/[^/]+\/?$/u
                : /^\/fully-static-params\/[^/]+\/?$/u,
              prerender: shell,
            },
          ],
        },
      ],
    ]),
    prerendersById: new Map([[route, shell]]),
    prerendersByPathname: new Map([[route, shell]]),
    renderedPages: new Set(),
    readBlob: unasked,
  } as unknown as Store;
}

/** Keep the real generation pipeline; only the cache host's external I/O is replaced. */
function cache(beforeCommit: () => Promise<void> = () => Promise.resolve()) {
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
  const readArtifact = vi.fn<CacheHost['readArtifact']>((artifactId) =>
    Promise.resolve(artifacts.get(artifactId)),
  );
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
      const state = primary?.artifacts.find((artifact) => artifact.role === 'postponed');
      const html = body === undefined ? undefined : artifacts.get(body.sha256);
      const postponed = state === undefined ? undefined : artifacts.get(state.sha256);
      if (attempt === undefined || html === undefined) throw new Error('the commit has no HTML');
      if (state !== undefined && postponed === undefined)
        throw new Error('the commit lost its postponed state');
      commits.push(request);
      await beforeCommit();
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
          ...(await packBodyDigests(html, postponed)),
        },
        html,
        postponed,
      );
      records.set(attempt.entryId, record);
      return { kind: 'published', generationId, record };
    },
    fail,
    readRecord: (entryId) => Promise.resolve(records.get(entryId)),
    readArtifact,
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
    entryIds: new TtlCache(HOLD_MS, ENTRIES, frozen),
    recordMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    recordReads: new Map(),
    regenerationMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    publishing: new TtlCache(HOLD_MS, ENTRIES, frozen),
    letGo: new WeakSet(),
    givenBack: new TtlCache(HOLD_MS, ENTRIES, frozen),
    artifactMemo: new TtlCache(HOLD_MS, ENTRIES, frozen),
    log: vi.fn(),
  };
  return { runtime, startAttempt, commits, fail, readArtifact };
}

function requests(runtime: CacheRuntime, partial = false) {
  const route = partial ? PARTIAL_ROUTE : STATIC_ROUTE;
  const pending: Promise<unknown>[] = [];
  return {
    ask: (pathname: string, headers: Record<string, string> = RSC_HEADERS) => {
      return handleRequest({
        app: { entries: { [route]: () => ({ handler }) } },
        edge: { entries: {} },
        request: new Request(`https://app.test${pathname}`, { headers }),
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

type CacheCallback = (entry: unknown, meta: { url: string }) => boolean | Promise<boolean>;

/** The simulated Next bridge owns these opaque bytes; SDK code must preserve them unchanged. */
async function capture(
  input: InvokeInput,
  flight: Uint8Array,
  postponed?: string,
): Promise<Response> {
  const callback = input.requestMeta['onCacheEntryV2'] as CacheCallback | undefined;
  if (callback === undefined) throw new Error('the static render supplied no capture callback');

  expect(input.request.headers.has('rsc')).toBe(false);
  expect(input.request.headers.has('next-router-prefetch')).toBe(false);
  expect(input.request.headers.has('next-router-segment-prefetch')).toBe(false);

  await callback(
    {
      value: {
        kind: 'APP_PAGE',
        html: { toUnchunkedString: () => `<main>${input.url}</main>` },
        rscData: flight,
        postponed,
        status: 200,
        headers: {},
      },
      cacheControl: { revalidate: false },
    },
    { url: input.url ?? '/' },
  );
  return new Response(null);
}

function readerOf(response: Response): ReadableStreamDefaultReader<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('the navigation has no body');
  return reader;
}

describe('ordinary RSC navigation of an unbuilt fallback', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment(false));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('captures once, preserves opaque Flight bytes, and sends them before its commit lands', async () => {
    const committing = Promise.withResolvers<undefined>();
    const commit = Promise.withResolvers<undefined>();
    const test = cache(() => {
      committing.resolve(undefined);
      return commit.promise;
    });
    const { ask, drain } = requests(test.runtime);
    const flight = new Uint8Array([35, 0, 255, 10, 52, 58, 116, 52]);
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      return input.requestMeta['onCacheEntryV2'] === undefined
        ? Promise.resolve(new Response('uncaptured live navigation'))
        : capture(input, flight);
    });

    try {
      const response = await ask('/fully-static-params/t4');

      expect(test.startAttempt).toHaveBeenCalledExactlyOnceWith({
        entry: { kind: 'app-page', route: STATIC_ROUTE, pathname: '/fully-static-params/t4' },
        reason: 'miss',
        replaces: null,
      });
      expect({
        prerender: response.headers.get('x-nextjs-prerender'),
        postponed: response.headers.get('x-nextjs-postponed'),
      }).toStrictEqual({ prerender: '1', postponed: null });

      const reader = readerOf(response);

      await expect(reader.read()).resolves.toMatchObject({ value: flight, done: false });

      await committing.promise;

      let ended = false;
      const end = (async () => {
        const value = await reader.read();
        ended = true;
        return value;
      })();

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(ended).toBe(false);

      commit.resolve(undefined);

      await expect(end).resolves.toMatchObject({ done: true });

      await drain();

      const outputs = test.commits[0]?.generation.outputs;
      if (outputs === undefined) throw new Error('the response did not publish a generation');
      for (const output of outputs) {
        for (const artifact of output.artifacts) test.runtime.artifactMemo.delete(artifact.sha256);
      }
      const later = await ask('/fully-static-params/t4');

      expect(new Uint8Array(await later.arrayBuffer())).toStrictEqual(flight);
      expect(test.readArtifact).toHaveBeenCalledExactlyOnceWith(
        createHash('sha256').update(flight).digest('hex'),
      );
      expect({
        bridgeCalls: vi.mocked(invokeNodeHandler).mock.calls.length,
        leaseCalls: test.startAttempt.mock.calls.length,
        commits: test.commits.length,
        failures: test.fail.mock.calls.length,
        primary: test.commits[0]?.generation.outputs[0],
      }).toMatchObject({
        bridgeCalls: 1,
        leaseCalls: 1,
        commits: 1,
        failures: 0,
        primary: {
          pathname: '/fully-static-params/t4',
          compute: 'static',
          response: 'complete',
        },
      });
    } finally {
      commit.resolve(undefined);
      await drain();
    }
  });

  it('shares only the resolved top parameter and resumes each sibling with its own bottom', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();
    const { ask, drain } = requests(test.runtime, true);
    const flight = encoder.encode('opaque static top t2; unresolved bottom');
    const state = 'postponed top t2; unresolved bottom';
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      const pathname = new URL(input.url ?? '/', 'https://app.test').pathname;
      return input.requestMeta['onCacheEntryV2'] === undefined
        ? Promise.resolve(new Response(`dynamic:${pathname}`))
        : capture(input, flight, state);
    });

    const first = await ask('/required-fallback-params/t2/b1');

    await expect(first.text()).resolves.toBe('dynamic:/required-fallback-params/t2/b1');

    await drain();

    expect(test.startAttempt).toHaveBeenCalledExactlyOnceWith({
      entry: {
        kind: 'app-page',
        route: PARTIAL_ROUTE,
        pathname: '/required-fallback-params/t2/[bottom]',
      },
      reason: 'miss',
      replaces: null,
    });

    const second = await ask('/required-fallback-params/t2/b2');
    const text = await second.text();

    expect(text).toBe('dynamic:/required-fallback-params/t2/b2');
    expect(text).not.toContain('b1');
    expect(test.startAttempt).toHaveBeenCalledTimes(1);
    expect(test.commits[0]?.generation.outputs[0]).toMatchObject({
      pathname: '/required-fallback-params/t2/[bottom]',
      compute: 'resuming',
      response: 'initial',
    });
    expect(
      vi.mocked(invokeNodeHandler).mock.calls.map(([input]) => input.requestMeta['postponed']),
    ).toStrictEqual([undefined, state, state]);
    expect(test.fail).not.toHaveBeenCalled();

    await drain();
  });

  it.each([undefined, '/_tree'])(
    'keeps a speculative request with segment=%s ahead of its pending background render',
    async (segment) => {
      const rendering = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      const test = cache();
      const { ask, drain } = requests(test.runtime);
      const flight = encoder.encode('opaque completed static Flight');
      vi.mocked(invokeNodeHandler).mockImplementation(async (input) => {
        if (input.requestMeta['onCacheEntryV2'] === undefined)
          return new Response('prefetch prefix');
        started.resolve(undefined);
        await rendering.promise;
        return capture(input, flight);
      });

      try {
        const response = await ask('/fully-static-params/t4', {
          rsc: '1',
          'next-router-prefetch': '1',
          ...(segment !== undefined && { 'next-router-segment-prefetch': segment }),
        });

        await expect(response.text()).resolves.toBe('prefetch prefix');

        await started.promise;

        expect(test.commits).toHaveLength(0);

        rendering.resolve(undefined);

        await drain();

        const later = await ask('/fully-static-params/t4');

        expect(new Uint8Array(await later.arrayBuffer())).toStrictEqual(flight);
        expect(test.startAttempt).toHaveBeenCalledTimes(1);
        expect(invokeNodeHandler).toHaveBeenCalledTimes(2);
        expect(test.fail).not.toHaveBeenCalled();
      } finally {
        rendering.resolve(undefined);
        await drain();
      }
    },
  );
});
