import { createHash } from 'node:crypto';

import type { Prerender } from '@stayingupwind/core/bundle';
import {
  deriveEntry,
  encodeGenerationPack,
  packBodyDigests,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import {
  CACHE_OUTCOME_HEADER,
  CACHE_ROUTE_HEADER,
  REGENERATE_HEADER,
} from '@stayingupwind/core/paas';
import { TtlCache } from '@stayingupwind/core/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderCompletedRscForVisitor } from '../src/answers.ts';
import type { NodeHandler } from '../src/app-module.ts';
import type { CacheHost, CommitRequest } from '../src/cache/host.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { TagState } from '../src/cache/tags.ts';
import { handleRequest } from '../src/handle.ts';
import { invokeNodeHandler, type InvokeInput } from '../src/node-bridge.ts';
import { routingParameters } from '../src/route-parameters.ts';
import type { RoutedInput } from '../src/serve.ts';
import { generationPathname, getStore, isClassShell, type Store } from '../src/store.ts';

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
  overrides: Partial<Prerender> = {},
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
    ...overrides,
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
  return { runtime, startAttempt, commits, fail, readArtifact, readRecord, records };
}

function requests(runtime: CacheRuntime | undefined, partial = false) {
  const route = partial ? PARTIAL_ROUTE : STATIC_ROUTE;
  const pending: Promise<unknown>[] = [];
  return {
    ask: (
      pathname: string,
      headers: Record<string, string> = RSC_HEADERS,
      clock = NOW,
      method = 'GET',
    ) => {
      return handleRequest({
        app: { entries: { [route]: () => ({ handler }) } },
        edge: { entries: {} },
        request: new Request(`https://app.test${pathname}`, { headers, method }),
        cache: runtime,
        waitUntil: (work) => {
          pending.push(work);
        },
        clock,
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

/** The simulated Next bridge owns these opaque bytes; SDK code must preserve them unchanged. */
async function capture(
  input: InvokeInput,
  flight: Uint8Array,
  postponed?: string,
): Promise<Response> {
  type CacheCallback = (entry: unknown, meta: { url: string }) => boolean | Promise<boolean>;

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

/** A page dynamic here: its static render (an attempt's) keeps nothing; a visitor's answers. */
function dynamicHere(input: InvokeInput): Promise<Response> {
  const attempt = input.request.headers.get('x-invocation-id')?.startsWith('attempt-');
  return Promise.resolve(new Response(attempt === true ? null : 'live'));
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

function completedResponse(input: InvokeInput): Promise<Response> {
  return input.requestMeta['onCacheEntryV2'] === undefined
    ? Promise.resolve(new Response(String(input.requestMeta['postponed'])))
    : captureClass(input);
}

async function remoteClassRecord(outcome: string): Promise<Uint8Array | undefined> {
  if (outcome !== 'published') return undefined;
  const seeded = cache();
  const client = requests(seeded.runtime, true);
  await (await client.ask('/required-fallback-params/t2/b1')).text();
  await client.drain();
  const record = [...seeded.records.values()][0];
  if (record === undefined) throw new Error('the fixture did not publish a record');
  return record;
}

describe('ordinary RSC navigation of an unbuilt fallback', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment(false));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it('captures a completed RSC class for its visitor after a slow authority read', async () => {
    vi.useFakeTimers();
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();
    const reading = Promise.withResolvers<undefined>();
    const record = Promise.withResolvers<Uint8Array | undefined>();

    test.readRecord.mockImplementation(() => {
      reading.resolve(undefined);
      return record.promise;
    });

    const { ask, drain } = requests(test.runtime, true);
    vi.mocked(invokeNodeHandler).mockImplementation(completedResponse);

    try {
      const answered = ask('/required-fallback-params/t2/b1');

      await reading.promise;
      await vi.advanceTimersByTimeAsync(250);

      const response = await answered;

      await expect(response.text()).resolves.toBe(FIRST_STATE);
      expect(
        vi.mocked(invokeNodeHandler).mock.calls.map(([input]) => {
          return {
            ...nativeInvocation(input),
            capture: typeof input.requestMeta['onCacheEntryV2'],
            query: new URL(input.url ?? '/', 'https://app.test').search,
          };
        }),
      ).toStrictEqual([
        {
          pathname: '/required-fallback-params/t2/[bottom]',
          query: '',
          rsc: null,
          prefetch: null,
          capture: 'function',
          postponed: undefined,
        },
        {
          pathname: '/required-fallback-params/t2/b1',
          query: '?nxtPtop=t2&nxtPbottom=b1',
          rsc: '1',
          prefetch: null,
          capture: 'undefined',
          postponed: FIRST_STATE,
        },
      ]);
      expect(test.readRecord).toHaveBeenCalledTimes(1);
      expect(test.startAttempt).not.toHaveBeenCalled();
      expect(test.commits).toHaveLength(0);
      expect(test.fail).not.toHaveBeenCalled();
    } finally {
      record.resolve(undefined);
      await drain();
    }
  });

  it.each(['b1', 'b2'])(
    'keeps visitor inputs out of the unavailable class capture and resumes %s with them',
    async (bottom) => {
      const store = deployment(true);
      vi.mocked(getStore).mockReturnValue(store);
      const test = cache();

      test.readRecord.mockRejectedValue(new Error('authority unavailable'));

      const { ask, drain } = requests(test.runtime, true);
      vi.mocked(invokeNodeHandler).mockImplementation(completedResponse);
      const router = '["",{}]';

      const response = await ask(`/required-fallback-params/t2/${bottom}?view=own`, {
        rsc: '1',
        cookie: 'session=visitor',
        'next-router-state-tree': router,
      });

      await expect(response.text()).resolves.toBe(FIRST_STATE);

      await drain();

      expect(
        routingParameters(store, PARTIAL_ROUTE, '/required-fallback-params/t2/[bottom]'),
      ).toBeUndefined();
      expect(
        vi.mocked(invokeNodeHandler).mock.calls.map(([input]) => {
          return {
            ...nativeInvocation(input),
            capture: typeof input.requestMeta['onCacheEntryV2'],
            query: new URL(input.url ?? '/', 'https://app.test').search,
            cookie: input.request.headers.get('cookie'),
            router: input.request.headers.get('next-router-state-tree'),
          };
        }),
      ).toStrictEqual([
        {
          pathname: '/required-fallback-params/t2/[bottom]',
          query: '',
          rsc: null,
          prefetch: null,
          capture: 'function',
          postponed: undefined,
          cookie: null,
          router: null,
        },
        {
          pathname: `/required-fallback-params/t2/${bottom}`,
          query: `?view=own&nxtPtop=t2&nxtPbottom=${bottom}`,
          rsc: '1',
          prefetch: null,
          capture: 'undefined',
          postponed: FIRST_STATE,
          cookie: 'session=visitor',
          router,
        },
      ]);
      expect(test.readRecord).toHaveBeenCalledTimes(1);
      expect(test.startAttempt).not.toHaveBeenCalled();
      expect(test.commits).toHaveLength(0);
      expect(test.fail).not.toHaveBeenCalled();
    },
  );

  it.each(['absent', 'published'])(
    'publishes nothing when the delayed authority eventually answers %s',
    async (outcome) => {
      vi.useFakeTimers();
      vi.mocked(getStore).mockReturnValue(deployment(true));
      vi.mocked(invokeNodeHandler).mockImplementation(completedResponse);
      const remote = await remoteClassRecord(outcome);
      const test = cache();
      const reading = Promise.withResolvers<undefined>();
      const record = Promise.withResolvers<Uint8Array | undefined>();

      test.readRecord.mockImplementation(() => {
        reading.resolve(undefined);
        return record.promise;
      });

      const { ask, drain } = requests(test.runtime, true);

      try {
        const answered = ask('/required-fallback-params/t2/b2');
        await reading.promise;
        await vi.advanceTimersByTimeAsync(250);

        await expect((await answered).text()).resolves.toBe(FIRST_STATE);
        expect(test.startAttempt).not.toHaveBeenCalled();
        expect(test.commits).toHaveLength(0);
      } finally {
        record.resolve(remote);
        await drain();
      }

      expect({
        reads: test.readRecord.mock.calls.length,
        attempts: test.startAttempt.mock.calls.length,
        commits: test.commits.length,
        failures: test.fail.mock.calls.length,
      }).toStrictEqual({ reads: 1, attempts: 0, commits: 0, failures: 0 });

      const { entryId } = await deriveEntry(SCOPE, {
        kind: 'app-page',
        route: PARTIAL_ROUTE,
        pathname: '/required-fallback-params/t2/[bottom]',
      });

      const remembered = test.runtime.recordMemo.get(entryId);

      expect(remembered === null ? 'absent' : remembered?.header.generationId).toBe(
        outcome === 'published' ? 'generation-attempt-1' : 'absent',
      );
    },
  );

  it.each(['dynamic', 'server-error', 'throw'])(
    'keeps the generic fallback when the unavailable visitor capture is %s',
    async (failure) => {
      vi.mocked(getStore).mockReturnValue(deployment(true));
      const test = cache();

      test.readRecord.mockRejectedValue(new Error('authority unavailable'));

      const { ask, drain } = requests(test.runtime, true);
      vi.mocked(invokeNodeHandler).mockImplementation((input) => {
        if (input.requestMeta['onCacheEntryV2'] === undefined) return completedResponse(input);
        if (failure === 'throw') return Promise.reject(new Error('static capture rejected'));
        return Promise.resolve(
          new Response(null, { status: failure === 'server-error' ? 500 : 200 }),
        );
      });

      await expect((await ask('/required-fallback-params/t2/b1')).text()).resolves.toBe(
        GENERIC_STATE,
      );

      vi.mocked(invokeNodeHandler).mockImplementation(completedResponse);

      await expect((await ask('/required-fallback-params/t2/b2')).text()).resolves.toBe(
        FIRST_STATE,
      );

      await drain();

      expect(test.startAttempt).not.toHaveBeenCalled();
      expect(test.commits).toHaveLength(0);
      expect(test.fail).not.toHaveBeenCalled();

      expect(
        vi
          .mocked(test.runtime.log)
          .mock.calls.filter(([message]) => message === 'completed RSC visitor capture failed'),
      ).toHaveLength(failure === 'throw' ? 1 : 0);
    },
  );

  it('does not hide a visitor resume failure after the unavailable static capture succeeds', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();

    test.readRecord.mockRejectedValue(new Error('authority unavailable'));

    const { ask, drain } = requests(test.runtime, true);
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      return input.requestMeta['onCacheEntryV2'] === undefined
        ? Promise.reject(new Error('visitor resume rejected'))
        : captureClass(input);
    });

    await expect(ask('/required-fallback-params/t2/b1')).rejects.toThrow('visitor resume rejected');

    await drain();

    expect(test.runtime.log).not.toHaveBeenCalledWith('completed RSC visitor capture failed');
    expect(test.startAttempt).not.toHaveBeenCalled();
    expect(test.commits).toHaveLength(0);
  });

  it.each([
    { label: 'prefetch=1', headers: { rsc: '1', 'next-router-prefetch': '1' } },
    { label: 'prefetch=2', headers: { rsc: '1', 'next-router-prefetch': '2' } },
    { label: 'prefetch=3', headers: { rsc: '1', 'next-router-prefetch': '3' } },
    { label: 'empty prefetch', headers: { rsc: '1', 'next-router-prefetch': '' } },
    { label: 'segment', headers: { rsc: '1', 'next-router-segment-prefetch': '/_tree' } },
  ])('adds no unavailable static capture to $label', async ({ headers }) => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();

    test.readRecord.mockRejectedValue(new Error('authority unavailable'));

    const { ask, drain } = requests(test.runtime, true);
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('native'));

    await expect((await ask('/required-fallback-params/t2/b1', headers)).text()).resolves.toBe(
      'native',
    );

    await drain();

    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta['onCacheEntryV2'],
    ).toBeUndefined();
    expect(test.startAttempt).not.toHaveBeenCalled();
    expect(test.commits).toHaveLength(0);
  });

  it('refuses a literal-placeholder catch-all target that needs a separated query', async () => {
    const base = deployment(true);
    const route = '/required-fallback-params/[top]/[...bottom]';
    const shell: Prerender = {
      id: route,
      route,
      pathname: route,
      parentOutputId: route,
      groupId: 1,
      routeType: 'page',
      response: 'empty',
      compute: 'blocking',
      renderingMode: 'PARTIALLY_STATIC',
      allowQuery: ['nxtPbottom'],
      initialRevalidate: false,
    };
    const store: Store = {
      ...base,
      manifest: {
        ...base.manifest,
        entrypoints: [{ id: route, pathname: route, kind: 'app-page' }],
        prerenders: [shell],
      },
      prerendersByPathname: new Map([[route, shell]]),
      shellsByRoute: new Map([
        [
          route,
          {
            pages: new Map(),
            patterns: [{ pattern: /^\/required-fallback-params\/[^/]+\/.+$/u, prerender: shell }],
          },
        ],
      ]),
    };
    const pathname = '/required-fallback-params/[top]/a%2Fb';
    const completed = pathname;
    const test = cache();
    const input: RoutedInput = {
      app: { entries: {} },
      edge: { entries: {} },
      request: new Request(`https://app.test${pathname}`, { headers: RSC_HEADERS }),
      initURL: `https://app.test${pathname}`,
      cache: test.runtime,
      run: (work) => work(),
      waitUntil: vi.fn(),
    };

    expect(generationPathname(shell, pathname)).toBe(completed);
    expect(isClassShell(completed, route)).toBe(true);
    expect(routingParameters(store, route, completed)).toStrictEqual({
      nxtPtop: '[top]',
      nxtPbottom: 'a/b',
    });
    await expect(
      renderCompletedRscForVisitor(
        {
          input,
          store,
          target: { descriptor: { kind: 'app-page', route, pathname: completed }, handler },
        },
        { route, pathname: completed, representation: 'rsc', url: pathname, onMiss: 'render' },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(invokeNodeHandler).not.toHaveBeenCalled();
  });

  it('keeps a valid draft and a matching bypass on their request-specific paths', async () => {
    const base = deployment(true, undefined, undefined, {
      bypassFor: [{ type: 'header', key: 'x-bypass', value: 'yes' }],
    });
    vi.mocked(getStore).mockReturnValue({
      ...base,
      manifest: { ...base.manifest, bypassToken: 'draft-token' },
    });
    const test = cache();

    test.readRecord.mockRejectedValue(new Error('authority unavailable'));

    const { ask, drain } = requests(test.runtime, true);
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('visitor'));

    for (const headers of [
      { rsc: '1', cookie: '__prerender_bypass=draft-token' },
      { rsc: '1', 'x-bypass': 'yes' },
    ]) {
      await expect((await ask('/required-fallback-params/t2/b1', headers)).text()).resolves.toBe(
        'visitor',
      );

      vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('visitor'));
    }
    await drain();

    expect(test.readRecord).not.toHaveBeenCalled();
    expect(test.startAttempt).not.toHaveBeenCalled();
    expect(test.commits).toHaveLength(0);
    expect(
      vi
        .mocked(invokeNodeHandler)
        .mock.calls.every(([input]) => input.requestMeta['onCacheEntryV2'] === undefined),
    ).toBe(true);
  });

  it('preserves the dynamic miss suppression when its next authority read is unavailable', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();
    const { ask, drain } = requests(test.runtime, true);
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      return input.requestMeta['onCacheEntryV2'] === undefined
        ? completedResponse(input)
        : Promise.resolve(new Response(null));
    });

    await expect((await ask('/required-fallback-params/t2/b1')).text()).resolves.toBe(
      GENERIC_STATE,
    );

    await drain();

    expect(test.fail).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ outcome: 'skipped' }),
    );

    const { entryId } = await deriveEntry(SCOPE, {
      kind: 'app-page',
      route: PARTIAL_ROUTE,
      pathname: '/required-fallback-params/t2/[bottom]',
    });

    test.runtime.recordMemo.delete(entryId);

    test.runtime.recordReads.delete(entryId);

    test.startAttempt.mockClear();

    test.fail.mockClear();

    vi.mocked(invokeNodeHandler).mockClear();

    test.readRecord.mockRejectedValue(new Error('authority unavailable'));

    vi.mocked(invokeNodeHandler).mockImplementation(completedResponse);

    await expect((await ask('/required-fallback-params/t2/b2')).text()).resolves.toBe(
      GENERIC_STATE,
    );

    await drain();

    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta['onCacheEntryV2'],
    ).toBeUndefined();
    expect(test.startAttempt).not.toHaveBeenCalled();
    expect(test.fail).not.toHaveBeenCalled();
    expect(test.commits).toHaveLength(0);
  });

  it('does not recapture after the foreground path already tried the same class', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();

    test.startAttempt.mockResolvedValue({ kind: 'busy' });

    test.readRecord.mockRejectedValue(new Error('authority unavailable'));

    const { ask, drain } = requests(test.runtime, true);
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      return input.requestMeta['onCacheEntryV2'] === undefined
        ? completedResponse(input)
        : Promise.resolve(new Response(null));
    });

    const response = await ask('/required-fallback-params/t2/b1', {
      rsc: '1',
      [REGENERATE_HEADER]: 'foreground',
      [CACHE_ROUTE_HEADER]: PARTIAL_ROUTE,
    });

    await expect(response.text()).resolves.toBe(GENERIC_STATE);

    await drain();

    expect(test.startAttempt).toHaveBeenCalledTimes(1);
    expect(
      vi
        .mocked(invokeNodeHandler)
        .mock.calls.filter(([input]) => input.requestMeta['onCacheEntryV2'] !== undefined),
    ).toHaveLength(1);
    expect(test.commits).toHaveLength(0);
    expect(test.fail).not.toHaveBeenCalled();
  });

  it('adds no authority reads or static captures to a fresh completed-class hit', async () => {
    vi.mocked(getStore).mockReturnValue(deployment(true));
    const test = cache();
    const { ask, drain } = requests(test.runtime, true);
    vi.mocked(invokeNodeHandler).mockImplementation(completedResponse);
    await (await ask('/required-fallback-params/t2/b1')).text();
    await drain();

    expect(test.commits).toHaveLength(1);

    test.readRecord.mockClear();

    test.startAttempt.mockClear();

    vi.mocked(invokeNodeHandler).mockClear();

    await expect((await ask('/required-fallback-params/t2/b2')).text()).resolves.toBe(FIRST_STATE);

    await drain();

    expect(test.readRecord).not.toHaveBeenCalled();
    expect(test.readArtifact).not.toHaveBeenCalled();
    expect(test.startAttempt).not.toHaveBeenCalled();
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta['onCacheEntryV2'],
    ).toBeUndefined();
    expect(test.commits).toHaveLength(1);
  });

  it.each([
    { label: 'HEAD', method: 'HEAD', source: undefined, ensure: undefined, overrides: {} },
    {
      label: 'unchanged class',
      method: 'GET',
      source: '/required-fallback-params/t2/[bottom]',
      ensure: undefined,
      overrides: {},
    },
    {
      label: 'navigation-static',
      method: 'GET',
      source: undefined,
      ensure: 'navigation' as const,
      overrides: {},
    },
    {
      label: 'built shell',
      method: 'GET',
      source: undefined,
      ensure: undefined,
      overrides: { body: { sha256: 'unused', byteLength: 1, contentType: 'text/html' } },
    },
    {
      label: 'query-dependent',
      method: 'GET',
      source: undefined,
      ensure: undefined,
      overrides: { allowQuery: ['unrepresented'] },
    },
  ])(
    'keeps an unavailable $label on its existing native path',
    async ({ method, source, ensure, overrides }) => {
      vi.mocked(getStore).mockReturnValue(deployment(true, source, ensure, overrides));
      const test = cache();

      test.readRecord.mockRejectedValue(new Error('authority unavailable'));

      const { ask, drain } = requests(test.runtime, true);
      vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('native'));

      const response = await ask('/required-fallback-params/t2/b1', RSC_HEADERS, NOW, method);
      await response.text();
      await drain();

      expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(invokeNodeHandler).mock.calls[0]?.[0].requestMeta['onCacheEntryV2'],
      ).toBeUndefined();
      expect(test.startAttempt).not.toHaveBeenCalled();
      expect(test.commits).toHaveLength(0);
    },
  );

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
      const attempts = mode === 'capture-refused' || mode === 'busy-capture-refused' ? 1 : 0;
      const captures = mode === 'no-cache' ? 0 : 1;
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
      }).toStrictEqual({ attempts, captures, commits: 0 });
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

  it.each([
    ['an RSC navigation', RSC_HEADERS],
    ['a document', {}],
  ] as const)(
    'answers %s of a page found dynamic as it came for five minutes, with no static render first',
    async (_label, headers) => {
      const test = cache();
      vi.mocked(invokeNodeHandler).mockImplementation(dynamicHere);
      const client = requests(test.runtime);
      const first = await client.ask('/fully-static-params/t1', headers);

      await client.drain();

      await expect(first.text()).resolves.toBe('live');
      expect(test.startAttempt).toHaveBeenCalledTimes(1);
      expect(invokeNodeHandler).toHaveBeenCalledTimes(2);

      const later = await client.ask('/fully-static-params/t1', headers, NOW + 299_999);

      await client.drain();

      await expect(later.text()).resolves.toBe('live');
      expect(test.startAttempt).toHaveBeenCalledTimes(1);
      expect(invokeNodeHandler).toHaveBeenCalledTimes(3);

      await client.ask('/fully-static-params/t1', headers, NOW + 300_000);
      await client.drain();

      expect(test.startAttempt).toHaveBeenCalledTimes(2);
    },
  );

  it('schedules no render behind a prefetch of a page found dynamic', async () => {
    const test = cache();
    vi.mocked(invokeNodeHandler).mockImplementation(dynamicHere);
    const client = requests(test.runtime);
    await client.ask('/fully-static-params/t1');
    await client.drain();

    expect(test.startAttempt).toHaveBeenCalledTimes(1);

    const prefetch = await client.ask('/fully-static-params/t1', {
      rsc: '1',
      'next-router-prefetch': '1',
    });
    await client.drain();

    expect(prefetch.status).toBe(200);
    expect(test.startAttempt).toHaveBeenCalledTimes(1);
  });

  it('takes a server error a static render answered for a failure, not for a page dynamic here', async () => {
    const test = cache();
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      const attempt = input.request.headers.get('x-invocation-id')?.startsWith('attempt-');
      return Promise.resolve(
        attempt === true ? new Response('boom', { status: 500 }) : new Response('live'),
      );
    });
    const client = requests(test.runtime);
    await client.ask('/fully-static-params/t1');
    await client.drain();

    expect(test.fail.mock.calls[0]?.[1].outcome).toBe('failed');

    await client.ask('/fully-static-params/t1');
    await client.drain();

    expect(test.startAttempt).toHaveBeenCalledTimes(2);
  });

  it('remembers a page found dynamic in a foreground regeneration of no record', async () => {
    const test = cache();
    vi.mocked(invokeNodeHandler).mockImplementation(dynamicHere);
    const client = requests(test.runtime);
    const foreground = {
      [REGENERATE_HEADER]: 'foreground',
      [CACHE_ROUTE_HEADER]: STATIC_ROUTE,
    };
    const first = await client.ask('/fully-static-params/t1', foreground);
    await client.drain();

    await expect(first.text()).resolves.toBe('live');
    expect(test.startAttempt).toHaveBeenCalledTimes(1);

    const again = await client.ask('/fully-static-params/t1', foreground);
    await client.drain();

    await expect(again.text()).resolves.toBe('live');
    expect(again.headers.get(CACHE_OUTCOME_HEADER)).toBe('skipped');
    expect(test.startAttempt).toHaveBeenCalledTimes(1);
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
