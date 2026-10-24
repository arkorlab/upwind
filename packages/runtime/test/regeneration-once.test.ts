import type { Prerender } from '@stayingupwind/core/bundle';
import {
  type InvalidationState,
  policyFromCacheControl,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import {
  CACHE_OUTCOME_HEADER,
  CACHE_ROUTE_HEADER,
  REGENERATE_HEADER,
} from '@stayingupwind/core/paas';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { AppModule, NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import type { FetchLike } from '../src/cache/host.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import {
  type GenerationSource,
  serveFromGeneration,
  withBackgroundRegeneration,
} from '../src/generations.ts';
import { handleRequest } from '../src/handle.ts';
import { type InvokeInput, invokeNodeHandler } from '../src/node-bridge.ts';
import type { RoutedInput } from '../src/serve.ts';
import { getStore, type Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

// The time each test had where this suite ran before: it renders through the runtime and the
// function-side cache host, and several of its tests take a second or two on a quiet machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * How many regenerations a request is made to wait for, against an authority in memory: none for
 * a prefetch, however expired the page it prefetches, and no more than one for any request.
 */

vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

// A render is whatever a test makes it; one that captures nothing is dynamic.
function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn(() => Promise.resolve(new Response('rendered'))) };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_regenerationOnceTest00';
const HOST = 'https://app.test';
const SECOND = 1000;
const T0 = 1_800_000_000_000;
/** Past the generation's `expire`, which is an hour. */
const EXPIRED_AT = T0 + 3601 * SECOND;
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const PAGE = '/team';
const ITEMS = '/items/[id]';
const DESCRIPTOR: RouteEntryDescriptor = { kind: 'app-page', route: PAGE, pathname: PAGE };
const RSC = {
  header: 'rsc',
  varyHeader: 'rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch',
  prefetchHeader: 'next-router-prefetch',
  prefetchSegmentHeader: 'next-router-segment-prefetch',
  prefetchSegmentSuffix: '.segment.rsc',
  prefetchSegmentDirSuffix: '.segments',
};
const encoder = new TextEncoder();
const blobs = new Map([
  ['postponed', encoder.encode('the postponed state the build wrote')],
  ['shell', encoder.encode('<html>shell</html>')],
]);
const page: NodeHandler = () => Promise.resolve();
const app: AppModule = {
  entries: { [PAGE]: () => ({ handler: page }), [ITEMS]: () => ({ handler: page }) },
};

/** A page the build made partially: its shell, and the state it resumes from. */
function deployment(): Store {
  const shell: Prerender = {
    id: PAGE,
    pathname: PAGE,
    route: PAGE,
    parentOutputId: PAGE,
    groupId: 1,
    body: { sha256: 'shell', byteLength: 18, contentType: 'text/html' },
    postponed: { sha256: 'postponed', byteLength: 1, contentType: 'text/plain' },
  };
  return {
    manifest: {
      buildId: 'build',
      config: { basePath: '', i18n: null },
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: [],
        afterFiles: [],
        dynamicRoutes: [],
        onMatch: [],
        fallback: [],
        shouldNormalizeNextData: false,
        rsc: RSC,
      },
      entrypoints: [{ id: PAGE, kind: 'app-page', pathname: PAGE }],
    },
    pathnames: [PAGE],
    slashSpellings: new Map(),
    dynamicRoutes: [],
    staticFiles: new Map(),
    shellsByRoute: new Map([[PAGE, { pages: new Map([[PAGE, shell]]), patterns: [] }]]),
    prerendersById: new Map([[PAGE, shell]]),
    prerendersByPathname: new Map([[PAGE, shell]]),
    readBlob: (sha256: string) => blobs.get(sha256),
  } as unknown as Store;
}

/** The same, in an application that keeps its pages at a trailing slash (`trailingSlash`). */
function deploymentWithSlashes(): Store {
  const base = deployment();
  const { manifest } = base;
  return {
    ...base,
    manifest: { ...manifest, config: { ...manifest.config, trailingSlash: true } },
    pathnames: [...base.pathnames, `${PAGE}/`],
    slashSpellings: new Map([[`${PAGE}/`, PAGE]]),
  };
}

const MEMBER = '/items/own';
const ITEMS_ROUTE = {
  sourceRegex: '^/items/(?<nxtPid>[^/]+?)(?:/)?$',
  destination: '/items/[id]?nxtPid=$nxtPid',
};

/** The same, with a route whose members the build left to one class shell. */
function deploymentWithItems(): Store {
  const base = deployment();
  const itemsShell: Prerender = {
    id: ITEMS,
    pathname: ITEMS,
    route: ITEMS,
    parentOutputId: ITEMS,
    groupId: 2,
    body: { sha256: 'shell', byteLength: 18, contentType: 'text/html' },
    postponed: { sha256: 'postponed', byteLength: 1, contentType: 'text/plain' },
  };
  const { manifest } = base;
  return {
    ...base,
    dynamicRoutes: [ITEMS_ROUTE],
    manifest: {
      ...manifest,
      routing: { ...manifest.routing, dynamicRoutes: [ITEMS_ROUTE] },
      entrypoints: [...manifest.entrypoints, { id: ITEMS, kind: 'app-page', pathname: ITEMS }],
    },
    pathnames: [...base.pathnames, ITEMS],
    shellsByRoute: new Map([
      ...base.shellsByRoute,
      [
        ITEMS,
        { pages: new Map(), patterns: [{ pattern: /^\/items\/[^/]+$/u, prerender: itemsShell }] },
      ],
    ]),
    prerendersById: new Map([...base.prerendersById, [ITEMS, itemsShell]]),
    prerendersByPathname: new Map([...base.prerendersByPathname, [ITEMS, itemsShell]]),
  } as unknown as Store;
}

/** An authority holding a generation of the page a regeneration made, expired by `EXPIRED_AT`. */
async function expired(
  descriptor: RouteEntryDescriptor = DESCRIPTOR,
  invalidation?: InvalidationState,
  wrap: (inner: FetchLike) => FetchLike = (inner) => inner,
  holdMs?: number,
): Promise<{ authority: FakeAuthority; runtime: CacheRuntime }> {
  const authority = fakeAuthority(SCOPE);
  await authority.record(
    descriptor,
    {
      invalidation,
      cacheTimestamp: T0,
      policy: policyFromCacheControl({ revalidate: 60, expire: 3600 }),
      status: 200,
      headers: {},
      tags: [],
      postponed: encoder.encode('the postponed state the last regeneration wrote'),
      stored: new Map([
        ['rsc', encoder.encode('0:["expired payload"]')],
        ['segment:/_tree', encoder.encode('0:{"expired":"tree"}')],
      ]),
    },
    encoder.encode('<html>expired</html>'),
    'runtime',
  );
  const runtime = createCacheRuntime({
    env: ENV,
    now: () => T0,
    fetchImpl: wrap(authority.fetchImpl),
    ...(holdMs !== undefined && { holdMs }),
  });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return { authority, runtime };
}

/** The host answering the tag delta at revision 7, as one that has recorded the invalidation. */
function deltaAtInvalidation(inner: FetchLike): FetchLike {
  return async (request) => {
    // Asked of the host all the same, so that what it was asked is counted.
    const answered = await inner(request);
    if (!new URL(request.url).pathname.endsWith('/tags/delta')) {
      return answered;
    }
    return Response.json({
      ok: true,
      result: { revision: 7, floor: 0, truncated: false, tags: [] },
    });
  };
}

const RENDERED_PAYLOAD = '0:["rendered payload"]';
const RENDERED_TREE = '0:{"rendered":"tree"}';

/** A static render of the page, captured as Next.js hands it to its host. */
async function capturing(call: InvokeInput): Promise<Response> {
  const onCacheEntry = call.requestMeta['onCacheEntry'] as
    | ((entry: unknown, meta: unknown) => Promise<boolean> | boolean)
    | undefined;
  if (onCacheEntry === undefined) {
    return new Response('resumed');
  }
  await onCacheEntry(
    {
      value: {
        kind: 'APP_PAGE',
        html: { toUnchunkedString: () => '<html>rendered</html>' },
        rscData: encoder.encode(RENDERED_PAYLOAD),
        headers: { 'content-type': 'text/html' },
        status: 200,
        postponed: 'the postponed state the render left',
        segmentData: new Map([['/_tree', encoder.encode(RENDERED_TREE)]]),
      },
      cacheControl: { revalidate: 60, expire: 3600 },
    },
    { url: call.url },
  );
  return new Response(null);
}

/** Every piece of work handed to the runtime settled, and whatever that work handed on in turn. */
async function settle(pending: readonly Promise<unknown>[]): Promise<void> {
  for (let settled = 0; settled < pending.length;) {
    const batch = pending.slice(settled);
    settled = pending.length;
    await Promise.all(batch);
  }
}

/** A request for the page, the work it hands the runtime collected in `pending`. */
function routed(runtime: CacheRuntime, pending: Promise<unknown>[]): RoutedInput {
  const request = new Request(`${HOST}${PAGE}`);
  return {
    app,
    edge: { entries: {} },
    request,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    cache: runtime,
    initURL: request.url,
    run: (work) => work(),
  };
}

function prefetchOf(representation: GenerationSource['representation']): GenerationSource {
  return {
    route: PAGE,
    pathname: PAGE,
    url: PAGE,
    representation,
    prefetch: true,
    onMiss: 'build',
  };
}

function leases(authority: FakeAuthority): number {
  return authority.calls.filter((call) => call === 'POST /attempts').length;
}

describe('a prefetch of a page whose generation has expired', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  /**
   * It ran the whole regeneration in front of the prefetch: the lease and the tag delta, then the
   * render — for a request the client makes speculatively, one for each segment of the page.
   */
  it.each([
    ['rsc', RENDERED_PAYLOAD],
    ['segment:/_tree', RENDERED_TREE],
  ] as const)('is sent a render of its own for %s, and regenerated behind', async (key, sent) => {
    const { authority, runtime } = await expired();
    vi.mocked(invokeNodeHandler).mockImplementation(capturing);
    const pending: Promise<unknown>[] = [];

    const { before, body } = await withClock(EXPIRED_AT, async () => {
      const response = await serveFromGeneration(
        routed(runtime, pending),
        deployment(),
        prefetchOf(key),
        page,
      );
      const asked = leases(authority);
      return { before: asked, body: await response?.text() };
    });
    await withClock(EXPIRED_AT, () => settle(pending));

    // What Next.js sends it past `expire`: a fresh render, never the expired record's bytes.
    expect(body).toBe(sent);
    expect(before).toBe(0);
    // The regeneration, once the answer has gone out: one lease, one render of its own, a commit.
    expect(leases(authority)).toBe(1);
    expect(authority.commits).toHaveLength(1);
    expect(invokeNodeHandler).toHaveBeenCalledTimes(2);
  });

  /**
   * The render reads the page's data values through this isolate's view of the tags. Where the
   * invalidation that expired the entry is ahead of that view, a value it reached would be taken for
   * current and sent to the navigation that adopts the prefetch: the tag delta is pulled first, as
   * a regeneration pulls it. Expired by time alone, or by an invalidation the view has, it is not.
   */
  it.each([
    ['an invalidation ahead of the isolate', { revision: 7, hardExpireAt: T0 + SECOND }, 1],
    ['its expiry alone', undefined, 0],
  ] as const)(
    'pulls the tag delta first where it expired by %s',
    async (_, invalidation, pulls) => {
      const { authority, runtime } = await expired(DESCRIPTOR, invalidation, deltaAtInvalidation);
      const pulledBefore: number[] = [];
      vi.mocked(invokeNodeHandler).mockImplementation(async (call) => {
        pulledBefore.push(authority.calls.filter((made) => made === 'GET /tags/delta').length);
        return capturing(call);
      });
      const pending: Promise<unknown>[] = [];

      await withClock(EXPIRED_AT, async () => {
        const response = await serveFromGeneration(
          routed(runtime, pending),
          deployment(),
          prefetchOf('rsc'),
          page,
        );
        await response?.text();
      });

      expect(pulledBefore[0]).toBe(pulls);
    },
  );

  /**
   * The segments of a page prefetched together are behind the same invalidation: the first of
   * them to find it pulls the tag delta for all of them, rather than each its own.
   */
  it('pulls the tag delta once for the prefetches that find it ahead together', async () => {
    const { runtime } = await expired(
      DESCRIPTOR,
      { revision: 7, hardExpireAt: T0 + SECOND },
      deltaAtInvalidation,
    );
    const pulls = vi.spyOn(runtime.tags, 'sync');
    // The pulls made by the time each render begins: the regeneration behind them makes its own.
    const pulledBefore: number[] = [];
    vi.mocked(invokeNodeHandler).mockImplementation(async (call) => {
      pulledBefore.push(pulls.mock.calls.length);
      return capturing(call);
    });
    const pending: Promise<unknown>[] = [];

    await withClock(EXPIRED_AT, async () => {
      const answers = await Promise.all(
        (['rsc', 'segment:/_tree'] as const).map(async (key) =>
          serveFromGeneration(routed(runtime, pending), deployment(), prefetchOf(key), page),
        ),
      );
      await Promise.all(answers.map(async (response) => response?.text()));
    });

    expect(pulledBefore.slice(0, 2)).toStrictEqual([1, 1]);
  });

  /**
   * A pull that went out before the invalidation answers with the revision before it: a prefetch
   * that joined it, or made it, finds the view still short of its record once it is answered, and
   * pulls again rather than render what the invalidation reached.
   */
  it('pulls the tag delta again where a pull left the view short of the record', async () => {
    const released = Promise.withResolvers<true>();
    const revisions = [7, 8];
    const deltas = { asked: 0 };
    const { runtime } = await expired(
      DESCRIPTOR,
      { revision: 8, hardExpireAt: T0 + SECOND },
      (inner) => {
        return async (request) => {
          if (!new URL(request.url).pathname.endsWith('/tags/delta')) {
            return inner(request);
          }
          deltas.asked += 1;
          const revision = revisions.shift() ?? 8;
          if (revision === 7) {
            await released.promise;
          }
          return Response.json({
            ok: true,
            result: { revision, floor: 0, truncated: false, tags: [] },
          });
        };
      },
    );
    const pulledBefore: number[] = [];
    vi.mocked(invokeNodeHandler).mockImplementation(async (call) => {
      pulledBefore.push(deltas.asked);
      return capturing(call);
    });
    const pending: Promise<unknown>[] = [];

    const answering = withClock(EXPIRED_AT, async () => {
      const answers = await Promise.all(
        (['rsc', 'segment:/_tree'] as const).map(async (key) =>
          serveFromGeneration(routed(runtime, pending), deployment(), prefetchOf(key), page),
        ),
      );
      await Promise.all(answers.map(async (response) => response?.text()));
    });
    await vi.waitFor(() => {
      expect(deltas.asked).toBe(1);
    });
    released.resolve(true);
    await answering;

    expect(pulledBefore.slice(0, 2)).toStrictEqual([2, 2]);
    expect(runtime.tags.revision).toBe(8);
  });

  /**
   * A prefetch renders without the view once the gateway's second passes. A transport that ignores
   * its signal may answer later, but that aborted answer neither advances the view nor starts
   * another speculative pull. Consuming the response still permits the normal regeneration.
   */
  it('discards an aborted pull without starting another before the prefetch body ends', async () => {
    const released = Promise.withResolvers<true>();
    const requested = Promise.withResolvers<Request>();
    const deltas = { asked: 0 };
    const { authority, runtime } = await expired(
      DESCRIPTOR,
      { revision: 8, hardExpireAt: T0 + SECOND },
      (inner) => {
        return async (request) => {
          if (!new URL(request.url).pathname.endsWith('/tags/delta')) {
            return inner(request);
          }
          deltas.asked += 1;
          requested.resolve(request);
          const first = deltas.asked === 1;
          if (first) {
            await released.promise;
          }
          const revision = first ? 7 : 8;
          return Response.json({
            ok: true,
            result: { revision, floor: 0, truncated: false, tags: [] },
          });
        };
      },
    );
    vi.mocked(invokeNodeHandler).mockImplementation(capturing);
    const pending: Promise<unknown>[] = [];

    const response = await withClock(EXPIRED_AT, async () =>
      serveFromGeneration(routed(runtime, pending), deployment(), prefetchOf('rsc'), page),
    );
    const request = await requested.promise;
    released.resolve(true);
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect({
      aborted: request.signal.aborted,
      revision: runtime.tags.revision,
      pulls: deltas.asked,
      leases: leases(authority),
      commits: authority.commits.length,
    }).toStrictEqual({ aborted: true, revision: 0, pulls: 1, leases: 0, commits: 0 });

    await withClock(EXPIRED_AT, async () => {
      await response?.text();
      await settle(pending);
    });

    expect({
      revision: runtime.tags.revision,
      pulls: deltas.asked,
      leases: leases(authority),
      commits: authority.commits.length,
      observed: authority.commits[0]?.observedTagRevision,
    }).toStrictEqual({ revision: 8, pulls: 2, leases: 1, commits: 1, observed: 8 });
  });

  /**
   * A pull still out when the prefetch renders is kept going behind its answer while the prefetches
   * after it may join it, and no longer: a gateway that does not answer was left with one pull kept
   * going for each hold that passed, every one of them to the end of its request.
   */
  it('keeps a pull out going behind the answer for the hold, and no longer', async () => {
    const hold = 300;
    const { runtime } = await expired(
      DESCRIPTOR,
      { revision: 8, hardExpireAt: T0 + SECOND },
      (inner) => {
        return async (request) => {
          return new URL(request.url).pathname.endsWith('/tags/delta')
            ? new Promise<Response>(() => {
                // The gateway does not answer.
              })
            : inner(request);
        };
      },
      hold,
    );
    vi.mocked(invokeNodeHandler).mockImplementation(capturing);
    const pending: Promise<unknown>[] = [];

    await withClock(EXPIRED_AT, async () =>
      serveFromGeneration(routed(runtime, pending), deployment(), prefetchOf('rsc'), page),
    );
    // Each piece of work the prefetch handed the request, settled or not within the hold.
    const settled = await Promise.all(
      pending.map(async (promise) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            (async () => {
              try {
                await promise;
              } catch {
                // Settled all the same.
              }
              return true;
            })(),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => {
                resolve(false);
              }, hold);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    expect(settled.length).toBeGreaterThan(0);
    expect(settled.filter((done) => !done)).toStrictEqual([]);
  });

  /**
   * Next.js answers a prefetch of a segment itself, and captures nothing of it: rendered with the
   * prefetch's own headers, the page was answered with the build's segment, an older generation's,
   * or none. Rendered as the document a regeneration renders, it holds every segment, and the
   * prefetch is sent its own.
   */
  it('is sent its segment of a render of the page, not a render of the segment', async () => {
    const { authority, runtime } = await expired();
    vi.mocked(invokeNodeHandler).mockImplementation((call) => {
      return call.request.headers.has('next-router-segment-prefetch')
        ? Promise.resolve(new Response('the build’s segment'))
        : capturing(call);
    });
    const pending: Promise<unknown>[] = [];
    const input = routed(runtime, pending);
    const asked: RoutedInput = {
      ...input,
      request: new Request(input.request, {
        headers: {
          [RSC.header]: '1',
          [RSC.prefetchHeader]: '1',
          [RSC.prefetchSegmentHeader]: '/_tree',
        },
      }),
    };

    const body = await withClock(EXPIRED_AT, async () => {
      const response = await serveFromGeneration(
        asked,
        deployment(),
        prefetchOf('segment:/_tree'),
        page,
      );
      return response?.text();
    });
    await withClock(EXPIRED_AT, () => settle(pending));

    expect(body).toBe(RENDERED_TREE);
    expect(leases(authority)).toBe(1);
  });

  /**
   * The client cancels a prefetch a navigation overtakes. The regeneration was begun once the body
   * had been read to its end, and never behind a prefetch that did not get there: an expired page
   * only ever prefetched was rendered for every prefetch, and regenerated by none of them.
   */
  it('is regenerated behind all the same when the client cancels it', async () => {
    const { authority, runtime } = await expired();
    vi.mocked(invokeNodeHandler).mockImplementation(capturing);
    const pending: Promise<unknown>[] = [];

    await withClock(EXPIRED_AT, async () => {
      const response = await serveFromGeneration(
        routed(runtime, pending),
        deployment(),
        prefetchOf('rsc'),
        page,
      );
      await response?.body?.cancel();
    });
    await withClock(EXPIRED_AT, () => settle(pending));

    expect(leases(authority)).toBe(1);
    expect(authority.commits).toHaveLength(1);
  });
});

describe('a resume the edge asked to be regenerated behind', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  /**
   * Regenerated once its body has gone out. A body that failed part way — the render throwing
   * mid-stream — had gone out as far as it ever would, and the regeneration was never begun.
   */
  it('is regenerated behind a body that failed part way', async () => {
    const { authority, runtime } = await expired();
    vi.mocked(invokeNodeHandler).mockImplementation(capturing);
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('<html>part'));
      },
      pull(controller) {
        controller.error(new Error('the render threw'));
      },
    });
    const pending: Promise<unknown>[] = [];
    const input = routed(runtime, pending);
    const asked: RoutedInput = {
      ...input,
      request: new Request(input.request, {
        headers: { [CACHE_ROUTE_HEADER]: PAGE, [REGENERATE_HEADER]: 'background' },
      }),
    };

    await withClock(EXPIRED_AT, async () => {
      const response = await withBackgroundRegeneration(
        asked,
        deployment(),
        new Response(failing, { headers: { 'content-type': 'text/html' } }),
      );

      expect(response.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
      await expect(response.text()).rejects.toThrow('the render threw');
    });
    await withClock(EXPIRED_AT, () => settle(pending));

    expect(leases(authority)).toBe(1);
    expect(authority.commits).toHaveLength(1);
    expect(authority.commits[0]?.generation.cacheTimestamp).toBe(EXPIRED_AT);
  });
});

describe('a foreground regeneration that answers nothing', () => {
  beforeEach(() => {
    vi.stubGlobal('__ARKOR_FUNCTION_KIND__', 'app');
    vi.mocked(getStore).mockReturnValue(deployment());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  /**
   * The usual path the request fell back to read the same expired record, and regenerated from it
   * again: a second lease, and a second render that was as dynamic as the first.
   */
  it('leaves the usual path to render the request, not to regenerate again', async () => {
    const { authority, runtime } = await expired();

    const response = await handleRequest({
      app,
      edge: { entries: {} },
      request: new Request(`${HOST}${PAGE}`, {
        headers: { 'x-arkor-regenerate': 'foreground', 'x-arkor-cache-route': PAGE },
      }),
      waitUntil: () => {
        // A regeneration that captured nothing leaves nothing behind that this test reads.
      },
      cache: runtime,
      clock: EXPIRED_AT,
    });

    await expect(response.text()).resolves.toBe('rendered');
    expect(response.headers.get(CACHE_OUTCOME_HEADER)).toBe('skipped');
    expect(leases(authority)).toBe(1);
  });

  /**
   * In an application that keeps its pages at a trailing slash, the foreground regenerated the
   * entry by the pathname as it came, and the usual path, which routes it without the slash, took
   * that for another entry: the same one, as the cache keys it, regenerated twice.
   */
  it('takes a pathname asked with a trailing slash for the entry it names', async () => {
    vi.mocked(getStore).mockReturnValue(deploymentWithSlashes());
    const { authority, runtime } = await expired();

    const response = await handleRequest({
      app,
      edge: { entries: {} },
      request: new Request(`${HOST}${PAGE}/`, {
        headers: { 'x-arkor-regenerate': 'foreground', 'x-arkor-cache-route': PAGE },
      }),
      waitUntil: () => {
        // A regeneration that captured nothing leaves nothing behind that this test reads.
      },
      cache: runtime,
      clock: EXPIRED_AT,
    });

    await expect(response.text()).resolves.toBe('rendered');
    expect(leases(authority)).toBe(1);
  });

  /**
   * The one regeneration was the request's, not the entry's: a member the edge asked to upgrade
   * is regenerated as its own entry, and the usual path answers it from its class shell's — which
   * expired, and which nothing had regenerated, was rendered for the request and left expired.
   */
  it('regenerates the entry the usual path lands on when it is not the one regenerated', async () => {
    vi.mocked(getStore).mockReturnValue(deploymentWithItems());
    const { authority, runtime } = await expired({
      kind: 'app-page',
      route: ITEMS,
      pathname: ITEMS,
    });

    const response = await handleRequest({
      app,
      edge: { entries: {} },
      request: new Request(`${HOST}${MEMBER}`, {
        headers: {
          'x-arkor-regenerate': 'foreground',
          'x-arkor-cache-route': ITEMS,
          'x-arkor-cache-upgrade': '1',
        },
      }),
      waitUntil: () => {
        // Both regenerations capture nothing, and leave nothing behind that this test reads.
      },
      cache: runtime,
      clock: EXPIRED_AT,
    });
    await response.text();

    // The member's, in the foreground; then the class shell's, on the usual path.
    expect(leases(authority)).toBe(2);
  });
});
