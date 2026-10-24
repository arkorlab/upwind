import { resolveRoutes } from '@next/routing';
import type { Route } from '@stayingupwind/core/bundle';
import { CACHE_OUTCOME_HEADER } from '@stayingupwind/core/paas';
import { describe, expect, it } from 'vitest';

import { withRoutingOf } from '../../src/resolve-request.ts';
import {
  internalPathname,
  internalRedirect,
  landedRoute,
  routingI18n,
  routingTables,
} from '../../src/routing.ts';
import type { RoutedInput } from '../../src/serve.ts';
import { routerDynamicRoutes, routerPathnames, type Store } from '../../src/store.ts';

/**
 * Next.js's own trailing-slash redirects, in an application with `i18n`.
 *
 * `@next/routing` puts the default locale in front of a path that names none before it matches a
 * single rule, and keeps the root's own slash behind it: `/` is `/en-US/`. The redirect `next
 * build` writes for a path ending in a slash sent that to `/en-US` — every visit to the home page
 * was a redirect first — and sent `/about/` to `/en-US/about`. Next.js's router matches the rules
 * it writes itself with the default locale taken out again (`handleRoute`, for a rule marked
 * `internal`): the root is the root, and `/about/` goes to `/about`.
 *
 * Every answer expected below is what `next start` (16.3.6) answered for the same application.
 */

const LOCALES = ['en-US', 'fr', 'nl'];
const I18N = { defaultLocale: 'en-US', locales: LOCALES };

/** The rules `next build` writes itself, as the routing it hands an adapter carries them. */
const WITHOUT_SLASH: Route = {
  source: '/:path+/',
  sourceRegex: String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))\/$`,
  headers: { Location: '/$1' },
  status: 308,
  priority: true,
};
const FILE_WITHOUT_SLASH: Route = {
  source: String.raw`/:file((?!\.well-known(?:/.*)?)(?:[^/]+/)*[^/]+\.\w+)/`,
  sourceRegex: String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/]+\.\w+))\/$`,
  headers: { Location: '/$1' },
  missing: [{ type: 'header', key: 'x-nextjs-data' }],
  status: 308,
  priority: true,
};
const WITH_SLASH: Route = {
  source: String.raw`/:notfile((?!\.well-known(?:/.*)?)(?:[^/]+/)*[^/\.]+)`,
  sourceRegex: String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/\.]+))$`,
  headers: { Location: '/$1/' },
  status: 308,
  priority: true,
};

/** The same, for an application under the base path `/docs`. */
const DOCS_WITHOUT_SLASH: Route = {
  source: '/docs/',
  sourceRegex: String.raw`^\/docs\/$`,
  headers: { Location: '/docs' },
  status: 308,
  priority: true,
};
const DOCS_WITH_SLASH: Route = {
  source: '/docs',
  sourceRegex: String.raw`^\/docs$`,
  headers: { Location: '/docs/' },
  status: 308,
  priority: true,
};

function internalRules(basePath: string, trailingSlash: boolean): Route[] {
  if (trailingSlash) {
    return [...(basePath === '' ? [] : [DOCS_WITH_SLASH]), FILE_WITHOUT_SLASH, WITH_SLASH];
  }
  return [...(basePath === '' ? [] : [DOCS_WITHOUT_SLASH]), WITHOUT_SLASH];
}

interface Options {
  readonly basePath?: '' | '/docs';
  readonly trailingSlash?: boolean;
  readonly i18n?: typeof I18N & { domains?: { domain: string; defaultLocale: string }[] };
}

/** An application with a home page and an about page in each locale, as `next build` names them. */
function storeOf({ basePath = '', trailingSlash = false, i18n = I18N }: Options = {}): Store {
  const manifest = {
    buildId: 'b',
    config: {
      basePath,
      trailingSlash,
      skipTrailingSlashRedirect: false,
      poweredByHeader: true,
      i18n,
    },
    routing: {
      beforeMiddleware: internalRules(basePath, trailingSlash),
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: true,
    },
    entrypoints: LOCALES.flatMap((locale) => {
      return [
        { id: `${basePath}/${locale}`, kind: 'pages' as const, pathname: `${basePath}/${locale}` },
        {
          id: `${basePath}/${locale}/about`,
          kind: 'pages' as const,
          pathname: `${basePath}/${locale}/about`,
        },
      ];
    }),
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

/** What a request is answered with: a redirect, or the page the router resolved it to. */
async function answered(store: Store, path: string) {
  const url = new URL(`https://app.example${path}`);
  const headers = new Headers();
  const redirect = await internalRedirect(store, url, headers);
  if (redirect !== undefined) {
    return { status: redirect.status, location: redirect.headers.get('location') };
  }
  const { basePath, i18n } = store.manifest.config;
  const routed = await resolveRoutes({
    url,
    buildId: 'b',
    basePath,
    requestBody: new ReadableStream(),
    headers,
    pathnames: store.pathnames,
    ...(i18n !== null && i18n !== undefined && { i18n: routingI18n(i18n) }),
    routes: routingTables(store, true, url, false),
    invokeMiddleware: () => Promise.resolve({}),
  });
  if (routed.resolvedPathname === undefined || routed.invocationTarget === undefined) {
    return { status: routed.status, location: routed.resolvedHeaders?.get('location') };
  }
  const { route } = landedRoute(store, routed.resolvedPathname, routed.invocationTarget);
  return { page: store.slashSpellings.get(route) ?? route };
}

describe('the path Next.js matches its own redirects against, with i18n', () => {
  it.each([
    // The default locale put in front of the root, and taken out again.
    { path: '/', expected: '/' },
    { path: '/about', expected: '/about' },
    { path: '/about/', expected: '/about/' },
    // Named, the default locale comes out as well.
    { path: '/en-US/about/', expected: '/about/' },
    { path: '/en-US/', expected: '/' },
    // Any other locale stays.
    { path: '/fr/', expected: '/fr/' },
    { path: '/fr/about/', expected: '/fr/about/' },
    // A `_next` path is given no locale.
    { path: '/_next/data/b/about.json', expected: '/_next/data/b/about.json' },
  ])('is $expected for $path', ({ path, expected }) => {
    const { config } = storeOf().manifest;

    expect(internalPathname(config, I18N, new URL(`https://app.example${path}`))).toBe(expected);
  });

  it.each([
    { path: '/docs', expected: '/docs' },
    // No slash goes back on after the base path without `trailingSlash`.
    { path: '/docs/', expected: '/docs' },
    { path: '/docs/about/', expected: '/docs/about/' },
    { path: '/docs/fr/', expected: '/docs/fr/' },
    { path: '/docs/en-US/about/', expected: '/docs/about/' },
  ])('is $expected for $path under a base path', ({ path, expected }) => {
    const { config } = storeOf({ basePath: '/docs' }).manifest;

    expect(internalPathname(config, I18N, new URL(`https://app.example${path}`))).toBe(expected);
  });

  it.each([
    { path: '/', expected: '/' },
    { path: '/about', expected: '/about' },
    { path: '/about/', expected: '/about/' },
    { path: '/fr', expected: '/fr' },
  ])('is $expected for $path where the application keeps the slash', ({ path, expected }) => {
    const { config } = storeOf({ trailingSlash: true }).manifest;

    expect(internalPathname(config, I18N, new URL(`https://app.example${path}`))).toBe(expected);
  });

  it("takes out the domain's own default locale", () => {
    const i18n = { ...I18N, domains: [{ domain: 'example.fr', defaultLocale: 'fr' }] };
    const { config } = storeOf({ i18n }).manifest;

    expect(internalPathname(config, i18n, new URL('https://example.fr/fr/about/'))).toBe('/about/');
    expect(internalPathname(config, i18n, new URL('https://app.example/fr/about/'))).toBe(
      '/fr/about/',
    );
  });
});

describe('a request to an application with i18n, answered', () => {
  it.each([
    { path: '/', expected: { page: '/en-US' } },
    { path: '/en-US/', expected: { page: '/en-US' } },
    { path: '/fr', expected: { page: '/fr' } },
    { path: '/about', expected: { page: '/en-US/about' } },
    { path: '/about/', expected: { status: 308, location: '/about' } },
    { path: '/about/?q=1', expected: { status: 308, location: '/about?q=1' } },
    { path: '/en-US/about/', expected: { status: 308, location: '/about' } },
    { path: '/fr/', expected: { status: 308, location: '/fr' } },
    { path: '/fr/about/', expected: { status: 308, location: '/fr/about' } },
  ])('answers $path as Next.js does', async ({ path, expected }) => {
    await expect(answered(storeOf(), path)).resolves.toStrictEqual(expected);
  });

  it.each([
    { path: '/docs', expected: { page: '/docs/en-US' } },
    { path: '/docs/', expected: { page: '/docs/en-US' } },
    { path: '/docs/en-US/', expected: { page: '/docs/en-US' } },
    { path: '/docs/about/', expected: { status: 308, location: '/docs/about' } },
    { path: '/docs/en-US/about/', expected: { status: 308, location: '/docs/about' } },
    { path: '/docs/fr/', expected: { status: 308, location: '/docs/fr' } },
  ])('answers $path under a base path as Next.js does', async ({ path, expected }) => {
    await expect(answered(storeOf({ basePath: '/docs' }), path)).resolves.toStrictEqual(expected);
  });

  it.each([
    { path: '/', expected: { page: '/en-US' } },
    { path: '/about', expected: { status: 308, location: '/about/' } },
    { path: '/about/', expected: { page: '/en-US/about' } },
    { path: '/en-US/about', expected: { status: 308, location: '/about/' } },
    { path: '/fr', expected: { status: 308, location: '/fr/' } },
    { path: '/fr/', expected: { page: '/fr' } },
    { path: '/robots.txt/', expected: { status: 308, location: '/robots.txt' } },
  ])('answers $path where the application keeps the slash', async ({ path, expected }) => {
    await expect(answered(storeOf({ trailingSlash: true }), path)).resolves.toStrictEqual(expected);
  });

  it('leaves the rules to the router in an application without i18n', async () => {
    const store = storeOf();
    const plain = {
      ...store,
      manifest: { ...store.manifest, config: { ...store.manifest.config, i18n: null } },
    } as unknown as Store;
    const about = new URL('https://app.example/about/');

    await expect(internalRedirect(plain, about, new Headers())).resolves.toBeUndefined();
    expect(routingTables(plain, true, about, false).beforeMiddleware).toHaveLength(1);
    expect(routingTables(store, true, about, false).beforeMiddleware).toHaveLength(0);
  });

  /** A header rule `next build` writes itself is no redirect, and stays with the router. */
  it("keeps next build's own header rules for the router", () => {
    const store = storeOf();
    const serviceWorker: Route = {
      sourceRegex: String.raw`^\/_next\/static\/service-worker(?:\/(.*))?$`,
      headers: { 'Service-Worker-Allowed': '/' },
      priority: true,
    };
    const withHeader = {
      ...store,
      manifest: {
        ...store.manifest,
        routing: {
          ...store.manifest.routing,
          beforeMiddleware: [serviceWorker, ...store.manifest.routing.beforeMiddleware],
        },
      },
    } as unknown as Store;

    expect(
      routingTables(withHeader, true, new URL('https://app.example/'), false).beforeMiddleware,
    ).toStrictEqual([{ sourceRegex: serviceWorker.sourceRegex, headers: serviceWorker.headers }]);
  });
});

describe('a page regenerated in the foreground, in an application with i18n', () => {
  it("is answered with Next.js's own trailing-slash redirect, as the usual path answers it", async () => {
    const request = new Request('https://app.example/about/');
    const input = { request, initURL: request.url } as unknown as RoutedInput;
    // The regeneration's render, and what it came to.
    const render = new Response('<!doctype html><html><body>About</body></html>', {
      headers: { 'content-type': 'text/html', [CACHE_OUTCOME_HEADER]: 'accepted' },
    });
    const answer = await withRoutingOf(input, storeOf(), render);

    expect(answer.status).toBe(308);
    expect(answer.headers.get('location')).toBe('/about');
    expect(answer.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
  });

  it('says what the regeneration came to over a rule of next.config naming the same header', async () => {
    const store = storeOf();
    // A rule that sets every header of the runtime's own it can name, on every path.
    const forged: Route = {
      sourceRegex: '^(?:/(.*))$',
      headers: { [CACHE_OUTCOME_HEADER]: 'forged' },
    };
    store.manifest.routing.beforeMiddleware.push(forged);
    const request = new Request('https://app.example/about');
    const input = { request, initURL: request.url } as unknown as RoutedInput;
    const render = new Response('<!doctype html><html><body>About</body></html>', {
      headers: { 'content-type': 'text/html', [CACHE_OUTCOME_HEADER]: 'accepted' },
    });
    const answer = await withRoutingOf(input, store, render);
    await answer.arrayBuffer();

    expect(answer.status).toBe(200);
    expect(answer.headers.get(CACHE_OUTCOME_HEADER)).toBe('accepted');
  });
});
