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
 * them, each that lands on a gated route naming it (`DynamicRoute.gated`). No router of a build that
 * declares a gate reads a Pages Router data URL as the page it names: Next.js has one do so only
 * for a build with a middleware (`shouldNormalizeNextData`), which declares none (`gateIssues`).
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

/** A path without the one slash it may end in, the root's aside. */
function withoutTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
}

/**
 * Whether a pathname is the image optimizer's, by either spelling of one trailing slash, as the
 * edge answers it ahead of every route (`classifyImageRequest`): `next/image` asks for
 * `/_next/image/` where the application keeps its pages behind the slash.
 */
function namesOptimizer(manifest: ProjectManifest, pathname: string): boolean {
  const { images } = manifest;
  return (
    images !== undefined && withoutTrailingSlash(pathname) === withoutTrailingSlash(images.path)
  );
}

/**
 * What the router resolves a pathname to by name: a page, of whichever route, a file, or the image
 * optimizer's own path, which is answered ahead of every dynamic route (`namesOptimizer`).
 */
function namedOf(manifest: ProjectManifest, pathname: string): Named | undefined {
  const key = exactKeyOf(manifest, pathname);
  if (key !== undefined) {
    return { gated: gatedOf(manifest, key) };
  }
  const answeredAhead = namesOptimizer(manifest, pathname) || namesOwnFile(manifest, pathname);
  return answeredAhead ? { gated: undefined } : undefined;
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
  if (isReserved(manifest, url, routed, true)) {
    return undefined;
  }
  const props = propsPageOf(manifest, url);
  if (props !== undefined) {
    return gatedOf(manifest, props);
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
