import { withTrailingSlash } from '../manifest/dynamic.ts';

/**
 * The Pages Router's data route: beside each page a client navigation fetches
 * `/_next/data/<buildId>/<page>.json`, the props the page was rendered with. The build writes one
 * per prerendered page, and the runtime cache keeps one per generation, so both directions of
 * the naming are needed.
 */

const DATA_PREFIX = '/_next/data/';
const DATA_SUFFIX = '.json';
const INDEX = '/index';

/** The data pathname of a page: the root is `/index.json`, as Next.js names it. */
export function pagesDataPathname(buildId: string, pathname: string): string {
  const page = pathname === '/' ? INDEX : pathname;
  return `${DATA_PREFIX}${buildId}${page}${DATA_SUFFIX}`;
}

/** The page a data pathname belongs to; `undefined` when it is not one of this build's. */
export function pagesPathnameOfData(buildId: string, dataPathname: string): string | undefined {
  const prefix = `${DATA_PREFIX}${buildId}/`;
  if (!dataPathname.startsWith(prefix) || !dataPathname.endsWith(DATA_SUFFIX)) {
    return undefined;
  }
  const page = `/${dataPathname.slice(prefix.length, -DATA_SUFFIX.length)}`;
  return page === INDEX ? '/' : page;
}

/**
 * Whether a request is a data request, decided the way Next.js's router decides it before a
 * middleware runs (`server/lib/router-utils/resolve-routes.ts`): the path beneath the base path is
 * under `/_next/data/` and ends in `.json`. Any build's: which one the client names is for routing
 * to settle, not for this.
 */
export function isPagesDataRequestPath(basePath: string, pathname: string): boolean {
  const underBase =
    basePath !== '' && (pathname === basePath || pathname.startsWith(`${basePath}/`))
      ? pathname.slice(basePath.length)
      : pathname;
  return underBase.startsWith(DATA_PREFIX) && underBase.endsWith(DATA_SUFFIX);
}

/** Whether a pathname is a Pages Router data route of any build. */
export function isPagesDataPathname(pathname: string): boolean {
  return pathname.startsWith(DATA_PREFIX);
}

/**
 * A page as `normalizePagePath` spells it in the name of a file it writes: the root is `/index`,
 * and a page that begins with `/index` is nested under a second one.
 */
function spelledPage(page: string): string {
  if (page === '/') {
    return INDEX;
  }
  return page === INDEX || page.startsWith(`${INDEX}/`) ? `${INDEX}${page}` : page;
}

/** The page under a base path a pathname of the build names: the root of the base path is `/`. */
function underBasePath(basePath: string, pathname: string): string {
  if (basePath === '') {
    return pathname;
  }
  if (pathname === basePath) {
    return '/';
  }
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

/**
 * Where a host is asked for a Pages Router page's props, for a manifest (`pagesDataPrefix`):
 * `<basePath>/_next/data/<buildId>`, with no slash after.
 */
export function pagesDataPrefixOf(buildId: string, basePath: string): string {
  return `${basePath}${DATA_PREFIX}${buildId}`;
}

/**
 * The data pathname the build writes a page's props under: under the base path,
 * `/_next/data/<buildId>`, the page as it spells it in a file's name (`spelledPage`), `.json`.
 */
export function pagesDataPathnameUnder(
  buildId: string,
  basePath: string,
  pathname: string,
): string {
  const page = spelledPage(underBasePath(basePath, pathname));
  return `${pagesDataPrefixOf(buildId, basePath)}${page}${DATA_SUFFIX}`;
}

/**
 * The page a data request asks the props of, by a manifest's `pagesDataPrefix`: the page whose
 * props `pagesDataPathnameUnder` names so, named as a manifest names its routes — under the base
 * path, and behind the slash where the application keeps its pages there (`trailingSlash`), which is
 * the spelling a request for the page's document asks by. The client asks for a page's props
 * without that slash (`getDataHref`).
 *
 * `undefined` for a pathname no page's props are named by — another build's, another spelling —
 * which is the application's to answer.
 */
export function pageOfPagesData(
  prefix: string,
  pathname: string,
  trailingSlash: boolean,
): string | undefined {
  if (!pathname.startsWith(`${prefix}/`) || !pathname.endsWith(DATA_SUFFIX)) {
    return undefined;
  }
  const spelled = pathname.slice(prefix.length, -DATA_SUFFIX.length);
  let page = spelled;
  if (spelled === INDEX) {
    page = '/';
  } else if (spelled.startsWith(`${INDEX}/`)) {
    page = spelled.slice(INDEX.length);
  }
  if (spelledPage(page) !== spelled) {
    return undefined;
  }
  const basePath = prefix.slice(0, prefix.lastIndexOf(DATA_PREFIX));
  if (page !== '/') {
    const named = `${basePath}${page}`;
    return trailingSlash ? withTrailingSlash(named) : named;
  }
  if (basePath === '') {
    return page;
  }
  // The root of a base path gains the slash by name, whatever its last segment reads like
  // (`requestedPathname`).
  return trailingSlash ? `${basePath}/` : basePath;
}
