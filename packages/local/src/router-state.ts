import type { RouteHas } from '@stayingupwind/core/bundle';
import {
  NEXT_ROUTER_STATE_TREE_HEADER,
  RSC_CACHE_BUSTING_QUERY,
} from '@stayingupwind/core/request';

import { type CheckedStack, middlewareCovers } from './answers.ts';

/**
 * The router state a payload is asked from (`next-router-state-tree`), as the check builds it, and
 * where no tree it builds stands for a browser's (`stateTreeUnproved`).
 */

/**
 * The router state a navigation is asked from (`next-router-state-tree`), as the client router
 * sends it (`prepareFlightRouterStateForRequest`): a visitor on the page at `path`, each segment of
 * it under the root layout, and then the page — but for a route group, a parallel route or a
 * dynamic segment's parameter, which no path says, and which nothing the check judges reads where
 * nothing sees the tree (`stateTreeUnproved`).
 */
export function stateTreeOf(path: string): string {
  const segments = path.split('/').filter((named) => named !== '');
  let tree: unknown = ['__PAGE__', {}];
  for (const segment of segments.toReversed()) {
    tree = [segment, { children: tree }];
  }
  return encodeURIComponent(JSON.stringify(['', { children: tree }]));
}

/**
 * Whether a condition asks of the router state a request says, by a pattern of its value: of its
 * header, or of `_rsc`, the digest the client router names the request by, of that header among
 * others (`computeRscCacheBustingParam`) — not of either being there at all, which every request of
 * the router's is, the check's as a browser's.
 */
function asksOfRouterState(condition: RouteHas): boolean {
  if (condition.value === undefined) {
    return false;
  }
  return (
    (condition.type === 'header' &&
      condition.key?.toLowerCase() === NEXT_ROUTER_STATE_TREE_HEADER) ||
    (condition.type === 'query' && condition.key === RSC_CACHE_BUSTING_QUERY)
  );
}

/** Why no request proves a payload asked from the router state the check builds, in a verdict's words. */
const UNPROVED_STATE =
  'which a browser sends as its router has cached the pages it holds, and the check builds from the path of the page it is on alone: no request proves it';

/**
 * Why no request proves a payload asked with `headers` at `url` from the router state the check
 * builds (`stateTreeOf`), in a verdict's words — where anything that tells requests apart sees it: a
 * browser sends the tree of the page it goes to, marked where its router holds no data for a segment
 * (`createDynamicRequestTree`), which turns on what it has cached and no build records; so no tree
 * the check builds stands for a browser's where a rule of `next.config`, or a matcher of the
 * middleware's, asks of it or of `_rsc`; or where the middleware sees it itself, the build keeping
 * the router's headers on the request it runs on (`skipProxyUrlNormalize`). None where nothing does:
 * Next.js takes them off the request before the middleware runs, and the edge answers a payload
 * whatever state it is asked from, varying caches by it alone.
 */
export function stateTreeUnproved(
  stack: CheckedStack,
  url: URL,
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const { manifest } = stack;
  const rules = [
    ...(manifest.reservedRoutes ?? []),
    ...(manifest.headerRules ?? []),
    ...(manifest.foldedHeaderRules ?? []),
    ...(manifest.dynamicRoutes ?? []),
    ...(manifest.middleware?.matchers ?? []),
  ];
  const ruled = rules.some((rule) =>
    [...(rule.has ?? []), ...(rule.missing ?? [])].some((each) => asksOfRouterState(each)),
  );
  if (ruled) {
    return `a rule of next.config asks of the router state it is asked from, ${UNPROVED_STATE}`;
  }
  if (stack.bundle.config.skipProxyUrlNormalize === true && middlewareCovers(stack, url, headers)) {
    return `the application's middleware sees the router state it is asked from (skipProxyUrlNormalize), ${UNPROVED_STATE}`;
  }
  return undefined;
}
