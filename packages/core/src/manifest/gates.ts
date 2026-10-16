import { isPagesDataRequestPath, pageOfPagesData } from '../bundle/pages-data.ts';
import { dataRequestHeaders } from '../request/headers.ts';
import {
  isReserved,
  nextNamespacePattern,
  pathIsReserved,
  routedDynamicRouteFor,
} from './dynamic.ts';
import { findRouteEntry, findStaticFile } from './manifest.ts';
import { pageKeyOf } from './page-keys.ts';
import type { ProjectManifest, ReservedRoute } from './schema.ts';

/**
 * Which gate a request is asked of before the edge serves it anything, for a deployment that
 * declares any (`ProjectManifest.gates`): the gate of the route that serves the request.
 *
 * The route is found as the edge finds what it serves a request from — the same tables in the same
 * order (`entryFor`, `pagesDataRequest`) — and, past what the edge serves, as the deployment's
 * router routes the request on: a redirect or a rewrite of `next.config` ahead of the filesystem
 * first, which takes the request elsewhere; then a page's props the edge holds; then the page
 * Next.js resolves exactly, a shell's route ahead of a page with none, whichever route either is of
 * (`gatedPathnames`), or a file the build ships; then, unless a rule claims the request ahead of
 * them, the dynamic routes in their own order, matched without regard to case as the router matches
 * them, each that lands on a gated route naming it (`DynamicRoute.gated`). A Pages Router data URL
 * the router reads as the page it names (`gatedDataPrefix`) is routed as that page.
 *
 * `undefined` for a request a route with no gate serves, and for one nothing the manifest names
 * serves. Nothing the edge holds of a gated route answers either: the routes the edge serves from
 * storage are found by the same tables, in the same order. A rule that claims a request ahead of the
 * filesystem takes it to no gated route: a build whose rewrite may is refused (`rewritesOnto`).
 */

/** A request's gate, and the route it is asked of the request as. */
export interface RouteGate {
  /** The route as the build declared it, which the gate is told the request is of. */
  readonly route: string;
  /** The gate's name, which a host binds the gate under. */
  readonly name: string;
}

/** What the router resolves a pathname to by name, and the gated route that is, if any. */
interface Named {
  readonly gated: string | undefined;
}

const DATA_PREFIX = '/_next/data/';
const DATA_SUFFIX = '.json';
const INDEX = 'index';
/** The root's page as a data URL names it. */
const INDEX_PAGE = `/${INDEX}`;
const NO_RULES: readonly ReservedRoute[] = [];

/** The gated route a pathname Next.js resolves exactly is of, by its key; none for another's. */
function gatedOf(manifest: ProjectManifest, key: string): string | undefined {
  const gated = manifest.gatedPathnames;
  return gated !== undefined && Object.hasOwn(gated, key) ? gated[key] : undefined;
}

/** The base path the deployment's router reads a request's path under. */
function basePathOf(manifest: ProjectManifest): string {
  return manifest.spelledPrefix?.basePath ?? manifest.pagesDataBasePath ?? '';
}

/**
 * The key of the page Next.js resolves a pathname to exactly, found as the edge finds it: a route
 * with a shell first (`findRouteEntry`), and then a pathname with none (`isExactPathname`) — each
 * as a route is (`pageKeyOf`), so that a page of its own the path also spells wins as it does there.
 */
function exactKeyOf(manifest: ProjectManifest, pathname: string): string | undefined {
  const entry = findRouteEntry(manifest, pathname);
  if (entry !== undefined) {
    return entry.pathname;
  }
  const exact = manifest.exactPathnames;
  return exact === undefined ? undefined : pageKeyOf(exact, pathname, manifest);
}

/**
 * Whether a pathname names a file of the deployment's own build, as the edge finds one
 * (`findStaticFile`): the router finds it by name ahead of every dynamic route, whose gate is not
 * asked. A file kept from the deployment before is no name of this deployment's router, which
 * routes the path as any other.
 */
function namesOwnFile(manifest: ProjectManifest, pathname: string): boolean {
  const file = findStaticFile(manifest, pathname);
  return (
    file !== undefined &&
    (file.deploymentId === undefined || file.deploymentId === manifest.deployment.dplId)
  );
}

/** What the router resolves a pathname to by name: a page, of whichever route, or a file. */
function namedOf(manifest: ProjectManifest, pathname: string): Named | undefined {
  const key = exactKeyOf(manifest, pathname);
  if (key !== undefined) {
    return { gated: gatedOf(manifest, key) };
  }
  return namesOwnFile(manifest, pathname) ? { gated: undefined } : undefined;
}

/**
 * The page whose props the edge answers a request for from storage (`pagesDataRequest`): one at the
 * manifest's `pagesDataPrefix` whose page holds the props the build wrote (`RouteEntry.pagesData`).
 * Any other request at a data URL — of an App Router page among them — is no request for those.
 */
function propsPageOf(manifest: ProjectManifest, url: URL): string | undefined {
  const prefix = manifest.pagesDataPrefix;
  if (prefix === undefined) {
    return undefined;
  }
  const basePath = manifest.pagesDataBasePath ?? '';
  const trailingSlash = manifest.trailingSlash === true;
  const page = pageOfPagesData(prefix, basePath, url.pathname, trailingSlash);
  const entry =
    page !== undefined && Object.hasOwn(manifest.routes, page) ? manifest.routes[page] : undefined;
  return entry?.pagesData === undefined ? undefined : page;
}

/** Each manifest's rules as its router has them (`routerRules`), by its reserved routes. */
const routerRulesOf = new WeakMap<readonly ReservedRoute[], readonly ReservedRoute[]>();

/**
 * The rules of `next.config` a manifest reserves its dynamic routes from, as the router has them:
 * without the edge's own reservation of Next.js's namespace under a base path
 * (`nextNamespacePattern`), which keeps the edge from handing out a class's shell there. The router
 * routes `<basePath>/_next/…` to a catch-all as it does any other path.
 */
function routerRules(manifest: ProjectManifest): readonly ReservedRoute[] {
  const reserved = manifest.reservedRoutes ?? NO_RULES;
  let rules = routerRulesOf.get(reserved);
  if (rules === undefined) {
    const namespace = nextNamespacePattern(basePathOf(manifest));
    rules = reserved.filter((rule) => rule.sourceRegex !== namespace);
    routerRulesOf.set(reserved, rules);
  }
  return rules;
}

/** A data URL as the router reads it: the page it names, and the data name it looks the page up by. */
interface DataPage {
  readonly page: URL;
  readonly data: string;
}

/**
 * A request under `gatedDataPrefix` as the router reads it (`normalizeNextDataUrl` and
 * `denormalizeNextDataUrl`, in `@next/routing`): the page it names — `.json` taken off where it ends
 * so, though the router reads one that does not as well, and `index` the base path's root — and the
 * data name of that page, which the router looks a name up by.
 */
function dataPageOf(manifest: ProjectManifest, url: URL): DataPage | undefined {
  const prefix = manifest.gatedDataPrefix;
  if (prefix === undefined || !url.pathname.startsWith(`${prefix}/`)) {
    return undefined;
  }
  const basePath = prefix.slice(0, prefix.lastIndexOf(DATA_PREFIX));
  const named = url.pathname.slice(prefix.length + 1);
  const name = named.endsWith(DATA_SUFFIX) ? named.slice(0, -DATA_SUFFIX.length) : named;
  const page = new URL(url.href);
  page.pathname = name === INDEX ? basePath || '/' : `${basePath}/${name}`;
  if (page.pathname.startsWith(`${prefix}/`)) {
    return { page, data: page.pathname };
  }
  const under =
    basePath !== '' && page.pathname.startsWith(basePath)
      ? page.pathname.slice(basePath.length)
      : page.pathname;
  const spelled = under === '' || under === '/' ? INDEX_PAGE : under;
  return { page, data: `${prefix}${spelled}${DATA_SUFFIX}` };
}

/**
 * Of a page a data URL names, what the router serves in place of the dynamic route it resolves the
 * page to (`landedRoute`, in the runtime): a page of its own a dynamic route's pattern matches
 * (`filesystemPages`), or a file of the build — and a page of a gated route, whatever it is, whose
 * gate is asked whether or not a dynamic route resolves it.
 */
function landedOf(manifest: ProjectManifest, pathname: string): Named | undefined {
  const key = exactKeyOf(manifest, pathname);
  const gated = key === undefined ? undefined : gatedOf(manifest, key);
  if (gated !== undefined) {
    return { gated };
  }
  const pages = manifest.filesystemPages;
  const own = key !== undefined && pages !== undefined && Object.hasOwn(pages, key);
  return own || namesOwnFile(manifest, pathname) ? { gated: undefined } : undefined;
}

/**
 * The gated route that serves a request at a data URL the router reads as a page (`dataPageOf`):
 * a name the data URL is, then the page as the router lands on it (`landedOf`), then a dynamic
 * route of the page. No rule is taken to claim it: the router reads its rules on the page, and
 * leaves out the redirects `next build` writes itself for a request at a data URL, which the
 * manifest does not tell from the application's — a gate is asked rather than none.
 */
function normalizedRouteOf(
  manifest: ProjectManifest,
  data: DataPage,
  headers: Headers,
): string | undefined {
  const named = namedOf(manifest, data.data) ?? landedOf(manifest, data.page.pathname);
  return named === undefined
    ? routedDynamicRouteFor(manifest, data.page, headers)?.gated
    : named.gated;
}

/**
 * The gated route that serves a request (above), or `undefined` for none. A request at a Pages
 * Router data URL is judged with the `x-nextjs-data` Next.js puts on one itself, as the edge judges
 * one (`dataRequestHeaders`). A trailing slash is admitted to a dynamic route whatever the
 * application keeps its pages behind, as `functionFor` admits it: a redirect that would take it off
 * is a rule ahead of the filesystem, asked first.
 */
function gatedRouteOf(manifest: ProjectManifest, url: URL, headers: Headers): string | undefined {
  const routed = isPagesDataRequestPath(basePathOf(manifest), url.pathname)
    ? dataRequestHeaders(headers)
    : headers;
  const reserved = isReserved(manifest, url, routed, true);
  const props = reserved ? undefined : propsPageOf(manifest, url);
  if (props !== undefined) {
    return gatedOf(manifest, props);
  }
  const data = dataPageOf(manifest, url);
  if (data !== undefined) {
    return normalizedRouteOf(manifest, data, routed);
  }
  if (reserved) {
    return undefined;
  }
  const named = namedOf(manifest, url.pathname);
  if (named !== undefined) {
    return named.gated;
  }
  return pathIsReserved(routerRules(manifest), url, routed, false)
    ? undefined
    : routedDynamicRouteFor(manifest, url, routed)?.gated;
}

/**
 * The gate a request is asked of first (above), or `undefined` for none. Asked only of a `GET` or a
 * `HEAD`: a request of any other method is the application's Function's, and no gate's.
 */
export function gateFor(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): RouteGate | undefined {
  const { gates } = manifest;
  if (gates === undefined) {
    return undefined;
  }
  const route = gatedRouteOf(manifest, url, headers);
  const name = route !== undefined && Object.hasOwn(gates, route) ? gates[route] : undefined;
  return route === undefined || name === undefined ? undefined : { route, name };
}
