import { pageOfPagesData } from '../bundle/pages-data.ts';
import { dynamicRouteFor, isExactPathname, isReserved } from './dynamic.ts';
import { findRouteEntry } from './manifest.ts';
import { pageKeyOf } from './page-keys.ts';
import type { ProjectManifest } from './schema.ts';

/**
 * Which gate a request is asked of before the edge serves it anything, for a deployment that
 * declares any (`ProjectManifest.gates`): the gate of the route the request is of.
 *
 * The route is found the way Next.js routes the request, as far as the manifest follows it — as
 * `functionFor` finds the Function a request goes to. A redirect or a rewrite of `next.config`
 * ahead of the filesystem first, which takes the request elsewhere; then the pathnames Next.js
 * resolves exactly, a gated route's among them (`gatedPathnames`); then the dynamic routes in their
 * own order, each that lands on a gated route naming it (`DynamicRoute.gated`). A request for a
 * Pages Router page's props is of the page whose props it asks for.
 *
 * `undefined` for a request of a route with no gate, and for one the manifest finds no route of.
 * Neither is answered with anything the edge holds of a gated route: the routes it serves a request
 * from storage by are found by the same tables, in the same order.
 */

/** A request's gate, and the route it is asked of the request as. */
export interface RouteGate {
  /** The route as the build declared it, which the gate is told the request is of. */
  readonly route: string;
  /** The gate's name, which a host binds the gate under. */
  readonly name: string;
}

/**
 * The gated route of a request for a page's props (`pagesDataPrefix`), where the page is one the
 * build prerendered — the only props the edge holds, and so found by the page's own name, as the
 * edge finds them (`pageOfPagesData`).
 */
function propsRouteOf(manifest: ProjectManifest, url: URL): string | undefined {
  const prefix = manifest.pagesDataPrefix;
  const gated = manifest.gatedPathnames;
  if (prefix === undefined || gated === undefined) {
    return undefined;
  }
  const basePath = manifest.pagesDataBasePath ?? '';
  const trailingSlash = manifest.trailingSlash === true;
  const page = pageOfPagesData(prefix, basePath, url.pathname, trailingSlash);
  return page !== undefined && Object.hasOwn(gated, page) ? gated[page] : undefined;
}

/**
 * The gated route a request is of, found as Next.js finds the route (above): a pathname of a route
 * with no gate, exactly or as a member of its class, is of no gated route. A trailing slash is
 * admitted whatever the application keeps its pages behind, as `functionFor` admits it: a redirect
 * that would take it off is a rule ahead of the filesystem, asked first.
 */
function gatedRouteOf(manifest: ProjectManifest, url: URL, headers: Headers): string | undefined {
  if (isReserved(manifest, url, headers, true)) {
    return undefined;
  }
  const { pathname } = url;
  const gated = manifest.gatedPathnames;
  // Found as a route is (`pageKeyOf`), as the edge finds the route's own entry.
  const exact = gated === undefined ? undefined : pageKeyOf(gated, pathname, manifest);
  if (exact !== undefined) {
    return gated?.[exact];
  }
  if (findRouteEntry(manifest, pathname) !== undefined || isExactPathname(manifest, pathname)) {
    return undefined;
  }
  return dynamicRouteFor(manifest, url, headers, true)?.gated;
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
  const route = propsRouteOf(manifest, url) ?? gatedRouteOf(manifest, url, headers);
  const name = route !== undefined && Object.hasOwn(gates, route) ? gates[route] : undefined;
  return route === undefined || name === undefined ? undefined : { route, name };
}
