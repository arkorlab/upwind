import { detectDomainLocale, normalizeLocalePath, type resolveRoutes } from '@next/routing';

import type { Store } from './store.ts';

type RoutingI18n = NonNullable<Parameters<typeof resolveRoutes>[0]['i18n']>;

/** What a Pages Router data request's path ends with. */
const DATA_SUFFIX = '.json';
/** The name the build gives the root, and puts in front of a page that begins with it. */
const INDEX = '/index';
/** A segment Next.js reads as dynamic (`isDynamicRoute`, strict, `shared/lib/router/utils`). */
const DYNAMIC_SEGMENT = /\/\[[^/]+\](?=\/|$)/u;

/** What of the manifest says whether and how a data request is localized. */
type DataManifest = Pick<Store['manifest'], 'buildId'> & {
  readonly config: Pick<Store['manifest']['config'], 'basePath'>;
  readonly routing: Pick<Store['manifest']['routing'], 'middlewareMatchers'>;
};

/**
 * A Pages Router data request that names no locale, given the default one, as Next.js's router
 * gives it in an application with a middleware ("Match normalized _next/data requests against the
 * same locale-prefixed internal pathname shape used by direct page requests", in its
 * `middleware_next_data` route, `server/lib/router-utils/resolve-routes.js`): `/about.json`'s data
 * is `/en/about`'s. `@next/routing` puts the default locale in front of a page's path, but never of
 * a data request's (16.4.3, and 16.5.0-canary.36 the same), while the data route Next.js writes for
 * an application with `i18n` reads the first segment as the locale: `about` was read as one, and
 * no page was found. Next.js does it only where the application has a middleware; without one,
 * such a request is a 404 there too, and is left as it came. The default is the domain's where one
 * is configured, as it is for a page (`internalPathname`). Any other request is returned as it came.
 */
export function localizedDataUrl(manifest: DataManifest, i18n: RoutingI18n, url: URL): URL {
  if (manifest.routing.middlewareMatchers.length === 0) {
    return url;
  }
  // Spelled as the router reads a data request (`normalizeNextDataUrl`): the base path as it is
  // configured, against the path as it came. A request it does not read as data is not localized.
  const prefix = `${manifest.config.basePath}/_next/data/${manifest.buildId}/`;
  const { pathname } = url;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(DATA_SUFFIX)) {
    return url;
  }
  const page = dataPagePathOf(pathname.slice(prefix.length, -DATA_SUFFIX.length));
  const named = normalizeLocalePath(page, i18n.locales).detectedLocale;
  if (named !== undefined || page.startsWith('/_next/')) {
    return url;
  }
  const defaultLocale =
    detectDomainLocale(i18n.domains, url.hostname)?.defaultLocale ?? i18n.defaultLocale;
  const localized = new URL(url);
  const rest = page === '/' ? defaultLocale : `${defaultLocale}${page}`;
  localized.pathname = `${prefix}${rest}${DATA_SUFFIX}`;
  return localized;
}

/**
 * The page a data request names, read as Next.js reads it (`NextDataPathnameNormalizer`, which
 * ends in `denormalizePagePath`): `index` is the root, and a page under `index/` is the page
 * without it, as the build names a page that itself begins with `/index` under a second one. A name
 * with a dynamic segment keeps its `index/` (`isDynamicRoute`), as it does there.
 */
export function dataPagePathOf(named: string): string {
  const page = `/${named}`;
  if (page === INDEX) {
    return '/';
  }
  return page.startsWith(`${INDEX}/`) && !DYNAMIC_SEGMENT.test(page)
    ? page.slice(INDEX.length)
    : page;
}
