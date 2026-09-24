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
