import { functionOfRoute, placedRoutes } from '@stayingupwind/core/bundle';
import {
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  FUNCTION_HEADER,
  MISDIRECTED_STATUS,
  pathFromHeaders,
  RESUME_PRERENDER_ESCAPED_HEADER,
  RESUME_PRERENDER_HEADER,
  ROUTED_HEADER,
} from '@stayingupwind/core/paas';

import type { Resolved } from './outputs.ts';
import type { Store } from './store.ts';

/**
 * Which of a deployment's app Functions a request is for, where the build split its routes across
 * several (`functions.split`), and what this one answers when it is not.
 *
 * Every app Function carries the whole of `runtime.json`, so each routes a request as Next.js
 * would and knows where every route is; only its own routes' code is in it. A request for a route
 * of another is answered `421` with that Function's name (`MISDIRECTED_STATUS`) — and the request's
 * own body, unread, for the edge to send on — rather than not-found, which is what the route's
 * absence from this Function's table would otherwise come to.
 *
 * A deployment that was not split places no route anywhere but its one Function, and every check
 * here is one map's size before it is anything else.
 */

/** Where each route is, and which ids are routes at all: read off the store once per isolate. */
interface Placement {
  /** The app Function each route outside the first is in; empty for a deployment not split. */
  readonly placed: ReadonlyMap<string, string>;
  /** Every entrypoint id, in whichever Function its code is. */
  readonly entryIds: ReadonlySet<string>;
}

const PLACEMENTS = new WeakMap<Store, Placement>();

function placementOf(store: Store): Placement {
  let placement = PLACEMENTS.get(store);
  if (placement === undefined) {
    const { entrypoints } = store.manifest;
    placement = {
      placed: placedRoutes(entrypoints),
      entryIds: new Set(entrypoints.map((entry) => entry.id)),
    };
    PLACEMENTS.set(store, placement);
  }
  return placement;
}

/** This Function's name among the deployment's app Functions (`__ARKOR_FUNCTION_NAME__`). */
function ownName(): string {
  return __ARKOR_FUNCTION_NAME__;
}

/** The app Function a route is in, when that is not this one; `undefined` when it is. */
export function elsewhere(store: Store, route: string): string | undefined {
  const { placed } = placementOf(store);
  if (placed.size === 0) {
    return undefined;
  }
  const owner = functionOfRoute(placed, route);
  return owner === ownName() ? undefined : owner;
}

/**
 * Where a routed request is answered: the app Function its route is in, when that is not this
 * one. Read as the request will be answered — a file the Function carries, which every app
 * Function carries alike; the route itself, when routing landed on an entrypoint; otherwise the
 * route of the prerender the pathname names, or of the class the router resolved it to by the
 * class's own name, which is the page that renders it (`renderedBy`). A request that lands on none
 * of these is not-found here as much as anywhere, and stays.
 */
export function ownerOfResolved(store: Store, resolved: Resolved): string | undefined {
  const { placed, entryIds } = placementOf(store);
  if (placed.size === 0 || store.staticFiles.has(resolved.route)) {
    return undefined;
  }
  const route = entryIds.has(resolved.route)
    ? resolved.route
    : (
        store.prerendersByPathname.get(resolved.pathname) ??
        store.prerendersByPathname.get(resolved.route)
      )?.route;
  return route === undefined ? undefined : elsewhere(store, route);
}

/** The responses this runtime made to say a request is another Function's. */
const MISDIRECTED = new WeakSet<Response>();

/**
 * The answer to a request for another Function's route: its name, the routing it came to where it
 * was routed here (`ROUTED_HEADER`), and the request's body as it arrived, for the edge to send on.
 */
export function misdirected(
  owner: string,
  body: ReadableStream<Uint8Array> | null,
  routed?: string,
): Response {
  const headers = new Headers({ [FUNCTION_HEADER]: owner });
  if (routed !== undefined) {
    headers.set(ROUTED_HEADER, routed);
  }
  const response = new Response(body, { status: MISDIRECTED_STATUS, headers });
  MISDIRECTED.add(response);
  return response;
}

/**
 * The route a request that arrives already decided names, ahead of any routing: the prerender a
 * resume asks for, or the route a runtime resume or a regeneration names. `undefined` for a request
 * that names none, which is routed first.
 */
function namedRoute(store: Store, request: Request): string | undefined {
  const prerenderId = pathFromHeaders(
    request.headers,
    RESUME_PRERENDER_HEADER,
    RESUME_PRERENDER_ESCAPED_HEADER,
  );
  if (prerenderId !== undefined) {
    return store.prerendersById.get(prerenderId)?.route;
  }
  return pathFromHeaders(request.headers, CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER);
}

/** The Function a response of `misdirected` names; `undefined` for any other response. */
export function misdirectedTo(response: Response): string | undefined {
  return MISDIRECTED.has(response)
    ? (response.headers.get(FUNCTION_HEADER) ?? undefined)
    : undefined;
}

/**
 * A resume or a regeneration for a route of another Function: answered as misdirected before it is
 * read, so the body — a generation's postponed state — goes back whole.
 */
export function misdirectedAhead(store: Store, request: Request): Response | undefined {
  if (placementOf(store).placed.size === 0) {
    return undefined;
  }
  const route = namedRoute(store, request);
  const owner = route === undefined ? undefined : elsewhere(store, route);
  return owner === undefined ? undefined : misdirected(owner, request.body);
}

/**
 * An answer as it leaves the Function: one of the application's own carries neither of the headers
 * only this runtime may set, since the edge acts on them.
 */
export function withoutPlacementHeaders(response: Response): Response {
  if (
    MISDIRECTED.has(response) ||
    (!response.headers.has(FUNCTION_HEADER) && !response.headers.has(ROUTED_HEADER))
  ) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(FUNCTION_HEADER);
  headers.delete(ROUTED_HEADER);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
