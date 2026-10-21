import { staticFallbackParametersFor } from '../bundle/fallback-pages.ts';
import { pagesDataPathnameUnder, pagesDataPathnameAtPrefix } from '../bundle/pages-data.ts';
import { staticPageHeadersAllowSharing } from '../cache/static-pages.ts';
import { dynamicRouteFor, isExactPathname } from './dynamic.ts';
import type { BuildProjectManifestInput } from './manifest.ts';
import { pageKeyOf } from './page-keys.ts';
import type { PagesFallbackEntry, ProjectManifest, RouteEntry, StaticPageEntry } from './schema.ts';
const PAGES_FALLBACK_PRIVACY = 3;

function memberAgrees(input: BuildProjectManifestInput, entry: StaticPageEntry): boolean {
  if (entry.staticPagePrivacy !== PAGES_FALLBACK_PRIVACY) return true;
  const params = staticFallbackParametersFor(entry.route, entry.pathname);
  const under = input.pagesDataUnder;
  return (
    params !== undefined &&
    under?.basePath === '' &&
    input.trailingSlash !== true &&
    entry.dataPathname === pagesDataPathnameUnder(under.buildId, '', entry.pathname) &&
    entry.parameters !== undefined &&
    Object.keys(params).length === Object.keys(entry.parameters).length &&
    Object.entries(params).every(([name, value]) => entry.parameters?.[name] === value)
  );
}

function exactPages(
  input: BuildProjectManifestInput,
  routes: Readonly<Record<string, RouteEntry>>,
): Record<string, StaticPageEntry> {
  const pages: Record<string, StaticPageEntry> = {};
  if (input.staticPages === undefined) return pages;
  const bodies = new Set(input.routeBodies?.map((entry) => entry.pathname));
  for (const entry of input.staticPages) {
    if (Object.hasOwn(pages, entry.pathname) || bodies.has(entry.pathname))
      throw new Error(`static page ${entry.pathname} is already named`);
    const route = routes[entry.pathname];
    if (
      route?.cache?.kind !== 'pages' ||
      route.cache.delivery !== 'complete' ||
      route.cache.entryId !== entry.entryId ||
      route.function !== entry.function ||
      (route.cache.route !== undefined && route.cache.route !== entry.route)
    )
      throw new Error(`static page ${entry.pathname} disagrees with its document authority`);
    if (!memberAgrees(input, entry))
      throw new Error(`static page ${entry.pathname} has no paired member authority`);
    pages[entry.pathname] = entry;
  }
  return pages;
}

function shellAgrees(entry: PagesFallbackEntry, route: RouteEntry | undefined): boolean {
  // Loading bytes have no generation entry; only complete concrete members have a cache key.
  if (route === undefined || route.cache !== undefined) return false;
  const { artifact } = entry.shell;
  return (
    route.pathname === entry.route &&
    route.function === entry.function &&
    route.shell.sha256 === artifact.sha256 &&
    route.shell.byteLength === artifact.byteLength &&
    route.shell.contentType === artifact.contentType &&
    artifact.contentType.split(';', 1)[0]?.trim().toLowerCase() === 'text/html' &&
    staticPageHeadersAllowSharing(Object.entries(entry.headers)) &&
    staticPageHeadersAllowSharing(Object.entries(route.headers))
  );
}

function fallbackPages(
  input: BuildProjectManifestInput,
  routes: Readonly<Record<string, RouteEntry>>,
): Record<string, PagesFallbackEntry> {
  const fallbacks: Record<string, PagesFallbackEntry> = {};
  if (input.pagesFallbacks === undefined) return fallbacks;
  const under = input.pagesDataUnder;
  for (const entry of input.pagesFallbacks) {
    const supported = staticFallbackParametersFor(
      entry.route,
      entry.route.replaceAll(/\[[A-Za-z_]\w*\]/gu, 'member'),
    );
    if (
      supported === undefined ||
      input.trailingSlash === true ||
      under?.basePath !== '' ||
      Object.hasOwn(fallbacks, entry.route) ||
      entry.dataPathname !== pagesDataPathnameUnder(under.buildId, '', entry.route) ||
      !shellAgrees(entry, routes[entry.route])
    )
      throw new Error(`Pages fallback ${entry.route} disagrees with its loading shell`);
    fallbacks[entry.route] = entry;
  }
  return fallbacks;
}

/** Build once; exact members and class loading bytes retain independent authorities. */
export function staticPageFields(
  input: BuildProjectManifestInput,
  routes: Readonly<Record<string, RouteEntry>>,
): Pick<ProjectManifest, 'staticPages' | 'pagesFallbacks' | 'exactPathnames'> {
  if ((input.staticPages?.length ?? 0) === 0 && (input.pagesFallbacks?.length ?? 0) === 0)
    return {};
  if (input.cache === undefined) throw new Error('static pages need the manifest cache authority');
  const pages = exactPages(input, routes);
  const fallbacks = fallbackPages(input, routes);
  const keys = [
    ...(input.exactPathnames ?? []),
    ...Object.keys(routes),
    ...(input.routeBodies?.map((entry) => entry.pathname) ?? []),
    ...Object.keys(pages),
  ];
  return {
    ...(Object.keys(pages).length > 0 && { staticPages: pages }),
    ...(Object.keys(fallbacks).length > 0 && { pagesFallbacks: fallbacks }),
    exactPathnames: Object.fromEntries(keys.map((key) => [key, true as const])),
  };
}

/** A lookup cannot grant a different table entry authority through an alias key. */
export function findStaticPage(
  manifest: ProjectManifest,
  pathname: string,
): StaticPageEntry | undefined {
  if (manifest.staticPages === undefined || manifest.exactPathnames === undefined) return undefined;
  const key = pageKeyOf(manifest.exactPathnames, pathname, manifest);
  const entry = key === undefined ? undefined : manifest.staticPages[key];
  return entry?.pathname === key ? entry : undefined;
}

/** Resolve only the native first class; an exact winner always remains its own route. */
export function findPagesFallback(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
):
  | {
      readonly entry: PagesFallbackEntry;
      readonly parameters: Readonly<Record<string, string>>;
      readonly pathname: string;
      readonly dataPathname: string;
    }
  | undefined {
  if (
    manifest.pagesFallbacks === undefined ||
    manifest.pagesDataPrefix === undefined ||
    manifest.trailingSlash === true ||
    isExactPathname(manifest, url.pathname)
  )
    return undefined;
  const owner = dynamicRouteFor(manifest, url, headers);
  if (owner === undefined || owner.has !== undefined || owner.missing !== undefined)
    return undefined;
  const route = owner.route ?? owner.members?.route;
  const entry = route === undefined ? undefined : manifest.pagesFallbacks[route];
  if (entry === undefined || entry.route !== route) return undefined;
  const parameters = staticFallbackParametersFor(entry.route, url.pathname);
  const expected = pagesDataPathnameAtPrefix(manifest.pagesDataPrefix, entry.route);
  if (parameters === undefined || entry.dataPathname !== expected) return undefined;
  return {
    entry,
    parameters,
    pathname: url.pathname,
    dataPathname: pagesDataPathnameAtPrefix(manifest.pagesDataPrefix, url.pathname),
  };
}
