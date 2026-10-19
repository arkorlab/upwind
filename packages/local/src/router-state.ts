import type { RouteHas } from '@stayingupwind/core/bundle';
import { middlewareApplies } from '@stayingupwind/core/paas';
import {
  NEXT_ROUTER_STATE_TREE_HEADER,
  PatternBudgetExceededError,
  RSC_CACHE_BUSTING_QUERY,
} from '@stayingupwind/core/request';

import { type CheckedStack, edgeReads } from './answers.ts';

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
 * others (`computeRscCacheBustingParam`) — not of mere presence, which the actual request's
 * headers and URL settle, including a redirect before the router replays its missing digest.
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

/** The fields this check reads; no running Worker or broad stack fixture is needed. */
interface StateStack {
  readonly manifest: Pick<
    CheckedStack['manifest'],
    'reservedRoutes' | 'headerRules' | 'foldedHeaderRules' | 'dynamicRoutes' | 'middleware'
  >;
  readonly bundle: Pick<CheckedStack['bundle'], 'middleware'> & {
    readonly config: Pick<CheckedStack['bundle']['config'], 'skipProxyUrlNormalize'>;
  };
  readonly app: Pick<CheckedStack['app'], 'middlewareScriptName'>;
}

interface StateRule {
  readonly sourceRegex: string;
  readonly has?: readonly RouteHas[] | undefined;
  readonly missing?: readonly RouteHas[] | undefined;
}

/**
 * Leave the unknown tree/digest values open in either polarity, but require the source and every
 * known condition. The shared matcher uses Next.js's case-insensitive patterns and escaped-path
 * fallback; this check is conservative wherever either spelling could reach a state-sensitive rule.
 */
function ruleCouldApply(rule: StateRule, url: URL, headers: Headers): boolean {
  const has = rule.has ?? [];
  const missing = rule.missing ?? [];
  const known = {
    sourceRegex: rule.sourceRegex,
    has: has.filter((condition) => !asksOfRouterState(condition)),
    missing: missing.filter((condition) => !asksOfRouterState(condition)),
  };
  try {
    return middlewareApplies([known], url, headers);
  } catch (error) {
    // A rule whose matching cannot be judged is no proof that the unknown state is unseen.
    if (error instanceof SyntaxError || error instanceof PatternBudgetExceededError) {
      return true;
    }
    throw error;
  }
}

/** Whether middleware may run, before it can replace routing headers or rewrite the URL. */
function middlewareCouldRun(stack: StateStack, url: URL, headers: Headers): boolean {
  return (
    stack.app.middlewareScriptName !== undefined &&
    ((stack.manifest.middleware?.matchers.some((rule) => ruleCouldApply(rule, url, headers)) ??
      false) ||
      (stack.bundle.middleware?.matchers.some((rule) => ruleCouldApply(rule, url, headers)) ??
        false))
  );
}

function readsState(rule: StateRule): boolean {
  return (
    (rule.has ?? []).some((condition) => asksOfRouterState(condition)) ||
    (rule.missing ?? []).some((condition) => asksOfRouterState(condition))
  );
}

/** Why no request proves a payload asked from the router state the check builds, in a verdict's words. */
const UNPROVED_STATE =
  'which a browser sends as its router has cached the pages it holds, and the check builds from the path of the page it is on alone: no request proves it';

/**
 * Why no request proves a payload asked with `headers` at `url` from the router state the check
 * builds (`stateTreeOf`), in a verdict's words, for the actual flow headers and URL, after cookies
 * and redirect headers are applied — where anything that tells requests apart sees it: a
 * browser sends the tree of the page it goes to, marked where its router holds no data for a segment
 * (`createDynamicRequestTree`), which turns on what it has cached and no build records; so no tree
 * the check builds stands for a browser's where a rule of `next.config`, or a matcher of the
 * middleware's, asks of it or of `_rsc`; or where the middleware sees it itself, the build keeping
 * the router's headers on the request it runs on (`skipProxyUrlNormalize`). None where nothing does:
 * Next.js takes them off the request before the middleware runs, and the edge answers a payload
 * whatever state it is asked from, varying caches by it alone.
 */
export function stateTreeUnproved(
  stack: StateStack,
  url: URL,
  headers: Readonly<Record<string, string>>,
): string | undefined {
  const handed = edgeReads(headers);
  if (!handed.has(NEXT_ROUTER_STATE_TREE_HEADER)) {
    return undefined;
  }
  const { manifest } = stack;
  const before = [
    ...(manifest.headerRules ?? []),
    ...(manifest.foldedHeaderRules ?? []),
    ...(manifest.middleware?.matchers ?? []),
  ];
  const after = [...(manifest.reservedRoutes ?? []), ...(manifest.dynamicRoutes ?? [])];
  const middleware = middlewareCouldRun(stack, url, handed);
  // Headers are selected before middleware. Routing is judged again after it, against a URL and
  // request fields it can replace: browser-side path and companion conditions cannot exclude it.
  const ruled =
    before.some((rule) => readsState(rule) && ruleCouldApply(rule, url, handed)) ||
    after.some((rule) => {
      if (!readsState(rule)) return false;
      return middleware || ruleCouldApply(rule, url, handed);
    });
  if (ruled) {
    return `a rule of next.config asks of the router state it is asked from, ${UNPROVED_STATE}`;
  }
  if (middleware && stack.bundle.config.skipProxyUrlNormalize === true) {
    return `the application's middleware sees the router state it is asked from (skipProxyUrlNormalize), ${UNPROVED_STATE}`;
  }
  return undefined;
}
