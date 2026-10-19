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
const GENERIC_STATE = 'opaque build resume cache\0not a runtime-generated state';
const FIRST_STATE = 'opaque completed class state\0first';
const OTHER_STATE = 'opaque completed class state\0other';
const RSC_HEADERS = { rsc: '1' };
const encoder = new TextEncoder();
const handler: NodeHandler = () => Promise.resolve();

function frozen(): number {
  return NOW;
}

function unasked(): Promise<never> {
  return Promise.reject(new Error('not used by an on-demand RSC navigation'));
}

/** A blocking fallback; partial deployments include the build's body-less RSC resume state. */
function deployment(
  partial: boolean,
  sourcePathname?: string,
  ensureStatic?: Prerender['ensureStatic'],
): Store {
  const route = partial ? PARTIAL_ROUTE : STATIC_ROUTE;
  const pathname = sourcePathname ?? route;
  const shell: Prerender = {
    id: pathname,
    route,
    pathname,
    parentOutputId: route,
    groupId: 1,
    routeType: 'page',
    response: 'empty',
    compute: 'blocking',
    renderingMode: 'PARTIALLY_STATIC',
    allowQuery: ['nxtPtop'],
    ensureStatic,
    initialRevalidate: false,
  };
  const dynamic = {
    sourceRegex: partial
      ? '^/required-fallback-params/(?<nxtPtop>[^/]+?)/(?<nxtPbottom>[^/]+?)(?:/)?$'
      : '^/fully-static-params/(?<nxtPtop>[^/]+?)(?:/)?$',
    destination: `${route}?nxtPtop=$nxtPtop${partial ? '&nxtPbottom=$nxtPbottom' : ''}`,
  };
  const state = encoder.encode(GENERIC_STATE);
  const stateId = createHash('sha256').update(state).digest('hex');
  const prerenders: Prerender[] = partial
    ? [
        shell,
        {
          ...shell,
          id: `${pathname}.rsc`,
          pathname: `${pathname}.rsc`,
          routeType: undefined,
          response: undefined,
          compute: undefined,
          postponed: {
            sha256: stateId,
            byteLength: state.byteLength,
            contentType: 'application/json',
          },
        },
      ]
    : [shell];
  return {
    manifest: {
      buildId: 'build',
      deploymentId: SCOPE,
      config: { basePath: '', i18n: null, cacheComponents: true },
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
              pattern: partial
                ? /^\/required-fallback-params\/[^/]+\/[^/]+\/?$/u
                : /^\/fully-static-params\/[^/]+\/?$/u,
              prerender: shell,
            },
          ],
        },
      ],
    ]),
    prerendersById: new Map(prerenders.map((item) => [item.id, item])),
    prerendersByPathname: new Map(prerenders.map((item) => [item.pathname, item])),
    renderedPages: new Set(),
    readBlob: (sha256: string) => {
      if (sha256 !== stateId) throw new Error('the build has no such blob');
      return state;
    },
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
  const readRecord = vi.fn<CacheHost['readRecord']>((entryId) =>
    Promise.resolve(records.get(entryId)),
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
    readRecord,
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
  return { runtime, startAttempt, commits, fail, readArtifact, readRecord };
}

function requests(runtime: CacheRuntime | undefined, partial = false) {
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

function fallbackRuntime(test: ReturnType<typeof cache>, mode: string): CacheRuntime | undefined {
  if (mode === 'host-unavailable') {
    test.readRecord.mockRejectedValue(new Error('unavailable'));
  } else if (mode === 'busy-capture-refused') {
    test.startAttempt.mockResolvedValue({ kind: 'busy' });
  }
  return mode === 'no-cache' ? undefined : test.runtime;
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

function nativeInvocation(input: InvokeInput) {
  return {
    pathname: new URL(input.url ?? '/', 'https://app.test').pathname,
    rsc: input.request.headers.get('rsc'),
    prefetch: input.request.headers.get('next-router-prefetch'),
    capture: input.requestMeta['onCacheEntryV2'],
    postponed: input.requestMeta['postponed'],
  };
}

/** The bridge alone understands these frozen fixture states; runtime code treats them as opaque. */
function captureClass(input: InvokeInput): Promise<Response> {
  const states = new Map([
    ['/required-fallback-params/t2/[bottom]', FIRST_STATE],
    ['/required-fallback-params/t3/[bottom]', OTHER_STATE],
  ]);
  const state = states.get(new URL(input.url ?? '/', 'https://app.test').pathname);
  if (state === undefined) throw new Error('the capture did not name a completed class');
  return capture(input, new Uint8Array([0, 255, 10, 50]), state);
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

  it('captures a completed class once and resumes each sibling from its new opaque state', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();
    const { ask, drain } = requests(test.runtime, true);
    const firstFlight = new Uint8Array([0, 255, 10, 1]);
    const secondFlight = new Uint8Array([0, 254, 10, 2]);
    const otherFlight = new Uint8Array([0, 253, 10, 3]);
    const visitorOutputs = new Map([
      ['/required-fallback-params/t2/b1', firstFlight],
      ['/required-fallback-params/t2/b2', secondFlight],
      ['/required-fallback-params/t3/b1', otherFlight],
    ]);
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      if (input.requestMeta['onCacheEntryV2'] !== undefined) return captureClass(input);
      const bytes = visitorOutputs.get(new URL(input.url ?? '/', 'https://app.test').pathname);
      if (bytes === undefined) throw new Error('the resume lost the visitor pathname');
      return Promise.resolve(new Response(bytes));
    });

    const first = await ask('/required-fallback-params/t2/b1', {
      ...RSC_HEADERS,
      cookie: 'session=first',
    });

    expect(new Uint8Array(await first.arrayBuffer())).toStrictEqual(firstFlight);

    await drain();

    const second = await ask('/required-fallback-params/t2/b2', {
      ...RSC_HEADERS,
      cookie: 'session=second',
    });

    expect(new Uint8Array(await second.arrayBuffer())).toStrictEqual(secondFlight);

    await drain();

    const other = await ask('/required-fallback-params/t3/b1');

    expect(new Uint8Array(await other.arrayBuffer())).toStrictEqual(otherFlight);

    await drain();

    expect(test.startAttempt.mock.calls.map(([request]) => request.entry)).toStrictEqual([
      { kind: 'app-page', route: PARTIAL_ROUTE, pathname: '/required-fallback-params/t2/[bottom]' },
      { kind: 'app-page', route: PARTIAL_ROUTE, pathname: '/required-fallback-params/t3/[bottom]' },
    ]);
    expect(
      vi
        .mocked(invokeNodeHandler)
        .mock.calls.filter(([input]) => input.requestMeta['onCacheEntryV2'] === undefined)
        .map(([input]) => {
          return {
            ...nativeInvocation(input),
            cookie: input.request.headers.get('cookie'),
          };
        }),
    ).toStrictEqual([
      {
        pathname: '/required-fallback-params/t2/b1',
        rsc: '1',
        prefetch: null,
        capture: undefined,
        postponed: FIRST_STATE,
        cookie: 'session=first',
      },
      {
        pathname: '/required-fallback-params/t2/b2',
        rsc: '1',
        prefetch: null,
        capture: undefined,
        postponed: FIRST_STATE,
        cookie: 'session=second',
      },
      {
        pathname: '/required-fallback-params/t3/b1',
        rsc: '1',
        prefetch: null,
        capture: undefined,
        postponed: OTHER_STATE,
        cookie: null,
      },
    ]);
    expect(
      vi
        .mocked(invokeNodeHandler)
        .mock.calls.filter(([input]) => input.requestMeta['onCacheEntryV2'] !== undefined)
        .map(([input]) => ({ pathname: input.url, cookie: input.request.headers.get('cookie') })),
    ).toStrictEqual([
      { pathname: '/required-fallback-params/t2/[bottom]', cookie: null },
      { pathname: '/required-fallback-params/t3/[bottom]', cookie: null },
    ]);
    expect(test.commits.map((request) => request.generation.outputs[0]?.pathname)).toStrictEqual([
      '/required-fallback-params/t2/[bottom]',
      '/required-fallback-params/t3/[bottom]',
    ]);
    expect(test.fail).not.toHaveBeenCalled();
  });

  it.each(['no-cache', 'host-unavailable', 'capture-refused', 'busy-capture-refused'])(
    'resumes the original generic state when a completed class has %s',
    async (mode) => {
      vi.mocked(getStore).mockReturnValue(deployment(true));
      const test = cache();
      const runtime = fallbackRuntime(test, mode);
      const { ask, drain } = requests(runtime, true);
      const flight = new Uint8Array([0, 255, 11, 8]);
      const captures = mode === 'capture-refused' || mode === 'busy-capture-refused' ? 1 : 0;
      vi.mocked(invokeNodeHandler).mockImplementation((input) => {
        const bytes = input.requestMeta['onCacheEntryV2'] === undefined ? flight : null;
        return Promise.resolve(new Response(bytes));
      });

      const response = await ask('/required-fallback-params/t2/b1');

      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(flight);

      await drain();

      expect(
        vi
          .mocked(invokeNodeHandler)
          .mock.calls.filter(([input]) => input.requestMeta['onCacheEntryV2'] === undefined)
          .map(([input]) => nativeInvocation(input)),
      ).toStrictEqual([
        {
          pathname: '/required-fallback-params/t2/b1',
          rsc: '1',
          prefetch: null,
          capture: undefined,
          postponed: GENERIC_STATE,
        },
      ]);
      expect({
        attempts: test.startAttempt.mock.calls.length,
        captures: vi
          .mocked(invokeNodeHandler)
          .mock.calls.filter(([input]) => input.requestMeta['onCacheEntryV2'] !== undefined).length,
        commits: test.commits.length,
      }).toStrictEqual({ attempts: captures, captures, commits: 0 });
    },
  );

  it('resumes a visitor from its own completed class capture when another isolate holds the lease', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();

    test.startAttempt.mockResolvedValue({ kind: 'busy' });

    const { ask, drain } = requests(test.runtime, true);
    const flight = new Uint8Array([0, 255, 11, 9]);
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      return input.requestMeta['onCacheEntryV2'] === undefined
        ? Promise.resolve(new Response(flight))
        : captureClass(input);
    });

    const response = await ask('/required-fallback-params/t2/b2');

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(flight);

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
    expect(
      vi
        .mocked(invokeNodeHandler)
        .mock.calls.filter(([input]) => input.requestMeta['onCacheEntryV2'] === undefined)
        .map(([input]) => nativeInvocation(input)),
    ).toStrictEqual([
      {
        pathname: '/required-fallback-params/t2/b2',
        rsc: '1',
        prefetch: null,
        capture: undefined,
        postponed: FIRST_STATE,
      },
    ]);
    expect(test.commits).toHaveLength(0);
    expect(test.fail).not.toHaveBeenCalled();
  });

  it('keeps a class whose key already equals its source on the original native resume', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true, '/required-fallback-params/t2/[bottom]'));
    const test = cache();
    const { ask, drain } = requests(test.runtime, true);
    const flight = new Uint8Array([0, 254, 11, 9]);
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response(flight));

    const response = await ask('/required-fallback-params/t2/b1');

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(flight);

    await drain();

    expect(
      vi.mocked(invokeNodeHandler).mock.calls.map(([input]) => nativeInvocation(input)),
    ).toStrictEqual([
      {
        pathname: '/required-fallback-params/t2/b1',
        rsc: '1',
        prefetch: null,
        capture: undefined,
        postponed: GENERIC_STATE,
      },
    ]);
    expect(test.startAttempt).not.toHaveBeenCalled();
    expect(test.commits).toHaveLength(0);
  });

  it('keeps the live entry fallback for an ensureStatic navigation with a literal placeholder URL', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true, undefined, 'navigation'));
    const { ask, drain } = requests(undefined, true);
    const flight = new Uint8Array([0, 253, 11, 7]);
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response(flight));

    const response = await ask('/required-fallback-params/t2/[bottom]');

    expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(flight);

    await drain();

    expect(
      vi.mocked(invokeNodeHandler).mock.calls.map(([input]) => nativeInvocation(input)),
    ).toStrictEqual([
      {
        pathname: '/required-fallback-params/t2/[bottom]',
        rsc: '1',
        prefetch: null,
        capture: undefined,
        postponed: undefined,
      },
    ]);
  });

  it.each([
    { shape: 'concrete', partial: false, prefetch: '2' },
    { shape: 'concrete', partial: false, prefetch: '3' },
    { shape: 'class', partial: true, prefetch: '2' },
    { shape: 'class', partial: true, prefetch: '3' },
  ])(
    'keeps prefetch=$prefetch on the native path for an unbuilt $shape entry',
    async ({ prefetch, partial }) => {
      vi.mocked(getStore).mockReturnValue(deployment(partial));
      const test = cache();
      const { ask, drain } = requests(test.runtime, partial);
      const pathname = partial ? '/required-fallback-params/t2/b1' : '/fully-static-params/t4';
      const flight = new Uint8Array([0, 255, 10, 3]);
      vi.mocked(invokeNodeHandler).mockImplementation(() => {
        const response = new Response(flight);
        return Promise.resolve(response);
      });

      const response = await ask(pathname, {
        rsc: '1',
        'next-router-prefetch': prefetch,
      });

      expect(test.startAttempt).not.toHaveBeenCalled();
      expect(new Uint8Array(await response.arrayBuffer())).toStrictEqual(flight);

      await drain();

      expect(
        vi.mocked(invokeNodeHandler).mock.calls.map(([input]) => nativeInvocation(input)),
      ).toStrictEqual([
        {
          pathname,
          rsc: '1',
          prefetch,
          capture: undefined,
          postponed: partial ? GENERIC_STATE : undefined,
        },
      ]);
      expect(test.commits).toHaveLength(0);
      expect(test.fail).not.toHaveBeenCalled();
    },
  );

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
