import { withTrailingSlash } from '../manifest/dynamic.ts';
import { basePathOfPagesDataPrefix, PAGES_DATA_SEGMENT } from '../manifest/pages-data-prefix.ts';

/**
 * The Pages Router's data route: beside each page a client navigation fetches
 * `/_next/data/<buildId>/<page>.json`, the props the page was rendered with. The build writes one
 * per prerendered page, and the runtime cache keeps one per generation, so both directions of
 * the naming are needed.
 */

const DATA_PREFIX = PAGES_DATA_SEGMENT;
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

/** A segment that is a parameter whole, `/[slug]`: what makes Next.js read a page as dynamic. */
const PARAMETER_SEGMENT = /\/\[[^/]+\](?=\/|$)/u;

/**
 * A page as `normalizePagePath` spells it in the name of a file it writes: the root is `/index`,
 * and a page that begins with `/index` is nested under a second one — unless a segment of it reads
 * as a parameter (`isDynamicRoute`), as a concrete member's value may: that one is left as it is.
 */
function spelledPage(page: string): string {
  if (page === '/') {
    return INDEX;
  }
  const nested = page === INDEX || page.startsWith(`${INDEX}/`);
  return nested && !PARAMETER_SEGMENT.test(page) ? `${INDEX}${page}` : page;
}

/**
 * The page a file's name spells (`spelledPage`) read back: one `/index` taken off a name that
 * begins with it, or the name as it is, whichever the build spells so; `undefined` for a name the
 * build spells no page by.
 */
function pageOfSpelling(spelled: string): string | undefined {
  if (spelled === INDEX) {
    return '/';
  }
  const candidates = spelled.startsWith(`${INDEX}/`)
    ? [spelled.slice(INDEX.length), spelled]
    : [spelled];
  return candidates.find((page) => spelledPage(page) === spelled);
}

/** A path with its escapes decoded; `undefined` for one that does not decode. */
function decodedPath(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
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

/** `<basePath>/_next/data/<buildId>`, as the build names what it writes there. */
function dataPrefixOf(buildId: string, basePath: string): string {
  return `${basePath}${DATA_PREFIX}${buildId}`;
}

/** Only for its parser: a path is spelled the same under any origin. */
const ANY_ORIGIN = 'https://pages-data.invalid';

/**
 * Where a host is asked for a Pages Router page's props, for a manifest (`pagesDataPrefix`):
 * `<basePath>/_next/data/<buildId>`, with no slash after, spelled as a request's URL spells it.
 * That is the build's name for it percent-encoded wherever the base path or the build id holds what
 * a URL's path cannot — a space, anything not ASCII — and what a request's pathname is compared
 * with (`pageOfPagesData`).
 */
export function pagesDataPrefixOf(buildId: string, basePath: string): string {
  return new URL(dataPrefixOf(buildId, basePath), ANY_ORIGIN).pathname;
}

/**
 * The data pathname the build writes a page's props under, as the build names it: under the base
 * path, `/_next/data/<buildId>`, the page as it spells it in a file's name (`spelledPage`), `.json`.
 */
export function pagesDataPathnameUnder(
  buildId: string,
  basePath: string,
  pathname: string,
): string {
  const page = spelledPage(underBasePath(basePath, pathname));
  return `${dataPrefixOf(buildId, basePath)}${page}${DATA_SUFFIX}`;
}

/**
 * The page a data request asks the props of, by a manifest's `pagesDataPrefix`: the page whose
 * props `pagesDataPathnameUnder` names so, named as a manifest names its routes — under the base
 * path, and behind the slash where the application keeps its pages there (`trailingSlash`), which is
 * the spelling a request for the page's document asks by. The client asks for a page's props
 * without that slash (`getDataHref`), and with nothing but the page between the prefix and `.json`.
 *
 * Read decoded, and only from the one spelling a URL gives the name: an escape a URL would not write
 * (`%66oo`, `%69ndex`), an escaped slash, or anything that decodes into another name the build
 * wrote would otherwise be answered with that name's props, where Next.js finds no props by it.
 *
 * `undefined` for a pathname no page's props are named by — another build's, another spelling, a
 * slash before `.json` — which is the application's to answer.
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
  const page = pageAsSpelled(spelled);
  const under = basePathOfPagesDataPrefix(prefix);
  const basePath = under === undefined ? undefined : decodedPath(under);
  if (page === undefined || basePath === undefined) {
    return undefined;
  }
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

/**
 * The page a request's spelling of a file's name stands for (`pageOfSpelling`), decoded; `undefined`
 * unless the spelling is the one a URL gives that name. Next.js finds a page's props by the page's
 * own name, which ends in no slash, so one before `.json` names nothing it wrote.
 */
function pageAsSpelled(spelled: string): string | undefined {
  const decoded = spelled.endsWith('/') ? undefined : decodedPath(spelled);
  if (decoded === undefined || new URL(decoded, ANY_ORIGIN).pathname !== spelled) {
    return undefined;
  }
  return pageOfSpelling(decoded);
}
