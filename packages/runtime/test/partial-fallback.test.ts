import { createHash } from 'node:crypto';

import type { Prerender } from '@stayingupwind/core/bundle';
import {
  decodeGenerationPack,
  type DecodedGenerationPack,
  deriveEntry,
  encodeGenerationPack,
  packBodyDigests,
  policyFromBuild,
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
import { currentGenerationAfterResponse, entryIdOf, rememberRecord } from '../src/cache/current.ts';
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
    readNewerRecord: vi
      .fn<NonNullable<CacheHost['readNewerRecord']>>()
      .mockResolvedValue(undefined),
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

function requests(
  runtime: CacheRuntime,
  route = ROUTE,
  pathname = '/two',
  clock: number | null = NOW,
) {
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
        clock: clock ?? undefined,
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

async function storedRecord(
  entryId: string,
  state: 'fresh' | 'stale' | 'expired' = 'fresh',
  options: { scopeId?: string; pathname?: string; seq?: number; tags?: string[] } = {},
): Promise<Uint8Array> {
  const html = encoder.encode(UPGRADED);
  const seq = options.seq ?? 2;
  return encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId: options.scopeId ?? SCOPE,
      entryId,
      kind: 'app-page',
      route: ROUTE,
      pathname: options.pathname ?? '/two',
      generationId: `stored-${String(seq)}`,
      seq,
      revision: seq,
      source: 'runtime',
      cacheTimestamp: NOW - 1000,
      producedAt: NOW - 1000,
      policy: policyFromBuild({
        initialRevalidate: state === 'fresh' ? false : 0,
        initialExpiration: state === 'expired' ? 0 : undefined,
      }),
      status: 200,
      headers: {},
      tags: (options.tags ?? []).map((value) => ({ kind: 'next-explicit' as const, value })),
      artifacts: [],
      ...(await packBodyDigests(html, undefined)),
    },
    html,
    undefined,
  );
}

type UnverifiedRead = 'corrupt' | 'digest' | 'entry' | 'scope' | 'error';

async function unverifiedRecord(entryId: string, failure: UnverifiedRead): Promise<Uint8Array> {
  if (failure === 'error') throw new Error('host unavailable');
  if (failure === 'corrupt') return encoder.encode('not a record');
  const bytes = await storedRecord(failure === 'entry' ? 'wrong-entry' : entryId, 'fresh', {
    scopeId: failure === 'scope' ? 'other-scope' : SCOPE,
  });
  if (failure === 'digest') {
    const last = bytes.length - 1;
    bytes[last] = bytes[last] === 0 ? 1 : 0;
  }
  return bytes;
}

function configureUpgrade(condition: 'HEAD' | 'ineligible'): void {
  if (condition === 'HEAD') return;
  const store = deployment();
  vi.mocked(getStore).mockReturnValue({
    ...store,
    manifest: {
      ...store.manifest,
      config: { ...store.manifest.config, partialPrefetching: false },
    },
  });
}

function checkedPack(bytes: Uint8Array): DecodedGenerationPack {
  const decoded = decodeGenerationPack(bytes);
  if (decoded.kind !== 'ok') throw new Error('invalid control record');
  return decoded.pack;
}

describe('partial fallback shell promotion', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it('keeps the first partial response bounded while its slow initial record read can schedule behind the body', async () => {
    const { runtime, startAttempt, commits } = cache();
    await entryIdOf(runtime, { kind: 'app-page', route: ROUTE, pathname: '/two' });
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const started = Promise.withResolvers<undefined>();
    vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
      started.resolve(undefined);
      return pending.promise;
    });
    const { ask, drain } = requests(runtime);
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      return input.requestMeta['onCacheEntryV2'] === undefined
        ? Promise.resolve(new Response('<div id="slug">two</div></main>'))
        : capture(input);
    });
    vi.useFakeTimers();
    try {
      const responding = ask();
      await started.promise;
      await vi.advanceTimersByTimeAsync(201);
      const response = await responding;
      const body = await response.text();

      expect(body.startsWith(FALLBACK)).toBe(true);
      expect(startAttempt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(49);
      pending.resolve(undefined);
      await drain();

      expect(startAttempt).toHaveBeenCalledExactlyOnceWith({
        entry: { kind: 'app-page', route: ROUTE, pathname: '/two' },
        reason: 'miss',
        replaces: null,
      });
      expect(vi.spyOn(runtime.host, 'readRecord')).toHaveBeenCalledTimes(1);
      expect(commits).toHaveLength(1);
      await expect((await ask()).text()).resolves.toBe(UPGRADED);
    } finally {
      pending.resolve(undefined);
      await drain();
    }
  });

  it.each([6000, 30_001])(
    'keeps the original pending read and deadline when the partial body lasts %sms',
    async (elapsed) => {
      const { runtime, startAttempt } = cache();
      await entryIdOf(runtime, { kind: 'app-page', route: ROUTE, pathname: '/two' });
      const pending = Promise.withResolvers<Uint8Array | undefined>();
      const started = Promise.withResolvers<undefined>();
      const suffix = Promise.withResolvers<undefined>();
      vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
        started.resolve(undefined);
        return pending.promise;
      });
      vi.mocked(invokeNodeHandler).mockImplementation(async (input) => {
        if (input.requestMeta['onCacheEntryV2'] !== undefined) return capture(input);
        await suffix.promise;
        return new Response('tail');
      });
      // Normal requests use the advancing wall clock, rather than an explicit frozen test clock.
      const { ask, drain } = requests(runtime, ROUTE, '/two', null);
      vi.useFakeTimers();
      try {
        const responding = ask();
        await started.promise;
        await vi.advanceTimersByTimeAsync(201);
        const reader = readerOf(await responding);

        expect(new TextDecoder().decode((await reader.read()).value)).toBe(FALLBACK);

        await vi.advanceTimersByTimeAsync(elapsed - 201);
        suffix.resolve(undefined);
        while (!(await reader.read()).done) {
          /* Consume the existing response only. */
        }
        await vi.advanceTimersByTimeAsync(0);

        expect(vi.spyOn(runtime.host, 'readRecord')).toHaveBeenCalledTimes(1);
        expect(startAttempt).not.toHaveBeenCalled();

        pending.resolve(undefined);
        await drain();

        expect(startAttempt).toHaveBeenCalledTimes(elapsed < 30_000 ? 1 : 0);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        suffix.resolve(undefined);
        pending.resolve(undefined);
        await drain();
      }
    },
  );

  it('waits behind an already-sent partial body when its completed-key read was evicted during streaming', async () => {
    const { runtime, startAttempt, commits } = cache();
    const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname: '/two' };
    const entryId = await entryIdOf(runtime, descriptor);
    const suffix = Promise.withResolvers<undefined>();
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const started = Promise.withResolvers<undefined>();
    const { ask, drain } = requests(runtime);
    vi.mocked(invokeNodeHandler).mockImplementation(async (input) => {
      if (input.requestMeta['onCacheEntryV2'] !== undefined) return capture(input);
      await suffix.promise;
      return new Response('<div id="slug">two</div></main>');
    });
    try {
      const first = await ask();
      const reader = readerOf(first);

      expect(new TextDecoder().decode((await reader.read()).value)).toBe(FALLBACK);
      expect(startAttempt).not.toHaveBeenCalled();

      runtime.recordMemo.delete(entryId);
      vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
        started.resolve(undefined);
        return pending.promise;
      });
      vi.useFakeTimers();
      suffix.resolve(undefined);
      while (!(await reader.read()).done) {
        // Only consuming the already-available body starts the after-body upgrade.
      }
      await started.promise;
      await vi.advanceTimersByTimeAsync(201);

      expect(startAttempt).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(49);
      pending.resolve(undefined);
      await drain();

      expect(startAttempt).toHaveBeenCalledExactlyOnceWith({
        entry: descriptor,
        reason: 'miss',
        replaces: null,
      });
      expect(vi.spyOn(runtime.host, 'readRecord')).toHaveBeenCalledTimes(2);
      expect(commits).toHaveLength(1);
    } finally {
      suffix.resolve(undefined);
      pending.resolve(undefined);
      await drain();
    }
  });

  it.each(['fresh', 'stale', 'expired'] as const)(
    'uses a slow verified %s record after the first response without guessing absence',
    async (state) => {
      const { runtime, startAttempt } = cache();
      const entryId = await entryIdOf(runtime, {
        kind: 'app-page',
        route: ROUTE,
        pathname: '/two',
      });
      const bytes = await storedRecord(entryId, state);
      const pending = Promise.withResolvers<Uint8Array | undefined>();
      const started = Promise.withResolvers<undefined>();
      vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
        started.resolve(undefined);
        return pending.promise;
      });
      vi.mocked(invokeNodeHandler).mockImplementation((input) => {
        return input.requestMeta['onCacheEntryV2'] === undefined
          ? Promise.resolve(new Response('tail'))
          : capture(input);
      });
      const { ask, drain } = requests(runtime);
      vi.useFakeTimers();
      try {
        const responding = ask();
        await started.promise;
        await vi.advanceTimersByTimeAsync(201);
        await (await responding).text();
        await vi.advanceTimersByTimeAsync(49);
        pending.resolve(bytes);
        await drain();
        const expected =
          state === 'fresh'
            ? []
            : [
                [
                  {
                    entry: { kind: 'app-page', route: ROUTE, pathname: '/two' },
                    reason: state,
                    replaces: 'stored-2',
                  },
                ],
              ];

        expect(startAttempt.mock.calls).toStrictEqual(expected);

        const observed = state === 'fresh' ? await (await ask()).text() : undefined;

        expect(observed).toBe(state === 'fresh' ? UPGRADED : undefined);

        expect(vi.spyOn(runtime.host, 'readRecord')).toHaveBeenCalledTimes(1);
      } finally {
        pending.resolve(undefined);
        await drain();
      }
    },
  );

  it('awaits a slow authority correction after cached absence without reusing its foreground deadline', async () => {
    const { runtime, startAttempt } = cache();
    const entryId = await entryIdOf(runtime, { kind: 'app-page', route: ROUTE, pathname: '/two' });
    const bytes = await storedRecord(entryId);
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const first = Promise.withResolvers<undefined>();
    const second = Promise.withResolvers<undefined>();
    const newer = vi.fn<NonNullable<CacheHost['readNewerRecord']>>().mockImplementation(() => {
      if (newer.mock.calls.length === 1) first.resolve(undefined);
      else second.resolve(undefined);
      return pending.promise;
    });
    runtime.host.readNewerRecord = newer;
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('tail'));
    const { ask, drain } = requests(runtime);
    vi.useFakeTimers();
    try {
      const responding = ask();
      await first.promise;
      await vi.advanceTimersByTimeAsync(201);
      await (await responding).text();
      await second.promise;
      await vi.advanceTimersByTimeAsync(250);

      expect(startAttempt).not.toHaveBeenCalled();

      pending.resolve(bytes);
      await drain();

      expect(startAttempt).not.toHaveBeenCalled();
      expect(newer).toHaveBeenCalledTimes(2);
      await expect((await ask()).text()).resolves.toBe(UPGRADED);
    } finally {
      pending.resolve(undefined);
      await drain();
    }
  });

  it.each(['corrupt', 'digest', 'entry', 'scope', 'error'] as const)(
    'never schedules a miss or memoizes absence from an unverified %s read',
    async (failure) => {
      const { runtime, startAttempt } = cache();
      const entryId = await entryIdOf(runtime, {
        kind: 'app-page',
        route: ROUTE,
        pathname: '/two',
      });
      vi.spyOn(runtime.host, 'readRecord').mockImplementation(() =>
        unverifiedRecord(entryId, failure),
      );
      vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('tail'));
      const { ask, drain } = requests(runtime);
      await (await ask()).text();
      await drain();

      expect(startAttempt).not.toHaveBeenCalled();
      expect(runtime.recordMemo.get(entryId)).toBeUndefined();
    },
  );

  it.each(['corrupt', 'digest', 'entry', 'scope', 'error'] as const)(
    'does not infer absence from an unverified %s authority correction',
    async (failure) => {
      const { runtime, startAttempt } = cache();
      const entryId = await entryIdOf(runtime, {
        kind: 'app-page',
        route: ROUTE,
        pathname: '/two',
      });
      const newer = vi
        .spyOn(runtime.host, 'readNewerRecord')
        .mockImplementation(() => unverifiedRecord(entryId, failure));
      vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('tail'));
      const { ask, drain } = requests(runtime);
      await (await ask()).text();
      await drain();

      expect(startAttempt).not.toHaveBeenCalled();
      expect(newer).toHaveBeenCalledTimes(2);
      expect(runtime.recordMemo.get(entryId)).toBeNull();
    },
  );

  it('uses the original primary lifetime for the newer hop and never adopts its late response', async () => {
    const { runtime, startAttempt } = cache();
    const entryId = await entryIdOf(runtime, { kind: 'app-page', route: ROUTE, pathname: '/two' });
    const bytes = await storedRecord(entryId);
    const primary = Promise.withResolvers<Uint8Array | undefined>();
    const started = Promise.withResolvers<undefined>();
    const later = Promise.withResolvers<Uint8Array | undefined>();
    const laterStarted = Promise.withResolvers<undefined>();
    vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
      started.resolve(undefined);
      return primary.promise;
    });
    vi.spyOn(runtime.host, 'readNewerRecord').mockImplementation(() => {
      laterStarted.resolve(undefined);
      return later.promise;
    });
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('tail'));
    const { ask, drain } = requests(runtime);
    vi.useFakeTimers();
    try {
      const responding = ask();
      await started.promise;
      await vi.advanceTimersByTimeAsync(201);
      await (await responding).text();
      await vi.advanceTimersByTimeAsync(29_549);
      primary.resolve(undefined);
      await laterStarted.promise;
      await vi.advanceTimersByTimeAsync(251);

      expect(startAttempt).not.toHaveBeenCalled();
      expect(runtime.recordMemo.get(entryId)).toBeNull();

      later.resolve(bytes);
      await drain();

      expect(startAttempt).not.toHaveBeenCalled();
      expect(runtime.recordMemo.get(entryId)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      primary.resolve(undefined);
      later.resolve(undefined);
      await drain();
    }
  });

  it('keeps a newer publication when an older pending primary read finally answers', async () => {
    const { runtime, startAttempt } = cache();
    const entryId = await entryIdOf(runtime, { kind: 'app-page', route: ROUTE, pathname: '/two' });
    const old = await storedRecord(entryId, 'stale');
    const next = checkedPack(await storedRecord(entryId, 'fresh', { seq: 3 }));
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const started = Promise.withResolvers<undefined>();
    vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
      started.resolve(undefined);
      return pending.promise;
    });
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('tail'));
    const { ask, drain } = requests(runtime);
    vi.useFakeTimers();
    try {
      const responding = ask();
      await started.promise;
      await vi.advanceTimersByTimeAsync(201);
      await (await responding).text();
      rememberRecord(runtime, entryId, next);
      pending.resolve(old);
      await drain();

      expect(startAttempt).not.toHaveBeenCalled();
      expect(runtime.recordMemo.get(entryId)?.header.seq).toBe(3);
    } finally {
      pending.resolve(undefined);
      await drain();
    }
  });

  it.each(['HEAD', 'ineligible'] as const)(
    'does not attach slow-read upgrade work for %s',
    async (condition) => {
      const { runtime, startAttempt } = cache();
      await entryIdOf(runtime, { kind: 'app-page', route: ROUTE, pathname: '/two' });
      configureUpgrade(condition);
      const pending = Promise.withResolvers<Uint8Array | undefined>();
      const started = Promise.withResolvers<undefined>();
      vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
        started.resolve(undefined);
        return pending.promise;
      });
      vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('tail'));
      const { ask, drain } = requests(runtime);
      vi.useFakeTimers();
      try {
        const responding = ask({}, condition === 'HEAD' ? 'HEAD' : 'GET');
        await started.promise;
        await vi.advanceTimersByTimeAsync(201);
        const response = await responding;
        await response.text();
        pending.resolve(undefined);
        await drain();

        expect(startAttempt).not.toHaveBeenCalled();
        expect(vi.spyOn(runtime.host, 'readRecord')).toHaveBeenCalledTimes(1);
      } finally {
        pending.resolve(undefined);
        await drain();
      }
    },
  );

  it('retains actual-pending authority slots after the background deadline until the calls settle', async () => {
    const { runtime } = cache();
    const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname: '/two' };
    const entryId = await entryIdOf(runtime, descriptor);
    runtime.recordMemo.set(entryId, null);
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const kept: Promise<unknown>[] = [];
    const waitUntil = (work: Promise<unknown>): void => {
      kept.push(work);
    };
    const newer = vi.fn(() => pending.promise);
    runtime.host.readNewerRecord = newer;
    vi.useFakeTimers();
    try {
      const lookups = Array.from({ length: 256 }, () =>
        currentGenerationAfterResponse(runtime, descriptor, waitUntil),
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(newer).toHaveBeenCalledTimes(256);

      await vi.advanceTimersByTimeAsync(30_001);

      expect((await Promise.all(lookups)).every((result) => result.kind === 'unavailable')).toBe(
        true,
      );
      expect((await currentGenerationAfterResponse(runtime, descriptor, waitUntil)).kind).toBe(
        'unavailable',
      );
      expect(newer).toHaveBeenCalledTimes(256);

      pending.resolve(undefined);
      await Promise.all(kept);

      expect((await currentGenerationAfterResponse(runtime, descriptor, waitUntil)).kind).toBe(
        'none',
      );
      expect(newer).toHaveBeenCalledTimes(257);

      await Promise.all(kept);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve(undefined);
      await Promise.all(kept);
    }
  });

  it('does not land an ignored-abort primary read after its original lifetime', async () => {
    const { runtime, startAttempt } = cache();
    const descriptor = { kind: 'app-page' as const, route: ROUTE, pathname: '/two' };
    const entryId = await entryIdOf(runtime, descriptor);
    const bytes = await storedRecord(entryId);
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const started = Promise.withResolvers<undefined>();
    vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
      started.resolve(undefined);
      return pending.promise;
    });
    vi.mocked(invokeNodeHandler).mockResolvedValue(new Response('tail'));
    const { ask, drain } = requests(runtime);
    vi.useFakeTimers();
    try {
      const responding = ask();
      await started.promise;
      await vi.advanceTimersByTimeAsync(201);
      await (await responding).text();
      await vi.advanceTimersByTimeAsync(29_800);

      expect(startAttempt).not.toHaveBeenCalled();

      pending.resolve(bytes);
      await drain();

      expect(startAttempt).not.toHaveBeenCalled();
      expect(runtime.recordMemo.get(entryId)).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      pending.resolve(undefined);
      await drain();
    }
  });

  it.each(['cancel', 'error'] as const)(
    'still checks authority behind a slow partial body that ends by %s',
    async (ending) => {
      const { runtime, startAttempt } = cache();
      await entryIdOf(runtime, { kind: 'app-page', route: ROUTE, pathname: '/two' });
      const pending = Promise.withResolvers<Uint8Array | undefined>();
      const started = Promise.withResolvers<undefined>();
      const failing = Promise.withResolvers<undefined>();
      vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
        started.resolve(undefined);
        return pending.promise;
      });
      vi.mocked(invokeNodeHandler).mockImplementation(async (input) => {
        if (input.requestMeta['onCacheEntryV2'] !== undefined) return capture(input);
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              await failing.promise;
              controller.error(new Error('the partial body ended'));
            },
          }),
        );
      });
      const { ask, drain } = requests(runtime);
      vi.useFakeTimers();
      try {
        const responding = ask();
        await started.promise;
        await vi.advanceTimersByTimeAsync(201);
        const reader = readerOf(await responding);

        expect(new TextDecoder().decode((await reader.read()).value)).toBe(FALLBACK);

        const end = {
          cancel: () => reader.cancel(),
          error: () => {
            failing.resolve(undefined);
            return reader.read();
          },
        }[ending];
        const settled = await Promise.allSettled([end()]);

        expect(settled[0].status).toBe(ending === 'cancel' ? 'fulfilled' : 'rejected');

        expect(startAttempt).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(49);
        pending.resolve(undefined);
        await drain();

        expect(startAttempt).toHaveBeenCalledExactlyOnceWith({
          entry: { kind: 'app-page', route: ROUTE, pathname: '/two' },
          reason: 'miss',
          replaces: null,
        });
      } finally {
        pending.resolve(undefined);
        failing.resolve(undefined);
        await drain();
      }
    },
  );

  it('rejudges local invalidation received during the slow authority lookup', async () => {
    const { runtime, startAttempt } = cache();
    const entryId = await entryIdOf(runtime, { kind: 'app-page', route: ROUTE, pathname: '/two' });
    const bytes = await storedRecord(entryId, 'fresh', { tags: ['changed'] });
    const pending = Promise.withResolvers<Uint8Array | undefined>();
    const started = Promise.withResolvers<undefined>();
    vi.spyOn(runtime.host, 'readRecord').mockImplementation(() => {
      started.resolve(undefined);
      return pending.promise;
    });
    vi.mocked(invokeNodeHandler).mockImplementation((input) => {
      return input.requestMeta['onCacheEntryV2'] === undefined
        ? Promise.resolve(new Response('tail'))
        : capture(input);
    });
    const { ask, drain } = requests(runtime);
    vi.useFakeTimers();
    try {
      const responding = ask();
      await started.promise;
      await vi.advanceTimersByTimeAsync(201);
      await (await responding).text();
      runtime.tags.applyLocal(['changed'], { staleAt: NOW, hardExpireAt: NOW });
      pending.resolve(bytes);
      await drain();

      expect(startAttempt).toHaveBeenCalledExactlyOnceWith({
        entry: { kind: 'app-page', route: ROUTE, pathname: '/two' },
        reason: 'expired',
        replaces: 'stored-2',
      });
    } finally {
      pending.resolve(undefined);
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
