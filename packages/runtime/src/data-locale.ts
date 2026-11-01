import { detectDomainLocale, normalizeLocalePath, type resolveRoutes } from '@next/routing';

import type { Store } from './store.ts';

type RoutingI18n = NonNullable<Parameters<typeof resolveRoutes>[0]['i18n']>;

/** What a Pages Router data request's path ends with. */
const DATA_SUFFIX = '.json';

/**
 * A Pages Router data request that names no locale, given the default one, as Next.js's router
 * gives it ("Match normalized _next/data requests against the same locale-prefixed internal
 * pathname shape used by direct page requests", `server/lib/router-utils/resolve-routes.js`).
 * `@next/routing` puts the default locale in front of a page's path, but not of a data request's
 * (16.4.3, and 16.5.0-canary.36 the same), while the data route Next.js writes for an application
 * with `i18n` reads the first segment as the locale: `/_next/data/<build>/about.json` read `about`
 * as one and found no page, where Next.js answers it as `/en/about`. The default is the domain's
 * where one is configured, as it is for a page (`internalPathname`). Any other request is
 * returned as it came.
 */
export function localizedDataUrl(
  config: Pick<Store['manifest']['config'], 'basePath'>,
  i18n: RoutingI18n,
  buildId: string,
  url: URL,
): URL {
  const prefix = `${config.basePath}/_next/data/${buildId}/`;
  const { pathname } = url;
  if (!pathname.startsWith(prefix) || !pathname.endsWith(DATA_SUFFIX)) {
    return url;
  }
  const page = pathname.slice(prefix.length, -DATA_SUFFIX.length);
  const named = normalizeLocalePath(`/${page}`, i18n.locales).detectedLocale;
  if (named !== undefined || page.startsWith('_next/')) {
    return url;
  }
  const defaultLocale =
    detectDomainLocale(i18n.domains, url.hostname)?.defaultLocale ?? i18n.defaultLocale;
  const localized = new URL(url);
  const rest = page === 'index' ? defaultLocale : `${defaultLocale}/${page}`;
  localized.pathname = `${prefix}${rest}${DATA_SUFFIX}`;
  return localized;
}
