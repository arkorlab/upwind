import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';

import type { Prerender } from '@stayingupwind/core/bundle';
import { defaultConfig } from 'next/dist/server/config-shared.js';
import { setRequestMeta } from 'next/dist/server/request-meta.js';
import type { RouteKind } from 'next/dist/server/route-kind.js';
import { RouteModule } from 'next/dist/server/route-modules/route-module.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NodeHandler } from '../src/app-module.ts';
import { withClock } from '../src/cache/clock.ts';
import { type CacheRuntime, createCacheRuntime } from '../src/cache/runtime.ts';
import { type GenerationSource, serveFromGeneration } from '../src/generations.ts';
import { type InvokeInput, invokeNodeHandler } from '../src/node-bridge.ts';
import { appRouteParameters, staticRenderParameters } from '../src/route-parameters.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';
import { type FakeAuthority, fakeAuthority } from './authority.ts';

vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const ROUTE = '/docs/[...slug]';
const HOST = 'https://app.test';
const SCOPE = 'dpl_buildNamedAppParams000';
const NOW = 1_800_000_000_000;
const handler: NodeHandler = () => Promise.resolve();
const CONFIGURED_REWRITE = {
  source: '/docs/:slug*',
  destination: '/docs/:slug*?slug=:slug*&from=config&blank=',
};

/** A real Next.js route module: only manifest loading and instrumentation I/O are supplied. */
class PageModule extends RouteModule {}

function pageModule(configured: boolean): PageModule {
  const page = new PageModule({
    definition: {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-assignment -- Next's ambient const enum has no importable runtime value under verbatimModuleSyntax.
      kind: 'APP_PAGE' as RouteKind,
      pathname: ROUTE,
      page: `${ROUTE}/page`,
      bundlePath: 'app/docs/page',
      filename: 'app/docs/page.js',
    },
    userland: {},
    distDir: '.next',
    relativeProjectDir: '.',
  });
  Object.defineProperties(page, {
    ensureInstrumentation: {
      value: () => Promise.resolve({ absoluteProjectDir: '.', instrumentation: undefined }),
    },
    loadManifests: {
      value: () => {
        return {
          buildId: 'build',
          routesManifest: {
            basePath: '',
            rewrites: {
              beforeFiles: configured ? [CONFIGURED_REWRITE] : [],
              afterFiles: [],
              fallback: [],
            },
          },
          previewProps: {
            previewModeId: 'test',
            previewModeEncryptionKey: '',
            previewModeSigningKey: '',
          },
          serverFilesManifest: { config: defaultConfig },
        };
      },
    },
  });
  return page;
}

/** Next.js prepare resolves the real metadata/query contract before this fixture captures it. */
async function render(page: PageModule, call: InvokeInput): Promise<Response> {
  const request = new IncomingMessage(new Socket());
  request.url = call.url ?? '/';
  request.method = 'GET';
  request.headers = Object.fromEntries(call.request.headers);
  setRequestMeta(request, call.requestMeta);
  try {
    const prepared = await page.prepare(request, null, { srcPage: ROUTE });
    const data = JSON.stringify({
      params: prepared?.params,
      query: prepared?.query,
      key: prepared?.resolvedPathname,
    });
    const capture = call.requestMeta['onCacheEntry'] as
      | ((entry: unknown, meta: { url: string | undefined }) => boolean | Promise<boolean>)
      | undefined;
    if (capture === undefined) return new Response(data);
    await capture(
      {
        value: {
          kind: 'APP_PAGE',
          html: { toUnchunkedString: () => data },
          rscData: new TextEncoder().encode(data),
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
        cacheControl: { revalidate: 60, expire: 3600 },
      },
      { url: call.url },
    );
    return new Response(null);
  } finally {
    request.destroy();
  }
}

function deployment(pathname: string, configured = false): Store {
  const shell: Prerender = {
    id: pathname,
    pathname,
    route: ROUTE,
    parentOutputId: ROUTE,
    groupId: 1,
    routeType: 'page',
    response: 'empty',
    compute: 'blocking',
  };
  const dynamic = {
    sourceRegex: '^/docs/(?<nxtPslug>.+?)(?:/)?$',
    destination: `${ROUTE}?nxtPslug=$nxtPslug`,
  };
  return {
    manifest: {
      buildId: 'build',
      deploymentId: SCOPE,
      config: { basePath: '', i18n: null },
      entrypoints: [{ id: ROUTE, pathname: ROUTE, kind: 'app-page' }],
      routing: {
        beforeMiddleware: [],
        middlewareMatchers: [],
        beforeFiles: configured
          ? [
              {
                sourceRegex: '^/docs/(?<slug>.+?)(?:/)?$',
                destination: '/docs/$slug?slug=$slug&from=config&blank=',
              },
            ]
          : [],
        afterFiles: [],
        fallback: [],
        onMatch: [],
        dynamicRoutes: [dynamic],
        rsc: {
          header: 'rsc',
          prefetchHeader: 'next-router-prefetch',
          prefetchSegmentHeader: 'next-router-segment-prefetch',
        },
      },
    },
    prerendersByPathname: new Map([[pathname, shell]]),
    prerendersById: new Map([[pathname, shell]]),
    shellsByRoute: new Map([[ROUTE, { pages: new Map([[pathname, shell]]), patterns: [] }]]),
    pathnames: [ROUTE, pathname],
    slashSpellings: new Map(),
    staticFiles: new Map(),
    dynamicRoutes: [dynamic],
  } as unknown as Store;
}

function runtimeFor(authority: FakeAuthority): CacheRuntime {
  const runtime = createCacheRuntime({
    env: {
      ARKOR_CACHE_GATEWAY_URL: 'https://cache.test',
      ARKOR_CACHE_TOKEN: 'test',
      NEXT_DEPLOYMENT_ID: SCOPE,
    },
    now: () => NOW,
    fetchImpl: authority.fetchImpl,
  });
  if (runtime === undefined) throw new Error('The test cache was not configured');
  return runtime;
}

function ask(
  runtime: CacheRuntime,
  store: Store,
  source: GenerationSource,
  pending: Promise<unknown>[],
): Promise<Response | undefined> {
  const request = new Request(new URL(source.url, HOST));
  const input: RoutedInput = {
    app: { entries: {} },
    edge: { entries: {} },
    request,
    initURL: request.url,
    cache: runtime,
    run: (work) => work(),
    waitUntil: (work) => {
      pending.push(work);
    },
  };
  return withClock(NOW, () => serveFromGeneration(input, store, source, handler));
}

async function settle(pending: Promise<unknown>[]): Promise<void> {
  while (pending.length > 0) await Promise.all(pending.splice(0));
}

describe('an App Router generation rendered by the build’s member name', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['/docs/100%20/a%2Fb', '/docs/100%2520/a%2Fb', ['100%20', 'a/b']],
    ['/docs/100%/a%2Fb', '/docs/100%25/a%2Fb', ['100%', 'a/b']],
    ['/docs/literal%252F/a%2Fb', '/docs/literal%252F/a%2Fb', ['literal%2F', 'a/b']],
  ] as const)(
    'publishes %s under its own cache key with the original parameter values',
    async (pathname, url, slug) => {
      const authority = fakeAuthority(SCOPE, { keepOutputs: true, handsBackRecords: true });
      const store = deployment(pathname);
      const source: GenerationSource = {
        route: ROUTE,
        pathname,
        url,
        representation: 'html',
        onMiss: 'render',
      };
      const page = pageModule(false);
      vi.mocked(invokeNodeHandler).mockImplementation((call) => render(page, call));
      const pending: Promise<unknown>[] = [];

      const first = await ask(runtimeFor(authority), store, source, pending);

      await expect(first?.json()).resolves.toStrictEqual({
        params: { slug },
        query: {},
        key: pathname,
      });

      await settle(pending);
      const cached = await ask(runtimeFor(authority), store, source, pending);

      await expect(cached?.json()).resolves.toStrictEqual({
        params: { slug },
        query: {},
        key: pathname,
      });
      expect(authority.commits).toHaveLength(1);
      expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
      expect(authority.failures).toHaveLength(0);
    },
  );

  it.each([
    ['/docs/100%20/a%2Fb', '/docs/100%2520/a%2Fb', ['100%20', 'a/b']],
    ['/docs/100%20', '/docs/100%2520', ['100%20']],
  ] as const)(
    'keeps configured extras for %s without route parameters or visitor query',
    async (pathname, url, slug) => {
      const store = deployment(pathname, true);
      const authority = fakeAuthority(SCOPE, { keepOutputs: true, handsBackRecords: true });
      const source: GenerationSource = {
        route: ROUTE,
        pathname,
        url: `${url}?visitor=secret&slug=attacker`,
        representation: 'html',
        onMiss: 'render',
      };
      const page = pageModule(true);
      vi.mocked(invokeNodeHandler).mockImplementation((call) => render(page, call));
      const pending: Promise<unknown>[] = [];

      const response = await ask(runtimeFor(authority), store, source, pending);

      const expected = { params: { slug }, query: { from: 'config', blank: '' }, key: pathname };

      await expect(response?.json()).resolves.toStrictEqual(expected);

      await settle(pending);

      const cached = await ask(runtimeFor(authority), store, source, pending);

      await expect(cached?.json()).resolves.toStrictEqual(expected);

      expect(authority.commits).toHaveLength(1);
      expect(invokeNodeHandler).toHaveBeenCalledTimes(1);
      expect(authority.failures).toHaveLength(0);
    },
  );

  it('distinguishes request spelling from a coincidentally identical build name', () => {
    const pathname = '/docs/100%20/a%2Fb';
    const store = deployment(pathname);

    expect(appRouteParameters(store, ROUTE, pathname)).toStrictEqual({ slug: ['100 ', 'a/b'] });
    expect(staticRenderParameters(store, ROUTE, pathname).routeParams).toStrictEqual({
      slug: ['100%20', 'a/b'],
    });
    expect(staticRenderParameters(store, ROUTE, pathname, 'request').routeParams).toStrictEqual({
      slug: ['100 ', 'a/b'],
    });
  });

  it.each(['/another?from=another', '/docs/changed%2Fvalue?from=another'])(
    'refuses query values resolved for %s without fetching it',
    async (destination) => {
      const pathname = '/docs/100%20/a%2Fb';
      const base = deployment(pathname, true);
      const store: Store = {
        ...base,
        manifest: {
          ...base.manifest,
          entrypoints: [
            ...base.manifest.entrypoints,
            { id: '/another', pathname: '/another', kind: 'app-page' },
          ],
          routing: {
            ...base.manifest.routing,
            beforeFiles: [{ sourceRegex: '^/docs/.*$', destination }],
          },
        },
        pathnames: [...base.pathnames, '/another'],
      };
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      const parameters = staticRenderParameters(store, ROUTE, pathname);

      await expect(
        parameters.prepareQuery?.(new Request(`${HOST}/docs/100%2520/a%2Fb`)),
      ).rejects.toThrow('must resolve to its own local entry');
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});
