import { type DeploymentBundle, type Prerender } from '@stayingupwind/core/bundle';
import {
  MAX_TAGS_PER_ENTRY,
  policyFromCacheControl,
  type RouteEntryDescriptor,
} from '@stayingupwind/core/cache';
import { CACHE_OUTCOME_HEADER } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import { seedRouteFor } from '../../host/src/bundle/index.ts';
import type { NodeHandler } from '../src/app-module.ts';
import { MAX_CAPTURED_BYTES } from '../src/cache/capture.ts';
import { nowMs, withClock } from '../src/cache/clock.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { type GenerationSource, serveFromGeneration } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

/**
 * What the deployment's Worker answers from an entry's generation, against an authority in
 * memory: the one a regeneration publishes, the one the build's seed put there, and how the two
 * agree with what the handler itself answered.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);

const SCOPE = 'dpl_generationsUnderTest0';
const HOST = 'https://app.test';
const SECOND = 1000;
const YEAR = 366 * 24 * 60 * 60 * SECOND;
const T0 = 1_800_000_000_000;
const ISR = 's-maxage=60, stale-while-revalidate=31535940';
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
/** Nothing here runs a handler: the bridge that would is replaced, and says what it answers. */
const handler: NodeHandler = () => Promise.reject(new Error('the bridge is replaced'));

function runtimeFor(authority: FakeAuthority): CacheRuntime {
  const runtime = createCacheRuntime({ env: ENV, now: nowMs, fetchImpl: authority.fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

/**
 * The shell the build made of a route's class, without a body: what makes its members the cache's
 * to answer, where a route the build prerendered nothing of is rendered for every request.
 */
function routeShell(route: string): { pages: Map<string, Prerender>; patterns: unknown[] } {
  const prerender: Prerender = {
    id: route,
    pathname: route,
    route,
    parentOutputId: route,
    groupId: 1,
  };
  return { pages: new Map(), patterns: [{ pattern: /^\//u, prerender }] };
}

/** A deployment whose routes are these entrypoints, each with its class's shell and nothing else. */
function storeOf(entrypoints: readonly { pathname: string; kind: string }[]): Store {
  return {
    manifest: { buildId: 'build', entrypoints, config: { basePath: '', i18n: null } },
    prerendersByPathname: new Map<string, Prerender>(),
    shellsByRoute: new Map(entrypoints.map(({ pathname }) => [pathname, routeShell(pathname)])),
  } as unknown as Store;
}

/** A request for `path`, the work it leaves behind collected in `pending`. */
function routed(
  runtime: CacheRuntime,
  path: string,
  pending: Promise<unknown>[],
  method = 'GET',
): RoutedInput {
  const request = new Request(`${HOST}${path}`, { method });
  return {
    app: { entries: {} },
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

/** What the bridge answers, made afresh for every call: a body is read once. */
function answering(body: string | null, init: ResponseInit): () => Promise<Response> {
  return () => Promise.resolve(new Response(body, init));
}

/**
 * Every piece of work handed to the runtime settled, and whatever that work handed on in turn: a
 * regeneration hands its publish on once its render is made.
 */
async function settle(pending: readonly Promise<unknown>[]): Promise<void> {
  for (let settled = 0; settled < pending.length;) {
    const batch = pending.slice(settled);
    settled = pending.length;
    await Promise.all(batch);
  }
}

async function serve(
  runtime: CacheRuntime,
  store: Store,
  source: GenerationSource,
  now: number,
): Promise<Response | undefined> {
  const pending: Promise<unknown>[] = [];
  const response = await withClock(now, () =>
    serveFromGeneration(routed(runtime, source.url, pending), store, source, handler),
  );
  await settle(pending);
  return response;
}

/**
 * `serve`, with the answer read to its end as a client reads it before the work settles: what the
 * end of an answer begins — a stale generation's regeneration — is only begun then.
 */
async function serveRead(
  runtime: CacheRuntime,
  store: Store,
  source: GenerationSource,
  now: number,
): Promise<string | undefined> {
  const pending: Promise<unknown>[] = [];
  const body = await withClock(now, async () => {
    const response = await serveFromGeneration(
      routed(runtime, source.url, pending),
      store,
      source,
      handler,
    );
    return response?.text();
  });
  await settle(pending);
  return body;
}

describe("a route handler's generation", () => {
  const FEED: RouteEntryDescriptor = {
    kind: 'app-route',
    route: '/api/feed',
    pathname: '/api/feed',
  };
  const SOURCE: GenerationSource = {
    route: FEED.route,
    pathname: FEED.pathname,
    url: FEED.pathname,
    representation: 'route-body',
    onMiss: 'build',
  };
  const OWN = {
    'content-type': 'text/csv',
    'content-disposition': 'attachment; filename="feed.csv"',
    'access-control-allow-origin': '*',
  };

  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('answers with the headers the handler gave it, seeded and regenerated', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: FEED.route, kind: 'app-route' }]);
    // The build's generation of the route, as the deployment run seeds it.
    const prerender = {
      id: FEED.pathname,
      pathname: FEED.pathname,
      route: FEED.route,
      parentOutputId: FEED.pathname,
      groupId: 1,
      routeType: 'route',
      body: { sha256: 'a'.repeat(64), byteLength: 5, contentType: 'text/csv' },
      initialStatus: 200,
      initialRevalidate: 60,
      initialExpiration: 3600,
      initialHeaders: { ...OWN, 'x-next-cache-tags': '_N_T_/api/feed' },
    } as Prerender;
    const bundle = {
      buildId: 'build',
      config: { ...store.manifest.config, cacheComponents: false },
      entrypoints: [{ id: 'app/api/feed/route', kind: 'app-route', pathname: FEED.route }],
      prerenders: [prerender],
      routing: { beforeMiddleware: [], afterFiles: [], onMatch: [] },
    } as unknown as DeploymentBundle;
    const seeded = await seedRouteFor(bundle, prerender, { scopeId: SCOPE, generatedAt: T0 });
    await authority.record(
      FEED,
      seeded!.input.generation,
      new TextEncoder().encode('built'),
      'build',
    );
    vi.mocked(invokeNodeHandler).mockImplementation(
      answering('regenerated', { headers: { ...OWN, 'cache-control': ISR } }),
    );

    const built = await serve(runtime, store, SOURCE, T0 + SECOND);
    // Expired: rendered again in the foreground, then served from what that published.
    const rendered = await serve(runtime, store, SOURCE, T0 + YEAR);
    await rendered?.text();
    const kept = await serve(runtime, store, SOURCE, T0 + YEAR + SECOND);

    expect(built?.headers.get('content-disposition')).toBe(OWN['content-disposition']);
    expect(built?.headers.get('access-control-allow-origin')).toBe('*');
    await expect(built?.text()).resolves.toBe('built');
    expect(authority.commits).toHaveLength(1);
    expect(kept?.headers.get('content-disposition')).toBe(OWN['content-disposition']);
    expect(kept?.headers.get('access-control-allow-origin')).toBe('*');
    await expect(kept?.text()).resolves.toBe('regenerated');
    // Where each answer came from, as Next.js says it on one answered whole (`x-nextjs-cache`).
    expect(
      [built, rendered, kept].map((answer) => answer?.headers.get('x-nextjs-cache')),
    ).toStrictEqual(['HIT', 'MISS', 'HIT']);
  });
});

describe('what a render is told the regeneration was for', () => {
  const PAGE: RouteEntryDescriptor = { kind: 'pages', route: '/reason', pathname: '/reason' };

  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  /**
   * Next.js reads `revalidateReason` from one header: `x-prerender-revalidate`, compared against
   * the token the build generated (`checkIsOnDemandRevalidate`). A render without it is told
   * `'stale'` however the regeneration came about, so `res.revalidate()` — which is somebody
   * asking — looked to `getStaticProps` exactly like a lifetime running out.
   */
  async function renderRequestFor(
    reason: 'expired' | 'manual',
    previewToken: string | undefined,
  ): Promise<Request> {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const pending: Promise<unknown>[] = [];
    const input = routed(runtime, PAGE.pathname, pending);
    vi.mocked(invokeNodeHandler).mockImplementation(
      answering('rendered', { headers: { 'cache-control': ISR } }),
    );

    await withClock(T0, () => {
      return regenerate({
        runtime,
        request: input.request,
        handler,
        target: { descriptor: PAGE, reason },
        previewToken,
        waitUntil: input.waitUntil,
        run: input.run,
      });
    });
    await Promise.all(pending);

    const [call] = vi.mocked(invokeNodeHandler).mock.calls;
    if (call?.[0] === undefined) {
      throw new Error('the render was never invoked');
    }
    return call[0].request;
  }

  it('says on-demand to a render somebody asked for', async () => {
    const request = await renderRequestFor('manual', 'build-token');

    expect(request.headers.get('x-prerender-revalidate')).toBe('build-token');
  });

  it('says nothing of the sort to a render a lifetime ran out on', async () => {
    const request = await renderRequestFor('expired', 'build-token');

    expect(request.headers.get('x-prerender-revalidate')).toBeNull();
  });

  it('says nothing for a build that generated no token', async () => {
    const request = await renderRequestFor('manual', undefined);

    expect(request.headers.get('x-prerender-revalidate')).toBeNull();
  });
});

describe('a generation no visitor may be answered with as written', () => {
  const MOVED: RouteEntryDescriptor = {
    kind: 'pages',
    route: '/legacy/[slug]',
    pathname: '/legacy/moved',
  };
  const MOVED_SOURCE: GenerationSource = {
    route: MOVED.route,
    pathname: MOVED.pathname,
    url: MOVED.pathname,
    representation: 'html',
    onMiss: 'render',
  };
  const FEED: RouteEntryDescriptor = {
    kind: 'app-route',
    route: '/api/feed',
    pathname: '/api/feed',
  };
  const FEED_SOURCE: GenerationSource = {
    route: FEED.route,
    pathname: FEED.pathname,
    url: FEED.pathname,
    representation: 'route-body',
    onMiss: 'build',
  };
  /** `getStaticProps` answering `redirect` with `revalidate: 5`, as the Pages Router writes it. */
  const REDIRECT: ResponseInit = {
    status: 307,
    headers: {
      location: '/legacy/a',
      'cache-control': 's-maxage=5, stale-while-revalidate=31535995',
    },
  };
  const LIFETIME = policyFromCacheControl({ revalidate: 5, expire: 3600 });

  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('answers a redirect from its generation, where it leads included', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: MOVED.route, kind: 'pages' }]);
    vi.mocked(invokeNodeHandler).mockImplementation(answering('/legacy/a', REDIRECT));

    // Rendered once and kept, as Next.js keeps a redirect `getStaticProps` returned.
    const first = await serve(runtime, store, MOVED_SOURCE, T0);
    const kept = await serve(runtime, store, MOVED_SOURCE, T0 + SECOND);

    expect(first?.status).toBe(307);
    expect(first?.headers.get('location')).toBe('/legacy/a');
    expect(first?.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
    expect(kept?.status).toBe(307);
    expect(kept?.headers.get('location')).toBe('/legacy/a');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  it('renders for the visitor rather than send a redirect its record cannot say the way of', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: MOVED.route, kind: 'pages' }]);
    // A record a seed wrote without the redirect's `Location`, as one before this runtime did.
    await authority.record(
      MOVED,
      { cacheTimestamp: T0, policy: LIFETIME, status: 307, headers: {}, tags: [] },
      new TextEncoder().encode('/legacy/a'),
      'build',
    );
    vi.mocked(invokeNodeHandler).mockImplementation(answering('/legacy/a', REDIRECT));

    const answer = await serve(runtime, store, MOVED_SOURCE, T0 + SECOND);

    expect(answer?.status).toBe(307);
    expect(answer?.headers.get('location')).toBe('/legacy/a');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
    expect(authority.commits).toHaveLength(0);
  });

  /** A status below 200 is one no `Response` can carry, and a seed before the upload check wrote one. */
  it('renders for the visitor rather than answer with a status no response can carry', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: FEED.route, kind: 'app-route' }]);
    await authority.record(
      FEED,
      { cacheTimestamp: T0, policy: LIFETIME, status: 199, headers: {}, tags: [] },
      new TextEncoder().encode('{"feed":true}'),
      'build',
    );
    vi.mocked(invokeNodeHandler).mockImplementation(
      answering('{"feed":"rendered"}', { status: 200, headers: { 'cache-control': ISR } }),
    );

    const answer = await serve(runtime, store, FEED_SOURCE, T0 + SECOND);

    expect(answer?.status).toBe(200);
    await expect(answer?.text()).resolves.toBe('{"feed":"rendered"}');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  it('does not keep a server error as the answer, and keeps rendering the entry', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: FEED.route, kind: 'app-route' }]);
    await authority.record(
      FEED,
      { cacheTimestamp: T0, policy: LIFETIME, status: 200, headers: {}, tags: [] },
      new TextEncoder().encode('{"feed":true}'),
      'build',
    );
    // An explicit 500 from a handler whose route revalidates: Next.js still sends it with the
    // route's lifetime.
    vi.mocked(invokeNodeHandler).mockImplementation(
      answering('upstream down', { status: 500, headers: { 'cache-control': ISR } }),
    );

    const first = await serve(runtime, store, FEED_SOURCE, T0 + YEAR);
    const second = await serve(runtime, store, FEED_SOURCE, T0 + YEAR + SECOND);

    expect(first?.status).toBe(500);
    expect(second?.status).toBe(500);
    expect(authority.commits).toHaveLength(0);
    expect(authority.failures.map((failure) => failure.outcome)).toStrictEqual([
      'failed',
      'failed',
    ]);
    // Both requests rendered it, once to try to publish and once for the visitor.
    expect(invokeNodeHandler).toHaveBeenCalledTimes(4);
  });

  /**
   * A handler's `204` has no body, and a `Response` handed one under such a status — an empty one
   * included — throws: the render is answered, and its generation served again, with none.
   */
  it('answers a status no body goes with, from the render and from its generation', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: FEED.route, kind: 'app-route' }]);
    await authority.record(
      FEED,
      { cacheTimestamp: T0, policy: LIFETIME, status: 200, headers: {}, tags: [] },
      new TextEncoder().encode('{"feed":true}'),
      'build',
    );
    vi.mocked(invokeNodeHandler).mockImplementation(
      answering(null, { status: 204, headers: { 'cache-control': ISR } }),
    );

    const first = await serve(runtime, store, FEED_SOURCE, T0 + YEAR);
    const kept = await serve(runtime, store, FEED_SOURCE, T0 + YEAR + SECOND);

    expect(first?.status).toBe(204);
    expect(first?.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
    expect(kept?.status).toBe(204);
    await expect(kept?.text()).resolves.toBe('');
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });
});

describe('a render no generation can hold', () => {
  const ROUTE = '/big/[slug]';
  const PATHNAME = '/big/a';
  const DATA = '/_next/data/build/big/a.json';
  const CHUNK = 1024 * 1024;
  const TOTAL = MAX_CAPTURED_BYTES + 8 * CHUNK;
  const PAGE: ResponseInit = { headers: { 'content-type': 'text/html', 'cache-control': ISR } };

  /** A page's render that writes `TOTAL` bytes as it is read, and says how much of it was. */
  function rendering() {
    const seen = { pulled: 0, cancelled: false };
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const size = Math.min(CHUNK, TOTAL - seen.pulled);
          if (size === 0) {
            controller.close();
            return;
          }
          seen.pulled += size;
          controller.enqueue(new Uint8Array(size));
        },
        cancel() {
          seen.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    return { seen, stream };
  }

  /** A page's response whose render is `rendering()`, made afresh for every call. */
  function renderingPage(): Promise<Response> {
    return Promise.resolve(new Response(rendering().stream, PAGE));
  }

  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('is given up without being read whole or uploaded, and streamed to the visitor', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: ROUTE, kind: 'pages' }]);
    const renders: ReturnType<typeof rendering>[] = [];
    vi.mocked(invokeNodeHandler).mockImplementation(() => {
      const render = rendering();
      renders.push(render);
      return Promise.resolve(new Response(render.stream, PAGE));
    });

    const answer = await serve(
      runtime,
      store,
      {
        route: ROUTE,
        pathname: PATHNAME,
        url: PATHNAME,
        representation: 'html',
        onMiss: 'render',
      },
      T0,
    );
    const [regeneration, visitor] = renders;

    // The regeneration read no further than it took to know, and gave the attempt up.
    expect(regeneration?.seen.pulled).toBeLessThanOrEqual(MAX_CAPTURED_BYTES + CHUNK);
    expect(regeneration?.seen.cancelled).toBe(true);
    expect(authority.calls.filter((call) => call.includes('/artifacts/'))).toStrictEqual([]);
    expect(authority.failures.map((failure) => failure.outcome)).toStrictEqual(['failed']);
    // The visitor's answer went back before any of their render had been read.
    expect(visitor?.seen.pulled).toBe(0);
    expect(answer?.headers.get(CACHE_OUTCOME_HEADER)).toBe('failed');
    expect((await answer?.arrayBuffer())?.byteLength).toBe(TOTAL);
  });

  /** A `HEAD` is told what a `GET` would be answered with, and is sent none of the render. */
  it('answers a HEAD with what the render says, and none of its body', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: ROUTE, kind: 'pages' }]);
    const renders: ReturnType<typeof rendering>[] = [];
    vi.mocked(invokeNodeHandler).mockImplementation(() => {
      const render = rendering();
      renders.push(render);
      return Promise.resolve(new Response(render.stream, PAGE));
    });

    const pending: Promise<unknown>[] = [];
    const source: GenerationSource = {
      route: ROUTE,
      pathname: PATHNAME,
      url: PATHNAME,
      representation: 'html',
      onMiss: 'render',
    };
    const answer = await withClock(T0, () =>
      serveFromGeneration(routed(runtime, PATHNAME, pending, 'HEAD'), store, source, handler),
    );
    await Promise.all(pending);
    const [, visitor] = renders;

    expect(answer?.status).toBe(200);
    expect(answer?.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(answer?.body).toBeNull();
    // The visitor's render was let go of unread.
    expect(visitor?.seen.pulled).toBe(0);
    expect(visitor?.seen.cancelled).toBe(true);
  });

  it('leaves a payload a page off its response cannot answer to the usual path', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: ROUTE, kind: 'pages' }]);
    vi.mocked(invokeNodeHandler).mockImplementation(renderingPage);

    // The App Router's client asks a Pages Router page for its RSC payload on its way to it: the
    // page has none to give, and the answer must not be its document under the payload's type.
    const answer = await serve(
      runtime,
      store,
      { route: ROUTE, pathname: PATHNAME, url: PATHNAME, representation: 'rsc', onMiss: 'render' },
      T0,
    );

    expect(answer).toBeUndefined();
    expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
  });

  it("answers a data request from the page's data route, never from the page read whole", async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: ROUTE, kind: 'pages' }]);
    const renders: ReturnType<typeof rendering>[] = [];
    vi.mocked(invokeNodeHandler).mockImplementation((call) => {
      if (call.url === DATA) {
        return Promise.resolve(Response.json({ pageProps: { slug: 'a' } }, PAGE));
      }
      const render = rendering();
      renders.push(render);
      return Promise.resolve(new Response(render.stream, PAGE));
    });

    const answer = await serve(
      runtime,
      store,
      {
        route: ROUTE,
        pathname: PATHNAME,
        url: DATA,
        representation: 'pages-data',
        dataPathname: DATA,
        onMiss: 'render',
      },
      T0,
    );

    expect(vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => call.url)).toStrictEqual([
      PATHNAME,
      DATA,
    ]);
    expect(renders.map((render) => render.seen.cancelled)).toStrictEqual([true]);
    expect(answer?.headers.get('content-type')).toBe('application/json; charset=utf-8');
    await expect(answer?.json()).resolves.toStrictEqual({ pageProps: { slug: 'a' } });
  });

  /**
   * Too many tags is the contract's own bound, and the gateway would turn the commit away under a
   * schema whose message says nothing about tags — the entry failing every regeneration with no
   * way to read why. Said here instead, under a word of its own, and before the outputs are
   * uploaded: a render the contract will not take is one whose bytes are not worth sending.
   */
  it('gives up a render that left more tags than a generation may carry, before uploading it', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: ROUTE, kind: 'pages' }]);
    const tooMany = Array.from(
      { length: MAX_TAGS_PER_ENTRY + 1 },
      (_, index) => `product-${index}`,
    ).join(',');
    vi.mocked(invokeNodeHandler).mockImplementation(
      answering('<html></html>', {
        headers: {
          'content-type': 'text/html',
          'cache-control': ISR,
          'x-next-cache-tags': tooMany,
        },
      }),
    );

    await serve(
      runtime,
      store,
      { route: ROUTE, pathname: PATHNAME, url: PATHNAME, representation: 'html', onMiss: 'render' },
      T0,
    );

    expect(authority.commits).toHaveLength(0);
    expect(authority.uploads).toHaveLength(0);
    expect(authority.failures).toMatchObject([
      { outcome: 'failed', error: { code: 'too_many_tags' } },
    ]);
  });
});

describe('a generation invalidated again', () => {
  const FEED: RouteEntryDescriptor = {
    kind: 'app-route',
    route: '/api/feed',
    pathname: '/api/feed',
  };
  const SOURCE: GenerationSource = {
    route: FEED.route,
    pathname: FEED.pathname,
    url: FEED.pathname,
    representation: 'route-body',
    onMiss: 'build',
  };

  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  /**
   * A tag revalidated straight after the regeneration another one asked for, within the hold that
   * keeps an entry from being regenerated twice at once: the generation that regeneration
   * published is what the second is for, and was answered as it was until the hold ran out.
   */
  it('is regenerated again within the hold of the regeneration that published it', async () => {
    const authority = fakeAuthority(SCOPE);
    const runtime = runtimeFor(authority);
    const store = storeOf([{ pathname: FEED.route, kind: 'app-route' }]);
    await authority.record(
      FEED,
      {
        cacheTimestamp: T0,
        policy: policyFromCacheControl({ revalidate: 3600, expire: 86_400 }),
        status: 200,
        headers: {},
        tags: [{ kind: 'next-explicit', value: 'feed' }],
      },
      new TextEncoder().encode('built'),
      'build',
    );
    vi.mocked(invokeNodeHandler).mockImplementation(
      answering('regenerated', { headers: { 'cache-control': ISR, 'x-next-cache-tags': 'feed' } }),
    );

    runtime.tags.applyLocal(['feed'], { staleAt: T0 + SECOND, hardExpireAt: null });
    await serveRead(runtime, store, SOURCE, T0 + 2 * SECOND);
    runtime.tags.applyLocal(['feed'], { staleAt: T0 + 3 * SECOND, hardExpireAt: null });
    await serveRead(runtime, store, SOURCE, T0 + 4 * SECOND);

    expect(authority.commits).toHaveLength(2);
  });
});
