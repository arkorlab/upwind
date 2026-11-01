import { resolveRoutes } from '@next/routing';
import type { Route } from '@stayingupwind/core/bundle';
import { describe, expect, it } from 'vitest';

import { routingI18n, routingTables } from '../../src/routing.ts';
import { routerDynamicRoutes, routerPathnames, type Store } from '../../src/store.ts';

/**
 * A page asked for with a trailing slash, where no redirect takes the slash off.
 *
 * `next build` writes a redirect from a path ending in a slash to the page without it, unless
 * `skipTrailingSlashRedirect` says not to. Without it, Next.js's router still finds the page: it
 * looks a path up without its trailing slash (`getItem`, `server/lib/router-utils/filesystem.ts`).
 * `@next/routing` matches only the names it is handed, so `/another/` answered 404 where
 * `next start` answers the page (`skip-trailing-slash-redirect`).
 */

const BUILD_ID = 'b';

/** The redirect `next build` writes for a path ending in a slash, where nothing skips it. */
const SLASH_REDIRECT: Route = {
  source: '/:path+/',
  sourceRegex: String.raw`^(?:\/((?:[^\/]+?)(?:\/(?:[^\/]+?))*))\/$`,
  headers: { Location: '/$1' },
  status: 308,
  priority: true,
};

interface Application {
  readonly skipTrailingSlashRedirect: boolean;
  readonly i18n?: { readonly defaultLocale: string; readonly locales: string[] };
}

/** A Pages Router application with one page, `/another`, under each locale where it has any. */
function storeOf({ skipTrailingSlashRedirect, i18n }: Application): Store {
  const pages =
    i18n === undefined ? ['/another'] : i18n.locales.map((locale) => `/${locale}/another`);
  const manifest = {
    buildId: BUILD_ID,
    config: {
      basePath: '',
      trailingSlash: false,
      skipTrailingSlashRedirect,
      poweredByHeader: true,
      i18n: i18n ?? null,
    },
    routing: {
      beforeMiddleware: skipTrailingSlashRedirect ? [] : [SLASH_REDIRECT],
      middlewareMatchers: [],
      beforeFiles: [],
      afterFiles: [],
      dynamicRoutes: [],
      onMatch: [],
      fallback: [],
      shouldNormalizeNextData: true,
    },
    entrypoints: pages.map((pathname) => ({ id: pathname, kind: 'pages' as const, pathname })),
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

/** Where the router resolves `path` to, the page that spelling names, or the redirect it answers. */
async function routed(application: Application, path: string) {
  const store = storeOf(application);
  const url = new URL(`https://app.example${path}`);
  const result = await resolveRoutes({
    url,
    buildId: BUILD_ID,
    basePath: '',
    requestBody: new ReadableStream(),
    headers: new Headers(),
    pathnames: store.pathnames,
    ...(application.i18n !== undefined && { i18n: routingI18n(application.i18n) }),
    routes: routingTables(store, true, url, false),
    invokeMiddleware: () => Promise.resolve({}),
  });
  const resolved = result.resolvedPathname;
  return {
    page: resolved === undefined ? undefined : (store.slashSpellings.get(resolved) ?? resolved),
    status: result.status,
    location: result.resolvedHeaders?.get('location') ?? undefined,
  };
}

describe('a page asked for with a trailing slash no redirect takes off', () => {
  it('is the page, as Next.js finds it', async () => {
    const skipping = { skipTrailingSlashRedirect: true };

    await expect(routed(skipping, '/another/')).resolves.toStrictEqual({
      page: '/another',
      status: undefined,
      location: undefined,
    });
    await expect(routed(skipping, '/another')).resolves.toMatchObject({ page: '/another' });
  });

  it('is the default locale’s page, and a locale’s own, in an application with i18n', async () => {
    const skipping = {
      skipTrailingSlashRedirect: true,
      i18n: { defaultLocale: 'en', locales: ['en', 'ja-jp'] },
    };

    await expect(routed(skipping, '/another/')).resolves.toMatchObject({ page: '/en/another' });
    await expect(routed(skipping, '/ja-jp/another/')).resolves.toMatchObject({
      page: '/ja-jp/another',
    });
  });

  it('is left to the redirect where nothing skips it', async () => {
    await expect(routed({ skipTrailingSlashRedirect: false }, '/another/')).resolves.toStrictEqual({
      page: undefined,
      status: 308,
      location: '/another',
    });
  });
});
