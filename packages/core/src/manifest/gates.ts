import { isPagesDataRequestPath, pageOfPagesData } from '../bundle/pages-data.ts';
import { dataRequestHeaders } from '../request/headers.ts';
import { dynamicRouteFor, isReserved } from './dynamic.ts';
import { findRouteEntry } from './manifest.ts';
import { pageKeyOf } from './page-keys.ts';
import type { ProjectManifest } from './schema.ts';

/**
 * Which gate a request is asked of before the edge serves it anything, for a deployment that
 * declares any (`ProjectManifest.gates`): the gate of the route that serves the request.
 *
 * The route is found as the edge finds what it serves a request from — the same tables in the same
 * order (`entryFor`, `pagesDataRequest`) — and, past what the edge serves, as Next.js routes the
 * request on: a redirect or a rewrite of `next.config` ahead of the filesystem first, which takes
 * the request elsewhere; then a page's props the edge holds; then the page Next.js resolves exactly,
 * a shell's route ahead of a page with none, whichever route either is of (`gatedPathnames`); then
 * the dynamic routes in their own order, each that lands on a gated route naming it
 * (`DynamicRoute.gated`) — and, where the router reads a Pages Router data URL as the page it names
 * (`gatedDataPrefix`), the dynamic route of that page.
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

const DATA_PREFIX = '/_next/data/';
const DATA_SUFFIX = '.json';
const INDEX = 'index';

/** The gated route a pathname Next.js resolves exactly is of, by its key; none for another's. */
function gatedOf(manifest: ProjectManifest, key: string): string | undefined {
  const gated = manifest.gatedPathnames;
  return gated !== undefined && Object.hasOwn(gated, key) ? gated[key] : undefined;
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

/**
 * A data URL under `gatedDataPrefix` as the router reads it (`normalizeNextDataUrl`, in
 * `@next/routing`): the page it names, `.json` taken off and `index` the base path's root.
 */
function dataPageOf(manifest: ProjectManifest, url: URL): URL | undefined {
  const prefix = manifest.gatedDataPrefix;
  if (prefix === undefined || !url.pathname.startsWith(`${prefix}/`)) {
    return undefined;
  }
  const basePath = prefix.slice(0, prefix.lastIndexOf(DATA_PREFIX));
  const named = url.pathname.slice(prefix.length + 1);
  const page = named.endsWith(DATA_SUFFIX) ? named.slice(0, -DATA_SUFFIX.length) : named;
  const landed = new URL(url.href);
  landed.pathname = page === INDEX ? basePath || '/' : `${basePath}/${page}`;
  return landed;
}

/**
 * The gated route that serves a request (above), or `undefined` for none. A request at a Pages
 * Router data URL is judged with the `x-nextjs-data` Next.js puts on one itself, as the edge judges
 * one (`dataRequestHeaders`). A trailing slash is admitted to a dynamic route whatever the
 * application keeps its pages behind, as `functionFor` admits it: a redirect that would take it off
 * is a rule ahead of the filesystem, asked first.
 */
function gatedRouteOf(manifest: ProjectManifest, url: URL, headers: Headers): string | undefined {
  const basePath = manifest.spelledPrefix?.basePath ?? manifest.pagesDataBasePath ?? '';
  const routed = isPagesDataRequestPath(basePath, url.pathname)
    ? dataRequestHeaders(headers)
    : headers;
  if (isReserved(manifest, url, routed, true)) {
    return undefined;
  }
  const props = propsPageOf(manifest, url);
  if (props !== undefined) {
    return gatedOf(manifest, props);
  }
  const exact = exactKeyOf(manifest, url.pathname);
  if (exact !== undefined) {
    return gatedOf(manifest, exact);
  }
  const dynamic = dynamicRouteFor(manifest, url, routed, true);
  if (dynamic !== undefined) {
    return dynamic.gated;
  }
  const page = dataPageOf(manifest, url);
  return page === undefined ? undefined : dynamicRouteFor(manifest, page, routed, true)?.gated;
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
