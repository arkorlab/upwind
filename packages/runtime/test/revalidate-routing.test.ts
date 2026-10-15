import { resolveRoutes } from '@next/routing';
import type { Prerender } from '@stayingupwind/core/bundle';
import { IMPLICIT_TAG_PREFIX } from '@stayingupwind/core/cache';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InvalidatedTags, RequestWrites, withRequestContext } from '../src/cache/context.ts';
import { invalidateNow } from '../src/cache/handlers.ts';
import { regenerate } from '../src/cache/regenerate.ts';
import { platformRevalidate } from '../src/cache/revalidate.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { nodeHandlerOf } from '../src/entries.ts';
import { escapedNameOf } from '../src/name-spellings.ts';
import { elsewhere } from '../src/placement.ts';
import { pathnamesFor } from '../src/routing.ts';
import { getStore, routerPathnames, type Store } from '../src/store.ts';

vi.mock(import('../src/entries.ts'), () => ({ nodeHandlerOf: vi.fn() }));
vi.mock(import('../src/cache/regenerate.ts'), () => ({ regenerate: vi.fn() }));
vi.mock(import('../src/cache/handlers.ts'), async (importOriginal) => ({
  ...(await importOriginal()),
  invalidateNow: vi.fn(),
}));
vi.mock(import('../src/placement.ts'), () => ({ elsewhere: vi.fn() }));
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));
vi.mock(import('../src/store.ts'), async (importOriginal) => {
  return {
    ...(await importOriginal()),
    getStore: vi.fn(),
  };
});

/** One source route, with a concrete seed when the adapter writes one before its template. */
interface Route {
  readonly route: string;
  readonly pattern: RegExp;
  readonly seed?: string;
}

function deployment(routes: readonly Route[]): Store {
  const shells = routes.map(({ route, pattern, seed }) => {
    const prerender: Prerender = {
      id: route,
      route,
      pathname: route,
      parentOutputId: route,
      groupId: 1,
    };
    return [
      route,
      {
        pages: new Map(seed === undefined ? [] : [[seed, { ...prerender, pathname: seed }]]),
        patterns: [{ pattern, prerender }],
      },
    ] as const;
  });
  return {
    manifest: {
      buildId: 'build',
      entrypoints: routes.map(({ route }) => ({ id: route, pathname: route, kind: 'pages' })),
      config: { basePath: '', i18n: null },
    },
    shellsByRoute: new Map(shells),
    prerendersByPathname: new Map(),
    pathnames: routes.map(({ route }) => route),
    slashSpellings: new Map(),
  } as unknown as Store;
}

/** Concrete output, and the two source routes that can answer it, shaped as the adapter emits. */
function seededDeployment(
  closed: boolean,
  trailingSlash: boolean,
  localized: boolean,
  seed = 'seed',
): Store {
  const basePath = localized ? '/base' : '';
  const prefix = localized ? '/base/en' : '';
  const catchAll = `${basePath}/[...rest]`;
  const specific = `${basePath}/[id]`;
  const page: Prerender = {
    id: `${prefix}/${seed}`,
    route: catchAll,
    pathname: `${prefix}/${seed}`,
    parentOutputId: catchAll,
    groupId: 1,
    parentFallbackMode: closed ? false : 'fallback.html',
    allowHeader: ['x-example'],
  };
  const specificShell: Prerender = {
    id: specific,
    route: specific,
    pathname: `${prefix}/[id]`,
    parentOutputId: specific,
    groupId: 2,
  };
  const catchAllShell: Prerender = {
    id: catchAll,
    route: catchAll,
    pathname: `${prefix}/[...rest]`,
    parentOutputId: catchAll,
    groupId: 3,
  };
  const dynamicRoutes = [
    { sourceRegex: `^${prefix}/([^/]+?)(?:/)?$`, destination: specific },
    { sourceRegex: `^${prefix}/(.+?)(?:/)?$`, destination: catchAll },
  ];
  const manifest = {
    buildId: 'build',
    config: {
      basePath,
      trailingSlash,
      i18n: localized ? { defaultLocale: 'en', locales: ['en'] } : null,
    },
    entrypoints: [catchAll, specific].map((route) => {
      return {
        id: route,
        pathname: route,
        kind: 'pages',
      };
    }),
    prerenders: [page, specificShell, ...(closed ? [] : [catchAllShell])],
    staticFiles: [],
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes,
      onMatch: [],
      fallback: [],
    },
  } as unknown as Store['manifest'];
  return {
    manifest,
    ...routerPathnames(manifest),
    staticFiles: new Map(),
    prerendersByPathname: new Map(manifest.prerenders.map((one) => [one.pathname, one])),
    shellsByRoute: new Map([
      [
        catchAll,
        {
          pages: new Map([[page.pathname, page]]),
          patterns: closed ? [] : [{ pattern: /^\/.+$/u, prerender: catchAllShell }],
        },
      ],
      [
        specific,
        {
          pages: new Map(),
          patterns: [{ pattern: /^\/(?:base\/en\/)?[^/]+\/?$/u, prerender: specificShell }],
        },
      ],
    ]),
    dynamicRoutes,
  } as unknown as Store;
}

/** What the installed Next.js router resolves, using this deployment's actual named pathnames. */
async function routedPage(store: Store, pathname: string): Promise<string | undefined> {
  const { config } = store.manifest;
  const result = await resolveRoutes({
    url: new URL(pathname, 'https://app.test'),
    headers: new Headers(),
    requestBody: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    buildId: store.manifest.buildId,
    basePath: config.basePath,
    pathnames: pathnamesFor(store, new URL(pathname, 'https://app.test')),
    routes: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: store.dynamicRoutes.map(({ sourceRegex, destination }) => {
        return {
          sourceRegex,
          ...(destination !== undefined && { destination }),
        };
      }),
      onMatch: [],
      fallback: [],
    },
    ...(config.i18n !== null &&
      config.i18n !== undefined && {
        i18n: { defaultLocale: config.i18n.defaultLocale, locales: config.i18n.locales },
      }),
    invokeMiddleware: () => Promise.resolve({}),
  });
  return result.resolvedPathname;
}

function revalidate(store: Store, urlPath: string, remote = false): Promise<void> {
  vi.mocked(getStore).mockReturnValue(store);
  vi.mocked(nodeHandlerOf).mockResolvedValue(remote ? undefined : () => Promise.resolve());
  vi.mocked(regenerate).mockResolvedValue({
    kind: 'accepted',
    render: {
      html: new Uint8Array(),
      postponed: undefined,
      rscData: undefined,
      segments: new Map(),
      headers: {},
      status: 200,
      cacheControl: { revalidate: 60, expire: undefined },
      data: undefined,
    },
    published: Promise.resolve({ kind: 'published', generationId: 'new' }),
  });
  return withRequestContext(
    {
      request: new Request('https://app.test/api/revalidate'),
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime: {} as CacheRuntime,
      startedAt: 0,
      fetchStarts: new Map(),
      waitUntil: () => {
        // Regeneration is replaced; no background work is started.
      },
      run: (work) => work(),
      invalidated: new InvalidatedTags(),
      writes: new RequestWrites(),
    },
    () => platformRevalidate({ urlPath }),
  );
}

describe('manual revalidation route precedence', () => {
  afterEach(() => vi.clearAllMocks());

  it.each(
    [false, true].flatMap((closed) => {
      return [false, true].flatMap((trailingSlash) =>
        [false, true].map((localized) => ({ closed, trailingSlash, localized })),
      );
    }),
  )(
    'matches real routing for a seed with closed=$closed, trailingSlash=$trailingSlash, localized=$localized',
    async ({ closed, trailingSlash, localized }) => {
      const store = seededDeployment(closed, trailingSlash, localized);
      const prefix = localized ? '/base/en' : '';
      const sourcePrefix = localized ? '/base' : '';
      const concrete = `${prefix}/seed`;
      const path = `${concrete}${trailingSlash ? '/' : ''}`;
      const selected = await routedPage(store, path);
      const named =
        selected === undefined ? undefined : (store.slashSpellings.get(selected) ?? selected);
      const routed = named === undefined ? undefined : store.prerendersByPathname.get(named)?.route;
      const expected = `${sourcePrefix}/${closed ? '[...rest]' : '[id]'}`;

      expect(routed ?? selected).toBe(expected);

      await revalidate(store, path);

      expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual({
        kind: 'pages',
        route: expected,
        pathname: concrete,
      });
      expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.allowHeader).toStrictEqual(
        closed ? ['x-example'] : undefined,
      );
      expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.dataPathname).toBe(
        `${sourcePrefix}/_next/data/build/${localized ? 'en/' : ''}seed.json`,
      );
    },
  );

  it.each([false, true])(
    'invalidates the canonical concrete path in another Function, localized=%s',
    async (localized) => {
      const seeded = seededDeployment(true, true, localized);
      const store = {
        ...seeded,
        manifest: {
          ...seeded.manifest,
          entrypoints: seeded.manifest.entrypoints.map((entry) => {
            return {
              ...entry,
              kind: 'app-page' as const,
            };
          }),
        },
      };
      vi.mocked(elsewhere).mockReturnValue('app-other');
      const canonical = `${localized ? '/base/en' : ''}/seed`;

      await revalidate(store, `${canonical}/`, true);

      expect(invalidateNow).toHaveBeenCalledWith(expect.anything(), [
        `${IMPLICIT_TAG_PREFIX}${canonical}`,
      ]);
      expect(regenerate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { seed: 'seed', asked: '/s%65ed/', canonical: '/seed', closed: true, route: '/[...rest]' },
    {
      seed: 'hello world',
      asked: '/hello%20world/',
      canonical: '/hello world',
      closed: true,
      route: '/[...rest]',
    },
    {
      seed: 'hello world',
      asked: '/hello%20world/',
      canonical: '/hello%20world',
      closed: false,
      route: '/[id]',
    },
    { seed: 'a/b', asked: '/a%2Fb/', canonical: '/a%2Fb', closed: true, route: '/[id]' },
  ])(
    'revalidates the router-selected page for $asked with closed=$closed',
    async ({ seed, asked, canonical, closed, route }) => {
      const store = seededDeployment(closed, true, false, seed);
      const selected = await routedPage(store, asked);
      const name =
        selected === undefined ? undefined : (escapedNameOf(store, selected) ?? selected);
      const named = name === undefined ? undefined : (store.slashSpellings.get(name) ?? name);
      const routed = named === undefined ? undefined : store.prerendersByPathname.get(named)?.route;

      expect(routed ?? selected).toBe(route);

      await revalidate(store, asked);

      const target = vi.mocked(regenerate).mock.calls[0]?.[0].target;

      expect(target?.descriptor).toStrictEqual({ kind: 'pages', route, pathname: canonical });
      expect(target?.dataPathname).toBe(`/_next/data/build${canonical}.json`);
    },
  );

  it('regenerates an unbuilt specific page ahead of the catch-all whose seed was emitted first', async () => {
    const store = deployment([
      { route: '/[...rest]', pattern: /^\/.+$/u, seed: '/seed' },
      { route: '/blog/[id]', pattern: /^\/blog\/[^/]+$/u },
    ]);

    await revalidate(store, '/blog/new?webhook=1');

    expect(vi.mocked(regenerate).mock.calls[0]?.[0].target.descriptor).toStrictEqual({
      kind: 'pages',
      route: '/blog/[id]',
      pathname: '/blog/new',
    });
  });

  it('compares specificity at the first differing segment rather than counting dynamic segments', async () => {
    const store = deployment([
      { route: '/[id]/edit', pattern: /^\/[^/]+\/edit$/u },
      { route: '/blog/[...all]', pattern: /^\/blog\/.+$/u },
    ]);

    await revalidate(store, '/blog/edit');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/blog/[...all]');
  });

  it('prefers a literal page, then a dynamic page, ahead of an optional catch-all', async () => {
    const store = deployment([
      { route: '/docs/[[...rest]]', pattern: /^\/docs(?:\/.*)?$/u },
      { route: '/docs/[id]', pattern: /^\/docs\/[^/]+$/u },
      { route: '/docs/fixed', pattern: /^\/docs\/fixed$/u },
    ]);

    await revalidate(store, '/docs/fixed');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/docs/fixed');

    await revalidate(store, '/docs/new');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/docs/[id]');

    await revalidate(store, '/docs');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/docs/[[...rest]]');
  });

  it('prepares route order once for each immutable store', async () => {
    const store = deployment([{ route: '/blog/[id]', pattern: /^\/blog\/[^/]+$/u }]);
    const keys = vi.spyOn(store.shellsByRoute, 'keys');

    await revalidate(store, '/blog/first');
    await revalidate(store, '/blog/second');

    expect(keys).toHaveBeenCalledTimes(1);
    expect(regenerate).toHaveBeenCalledTimes(2);
  });

  it('treats an incomplete bracket segment as a literal ahead of a dynamic route', async () => {
    const store = deployment([
      { route: '/[id]', pattern: /^\/[^/]+$/u, seed: '/seed' },
      { route: '/[literal', pattern: /^\/\[literal$/u },
    ]);

    await revalidate(store, '/[literal');

    expect(nodeHandlerOf).toHaveBeenLastCalledWith(expect.anything(), '/[literal');
  });
});
