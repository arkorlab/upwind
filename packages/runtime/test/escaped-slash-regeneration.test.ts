import { AsyncLocalStorage } from 'node:async_hooks';

import type { Prerender } from '@stayingupwind/core/bundle';
import { installResourcePrimaryReadStorage } from '@stayingupwind/core/paas';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { nowMs, withClock } from '../src/cache/clock.ts';
import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { type GenerationSource, serveFromGeneration } from '../src/generations.ts';
import { invokeNodeHandler } from '../src/node-bridge.ts';
import { warmResourceRoute } from '../src/resource-warm.ts';
import { routingParameters } from '../src/route-parameters.ts';
import type { RoutedInput } from '../src/serve.ts';
import { getStore, type Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

/**
 * An escaped `/` in a catch-all value of a Pages Router member, read by a regeneration as routing
 * reads it for a render of a visitor's request.
 *
 * Routing hands a catch-all's value over decoded, its segments joined by `/`, and Next.js splits it
 * there: `/pages-cache/..%2F..%2Fx` is `['..', '..', 'x']`, which is what Next.js asks of an
 * adapter's deployment (`incremental-cache-path-traversal`). A regeneration rendered the member by
 * its name alone, which Next.js matches as `next start` does — the path split first, each segment
 * decoded after — and read `['../../x']`. The generation it published said that, and so did every
 * answer from it, where a render of the request said the other; which of the two answered turned
 * on whether the entry's record was read within its deadline.
 */

function nodeBridge(): { invokeNodeHandler: Mock } {
  return { invokeNodeHandler: vi.fn() };
}

vi.mock(import('../src/node-bridge.ts'), nodeBridge);
vi.mock(import('../src/store.ts'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, getStore: vi.fn() };
});

const SCOPE = 'dpl_escapedSlashUnderTest0';
const HOST = 'https://app.test';
const T0 = 1_800_000_000_000;
const ISR = 's-maxage=3600, stale-while-revalidate=31532400';
const ENV = {
  ARKOR_CACHE_GATEWAY_URL: 'https://regional.test',
  ARKOR_CACHE_READ_GATEWAY_URL: 'https://local.test',
  ARKOR_CACHE_TOKEN: 'test-scope-token',
  NEXT_DEPLOYMENT_ID: SCOPE,
};
const ROUTE = '/pages-cache/[...rest]';
/** Nothing here runs a handler: the bridge that would is replaced, and says what it answers. */
const handler: NodeHandler = () => Promise.reject(new Error('the bridge is replaced'));

interface Config {
  readonly basePath: string;
  readonly i18n: { readonly locales: readonly string[]; readonly defaultLocale: string } | null;
}

/** An application with no base path and no locales. */
const PLAIN: Config = { basePath: '', i18n: null };

function prerenderOf(pathname: string, route: string): Prerender {
  return { id: pathname, pathname, route, parentOutputId: route, groupId: 1 };
}

/** A deployment whose only route is the Pages Router page `route`, as much of it as is read here. */
function storeOf(
  route: string,
  config: Config = PLAIN,
  prerendered: readonly string[] = [],
): Store {
  const prerenders = [route, ...prerendered].map((pathname) => prerenderOf(pathname, route));
  return {
    manifest: {
      buildId: 'build',
      deploymentId: SCOPE,
      entrypoints: [{ pathname: route, kind: 'pages' }],
      config,
    },
    prerendersByPathname: new Map(prerenders.map((prerender) => [prerender.pathname, prerender])),
    shellsByRoute: new Map([
      [route, { pages: new Map(), patterns: [{ pattern: /^\//u, prerender: prerenders[0] }] }],
    ]),
    pathnames: [route],
    slashSpellings: new Map(),
  } as unknown as Store;
}

describe('routingParameters', () => {
  it('names a catch-all whose segment holds an escaped slash as routing does', () => {
    expect(
      routingParameters(storeOf(ROUTE), ROUTE, '/pages-cache/..%2F..%2Fserver-reference-manifest'),
    ).toStrictEqual({ nxtPrest: '../../server-reference-manifest' });
    expect(routingParameters(storeOf(ROUTE), ROUTE, '/pages-cache/a%2Fb/c')).toStrictEqual({
      nxtPrest: 'a/b/c',
    });
  });

  it('names none where Next.js reads the name the same way', () => {
    const store = storeOf(ROUTE);
    const slug = '/docs/[slug]';

    expect(routingParameters(store, ROUTE, '/pages-cache/a/b')).toBeUndefined();
    expect(routingParameters(store, ROUTE, '/pages-cache/space%20here')).toBeUndefined();
    // A `%2F` the value holds as text, escaped again in the member's name: no separator in it.
    expect(routingParameters(store, ROUTE, '/pages-cache/a%252Fb')).toBeUndefined();
    // A parameter that is not a catch-all keeps an escaped slash as one value either way.
    expect(routingParameters(storeOf(slug), slug, '/docs/a%2Fb')).toBeUndefined();
  });

  it('names every parameter of the route once it names one', () => {
    const route = '/[lang]/docs/[...slug]';

    expect(routingParameters(storeOf(route), route, '/en/docs/a%2Fb')).toStrictEqual({
      nxtPlang: 'en',
      nxtPslug: 'a/b',
    });
  });

  it('reads an optional catch-all, and leaves one that holds nothing', () => {
    const route = '/docs/[[...slug]]';

    expect(routingParameters(storeOf(route), route, '/docs/a%2Fb')).toStrictEqual({
      nxtPslug: 'a/b',
    });
    expect(routingParameters(storeOf(route), route, '/docs')).toBeUndefined();
  });

  it("reads a locale's member without its locale, and a member by its prerender's route", () => {
    const route = '/blog/[...slug]';
    const store = storeOf(
      route,
      { basePath: '', i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } },
      ['/fr/blog/a%2Fb'],
    );

    expect(routingParameters(store, route, '/fr/blog/a%2Fb')).toStrictEqual({
      nxtPslug: 'a/b',
    });
    expect(routingParameters(store, '/fr/blog/a%2Fb', '/fr/blog/a%2Fb')).toStrictEqual({
      nxtPslug: 'a/b',
    });
  });

  it('names none for a member that does not line up with the route, or does not decode', () => {
    const store = storeOf(ROUTE);

    expect(routingParameters(store, ROUTE, '/elsewhere/a%2Fb')).toBeUndefined();
    expect(routingParameters(store, ROUTE, '/pages-cache/%E0%A4%A/a%2Fb')).toBeUndefined();
  });

  /**
   * A member the build prerendered is named as the build names a value — its delimiters escaped and
   * nothing else — and one rendered on demand as its request spelled it. Routing reads either as
   * the request for it spells it, decoded once: `/docs/100%2520/a%2Fb`, the build's
   * `/docs/100%20/a%2Fb`, holds `100%20` and `a/b`.
   */
  it('reads a name the build gave as the build wrote it, and a request’s as routing decodes it', () => {
    const route = '/docs/[...slug]';
    const named = '/docs/100%20/a%2Fb';

    expect(routingParameters(storeOf(route, PLAIN, [named]), route, named)).toStrictEqual({
      nxtPslug: '100%20/a/b',
    });
    expect(routingParameters(storeOf(route), route, '/docs/100%2520/a%2Fb')).toStrictEqual({
      nxtPslug: '100%20/a/b',
    });
    // The build escapes a value's own `%2F` again; read back, it is the text it was.
    expect(
      routingParameters(
        storeOf(route, PLAIN, ['/docs/a%252Fb/c%2Fd']),
        route,
        '/docs/a%252Fb/c%2Fd',
      ),
    ).toStrictEqual({ nxtPslug: 'a%2Fb/c/d' });
  });

  it('reads a fixed segment a request spelled escaped as the route spells it', () => {
    const route = '/記事/[...slug]';

    expect(routingParameters(storeOf(route), route, '/%E8%A8%98%E4%BA%8B/a%2Fb')).toStrictEqual({
      nxtPslug: 'a/b',
    });
    expect(
      routingParameters(storeOf(route, PLAIN, ['/記事/a%2Fb']), route, '/記事/a%2Fb'),
    ).toStrictEqual({ nxtPslug: 'a/b' });
  });

  it('reads a locale in any case, as routing does', () => {
    const route = '/blog/[...slug]';
    const locales: Config = { basePath: '', i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } };

    expect(routingParameters(storeOf(route, locales), route, '/FR/blog/a%2Fb')).toStrictEqual({
      nxtPslug: 'a/b',
    });
  });

  it('takes a fixed segment the build spells like an escape as it is spelled', () => {
    const route = '/docs/%2F/[...slug]';
    const named = '/docs/%2F/a%2Fb';

    expect(routingParameters(storeOf(route, PLAIN, [named]), route, named)).toStrictEqual({
      nxtPslug: 'a/b',
    });
  });

  it('reads a member as routing does: without its end slash, and its fixed segments in any case', () => {
    expect(routingParameters(storeOf(ROUTE), ROUTE, '/pages-cache/a%2Fb/')).toStrictEqual({
      nxtPrest: 'a/b',
    });
    expect(routingParameters(storeOf(ROUTE), ROUTE, '/PAGES-CACHE/a%2Fb')).toStrictEqual({
      nxtPrest: 'a/b',
    });
  });
});

function runtimeFor(authority: FakeAuthority): CacheRuntime {
  const runtime = createCacheRuntime({ env: ENV, now: nowMs, fetchImpl: authority.fetchImpl });
  if (runtime === undefined) {
    throw new Error('the runtime was not configured');
  }
  return runtime;
}

function routed(runtime: CacheRuntime, path: string, pending: Promise<unknown>[]): RoutedInput {
  const request = new Request(`${HOST}${path}`);
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

/**
 * The page's `rest`, as Next.js reads it from what it is handed: the query's `nxtPrest` split at
 * its `/` where routing named one, and otherwise the path matched — split first, each segment
 * decoded after.
 */
function restOf(url: string): string[] {
  const parsed = new URL(url, HOST);
  const named = parsed.searchParams.get('nxtPrest');
  if (named !== null) {
    return named.split('/');
  }
  return parsed.pathname
    .slice('/pages-cache/'.length)
    .split('/')
    .map((segment) => decodeURIComponent(segment));
}

/** The page's document, its props in `__NEXT_DATA__` as Next.js writes them. */
function pageFor(url: string): Promise<Response> {
  const data = JSON.stringify({ props: { pageProps: { rest: restOf(url) }, __N_SSG: true } });
  const html = `<html><body><script id="__NEXT_DATA__" type="application/json">${data}</script></body></html>`;
  return Promise.resolve(
    new Response(html, { headers: { 'content-type': 'text/html', 'cache-control': ISR } }),
  );
}

async function settle(pending: readonly Promise<unknown>[]): Promise<void> {
  for (let settled = 0; settled < pending.length;) {
    const batch = pending.slice(settled);
    settled = pending.length;
    await Promise.all(batch);
  }
}

/** The props a data request for `pathname` is answered, and the URLs the renders were handed. */
async function propsFor(
  runtime: CacheRuntime,
  pathname: string,
): Promise<{ readonly props: unknown; readonly urls: readonly string[] }> {
  const data = `/_next/data/build${pathname}.json`;
  const source: GenerationSource = {
    route: ROUTE,
    pathname,
    url: data,
    representation: 'pages-data',
    dataPathname: data,
    onMiss: 'render',
  };
  const pending: Promise<unknown>[] = [];
  const answer = await withClock(T0, () =>
    serveFromGeneration(routed(runtime, data, pending), storeOf(ROUTE), source, handler),
  );
  const props: unknown = await answer?.json();
  await settle(pending);
  return { props, urls: vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => call.url ?? '') };
}

describe("a Pages Router member's regeneration", () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
  });

  it('reads an escaped slash in a catch-all as a render of the request reads it', async () => {
    const runtime = runtimeFor(fakeAuthority(SCOPE));
    vi.mocked(invokeNodeHandler).mockImplementation((call) => pageFor(call.url ?? ''));

    const { props, urls } = await propsFor(runtime, '/pages-cache/..%2F..%2Fx');

    expect(urls).toStrictEqual(['/pages-cache/..%2F..%2Fx?nxtPrest=..%2F..%2Fx']);
    expect(props).toStrictEqual({ pageProps: { rest: ['..', '..', 'x'] }, __N_SSG: true });
  });

  it('renders any other member by its name alone, as it did', async () => {
    const runtime = runtimeFor(fakeAuthority(SCOPE));
    vi.mocked(invokeNodeHandler).mockImplementation((call) => pageFor(call.url ?? ''));

    const { props, urls } = await propsFor(runtime, '/pages-cache/a/b');

    expect(urls).toStrictEqual(['/pages-cache/a/b']);
    expect(props).toStrictEqual({ pageProps: { rest: ['a', 'b'] }, __N_SSG: true });
  });
});

/** A request this runtime answers, for a call made from inside it. */
function contextOf(runtime: CacheRuntime) {
  return {
    tables: { app: { entries: { [ROUTE]: () => ({ handler }) } }, edge: { entries: {} } },
    runtime,
    request: new Request(`${HOST}/api/revalidate`),
    startedAt: T0,
    fetchStarts: new Map<string, number>(),
    waitUntil: () => {
      // What the regeneration hands the runtime is what the call itself waits on.
    },
    run: <T>(work: () => Promise<T>) => work(),
    invalidated: new InvalidatedTags(),
    writes: new RequestWrites(),
  };
}

/** `res.revalidate(urlPath)`, called from a request `runtime` answers. */
function revalidate(runtime: CacheRuntime, urlPath: string): Promise<void> {
  return withClock(T0, () =>
    withRequestContext(contextOf(runtime), () => platformRevalidate({ urlPath })),
  );
}

describe('every other regeneration of a Pages Router member', () => {
  afterEach(() => {
    vi.mocked(invokeNodeHandler).mockReset();
    vi.mocked(getStore).mockReset();
  });

  it('hands `res.revalidate()`’s render the parameters as routing does', async () => {
    const runtime = runtimeFor(fakeAuthority(SCOPE));
    vi.mocked(getStore).mockReturnValue(storeOf(ROUTE));
    vi.mocked(invokeNodeHandler).mockImplementation((call) => pageFor(call.url ?? ''));

    await revalidate(runtime, '/pages-cache/..%2F..%2Fx');

    expect(vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => call.url)).toStrictEqual([
      '/pages-cache/..%2F..%2Fx?nxtPrest=..%2F..%2Fx',
    ]);
  });

  it("hands a host's warming of the entry the same", async () => {
    // What the runtime installs as it starts, and the warming reads under.
    installResourcePrimaryReadStorage(new AsyncLocalStorage<true>());
    const runtime = runtimeFor(fakeAuthority(SCOPE));
    vi.mocked(getStore).mockReturnValue(storeOf(ROUTE));
    vi.mocked(invokeNodeHandler).mockImplementation((call) => pageFor(call.url ?? ''));
    const pathname = '/pages-cache/..%2F..%2Fx';

    const result = await withClock(T0, () => {
      return warmResourceRoute({
        props: { v: 1, scopeId: SCOPE, entry: { kind: 'pages', route: ROUTE, pathname } },
        tables: contextOf(runtime).tables,
        request: new Request(`${HOST}${pathname}`),
        runtime,
        waitUntil: () => {
          // The warming answers once its publish has: nothing is left behind it here.
        },
      });
    });

    expect(result.kind).toBe('published');
    expect(vi.mocked(invokeNodeHandler).mock.calls.map(([call]) => call.url)).toStrictEqual([
      `${pathname}?nxtPrest=..%2F..%2Fx`,
    ]);
  });
});
