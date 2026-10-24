import { resolveRoutes } from '@next/routing';
import type { Route } from '@stayingupwind/core/bundle';
import { describe, expect, it } from 'vitest';

import { landedRoute, routingI18n, routingTables } from '../../src/routing.ts';
import { routerDynamicRoutes, routerPathnames, type Store } from '../../src/store.ts';

/**
 * A dynamic API route of an application with `i18n`.
 *
 * `next build` writes every dynamic route of such an application to match behind a locale, and
 * `@next/routing` puts none in front of an `/api/` path: `/api/blog/first` matched nothing and
 * answered 404. Next.js's router takes the locale out before it matches an API route, and matches
 * none for an API path asked for behind one.
 */

const I18N = { defaultLocale: 'en', locales: ['en', 'fr'] };

/** The dynamic routes as `next build` writes them for `pages/api/blog/[slug].js` and `pages/[slug].js`. */
function dynamicRoutes(basePath: string): Route[] {
  return [
    {
      source: '/api/blog/[slug]',
      sourceRegex: `^${basePath}[/]?(?<nextLocale>[^/]{1,})/api/blog/(?<nxtPslug>[^/]+?)(?:/)?$`,
      destination: `${basePath}/$nextLocale/api/blog/[slug]?nxtPslug=$nxtPslug`,
    },
    {
      source: '/[slug]',
      sourceRegex: `^${basePath}[/]?(?<nextLocale>[^/]{1,})/(?<nxtPslug>[^/]+?)(?:/)?$`,
      destination: `${basePath}/$nextLocale/[slug]?nxtPslug=$nxtPslug`,
    },
  ];
}

function storeOf(basePath = '', i18n: typeof I18N | null = I18N): Store {
  const manifest = {
    buildId: 'b',
    config: {
      basePath,
      trailingSlash: false,
      skipTrailingSlashRedirect: false,
      poweredByHeader: true,
      i18n,
    },
    routing: {
      beforeMiddleware: [],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: dynamicRoutes(basePath),
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: true,
    },
    entrypoints: [
      {
        id: `${basePath}/api/blog/[slug]`,
        kind: 'pages-api' as const,
        pathname: `${basePath}/api/blog/[slug]`,
      },
      { id: `${basePath}/en/[slug]`, kind: 'pages' as const, pathname: `${basePath}/en/[slug]` },
      { id: `${basePath}/fr/[slug]`, kind: 'pages' as const, pathname: `${basePath}/fr/[slug]` },
    ],
    prerenders: [],
    staticFiles: [],
  };
  return {
    manifest,
    prerendersByPathname: new Map(),
    staticFiles: new Map(),
    ...routerPathnames(manifest),
    dynamicRoutes: routerDynamicRoutes(manifest),
  } as unknown as Store;
}

/** The route a request resolves to and the query its handler is handed, or that it resolves to none. */
async function resolvedFor(store: Store, path: string) {
  const { basePath, i18n } = store.manifest.config;
  const routed = await resolveRoutes({
    url: new URL(`https://app.example${path}`),
    buildId: 'b',
    basePath,
    requestBody: new ReadableStream(),
    headers: new Headers(),
    pathnames: store.pathnames,
    ...(i18n !== null && i18n !== undefined && { i18n: routingI18n(i18n) }),
    routes: routingTables(store, true, new URL(`https://app.example${path}`), false),
    invokeMiddleware: () => Promise.resolve({}),
  });
  if (routed.resolvedPathname === undefined || routed.invocationTarget === undefined) {
    return 'unrouted';
  }
  const { route, target } = landedRoute(store, routed.resolvedPathname, routed.invocationTarget);
  return { route, query: target.query };
}

describe('a dynamic API route of an application with i18n', () => {
  it('is matched without a locale, as Next.js matches it', async () => {
    await expect(resolvedFor(storeOf(), '/api/blog/first')).resolves.toStrictEqual({
      route: '/api/blog/[slug]',
      query: { nxtPslug: 'first' },
    });
  });

  it('is matched under the base path', async () => {
    await expect(resolvedFor(storeOf('/docs'), '/docs/api/blog/first')).resolves.toStrictEqual({
      route: '/docs/api/blog/[slug]',
      query: { nxtPslug: 'first' },
    });
  });

  it('is not matched behind a locale, as Next.js matches no API route there', async () => {
    await expect(resolvedFor(storeOf(), '/fr/api/blog/first')).resolves.toBe('unrouted');
  });

  it("leaves a page's route to match behind the locale", async () => {
    const store = storeOf();

    expect(store.dynamicRoutes[1]).toBe(store.manifest.routing.dynamicRoutes[1]);
    await expect(resolvedFor(store, '/first')).resolves.toMatchObject({ route: '/en/[slug]' });
    await expect(resolvedFor(store, '/fr/first')).resolves.toMatchObject({ route: '/fr/[slug]' });
  });

  it('leaves the routes of an application without i18n as the build wrote them', () => {
    const store = storeOf('', null);

    expect(store.dynamicRoutes).toStrictEqual(store.manifest.routing.dynamicRoutes);
  });

  /**
   * 16.4 collapses a dynamic route and its `.rsc` and segment forms into one entry wherever the
   * application has an App Router page, an API route's among them, and names the suffix's group by
   * its place: `$3`, behind the locale's group and the parameter's. Matched without the locale, the
   * group is the second; left as `$3`, the reference named no group and the router kept it, so the
   * page it named was `/api/blog/[slug]$3`, which the build has none of, and nothing matched.
   */
  it("is matched without a locale where 16.4 collapsed it with its data's forms", async () => {
    const store = storeOf();
    const collapsed: Route = {
      source: '/api/blog/[slug]',
      sourceRegex: String.raw`^[/]?(?<nextLocale>[^/]{1,})/api/blog/(?<nxtPslug>[^/]+?)(\.rsc|\.segments/.+\.segment\.rsc|)(?:/)?$`,
      destination: '/$nextLocale/api/blog/[slug]$3?nxtPslug=$nxtPslug',
    };
    const manifest = {
      ...store.manifest,
      routing: { ...store.manifest.routing, dynamicRoutes: [collapsed] },
    };
    const routed = { ...store, manifest, dynamicRoutes: routerDynamicRoutes(manifest) } as Store;

    expect(routed.dynamicRoutes[0]?.destination).toBe('/api/blog/[slug]$2?nxtPslug=$nxtPslug');
    await expect(resolvedFor(routed, '/api/blog/first')).resolves.toStrictEqual({
      route: '/api/blog/[slug]',
      query: { nxtPslug: 'first' },
    });
  });
});

/**
 * A nested dynamic route whose parameters' names begin one another. `@next/routing` fills a
 * destination in one name at a time, and `$nxtPid` is the start of `$nxtPid2`: `/a/b` was handed to
 * `[id]/[id2]` with an `id2` of `a2` (`use-params`).
 */
describe('a dynamic route whose parameters begin one another', () => {
  const NESTED: Route = {
    source: '/[id]/[id2]',
    sourceRegex: '^[/]?/(?<nxtPid>[^/]+?)/(?<nxtPid2>[^/]+?)(?:/)?$',
    destination: '/[id]/[id2]?nxtPid=$nxtPid&nxtPid2=$nxtPid2',
  };

  it('is handed each parameter as it was asked for', async () => {
    const base = storeOf('', null);
    const manifest = {
      ...base.manifest,
      routing: { ...base.manifest.routing, dynamicRoutes: [NESTED] },
      entrypoints: [{ id: '/[id]/[id2]', kind: 'app-page' as const, pathname: '/[id]/[id2]' }],
    };
    const store = {
      ...base,
      manifest,
      ...routerPathnames(manifest),
      dynamicRoutes: routerDynamicRoutes(manifest),
    } as unknown as Store;

    await expect(resolvedFor(store, '/a/b')).resolves.toStrictEqual({
      route: '/[id]/[id2]',
      query: { nxtPid: 'a', nxtPid2: 'b' },
    });
  });
});
