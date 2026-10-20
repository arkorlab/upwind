import { ROUTE_BODY_BUILD_HEADERS, ROUTER_PROTOCOL_HEADERS } from './constants.ts';

/** An active Next.js control request cannot be answered with a sealed non-HTML route body. */
export function hasRouteBodyControlHeader(headers: Headers): boolean {
  return (
    ROUTE_BODY_BUILD_HEADERS.some((name) => name !== 'host' && headers.has(name)) ||
    ROUTER_PROTOCOL_HEADERS.some((name) => headers.has(name))
  );
}
