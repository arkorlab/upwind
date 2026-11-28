import { PRIMARY_FUNCTION } from '../bundle/function-name.ts';
import { pageOfPagesData } from '../bundle/pages-data.ts';
import { middlewareApplies } from '../paas/middleware.ts';
import { type CompiledRule, patternOf } from '../request/compiled-patterns.ts';
import { execWithin } from '../request/pattern-budget.ts';
import {
  casedDynamicRouteFor,
  isCanonicalPathname,
  isExactPathname,
  isReserved,
  routedDynamicRouteFor,
} from './dynamic.ts';
import { findRouteEntry, staticFileKey } from './manifest.ts';
import { pageKeyOf } from './page-keys.ts';
import { firstReservedRule } from './reserved.ts';
import { findRouteBody } from './route-bodies.ts';
import type { AppRuntime, ProjectManifest, ReservedRoute } from './schema.ts';
import { findStaticPage, findPagesFallback } from './static-pages.ts';
const PAGES_FALLBACK_PRIVACY = 3;

/**
 * Which app Function an edge sends a request to, for a deployment whose routes the build split
 * across more than one (`AppRuntime.functions`).
 *
 * Read the way Next.js routes, as far as the manifest can follow it without running anything: a
 * redirect or rewrite of `next.config` ahead of the filesystem first, then the pathnames it resolves
 * exactly — a shell's, a route's, a prerendered member's — then the rewrites after the filesystem,
 * then the dynamic routes in their own order. Where the manifest says, the answer is the Function
 * that route is in; where it cannot — a rewrite decides the route, a pathname matches nothing, the
 * manifest carries no tables at all — the answer is `undefined`, and the request goes to the first
 * Function, which answers it or names the Function that does.
 *
 * Nothing here decides what a request is answered with, only where it is answered: the Function
 * that receives it routes it as Next.js does, and one handed a request for a route it does not hold
 * answers that it does not (`MISDIRECTED_STATUS`). An answer here that turns out wrong costs one
 * more hop, never a different response.
 *
 * What it reads is the request as it is asked of the application: after the middleware, where the
 * edge ran the middleware itself, and as the client sent it otherwise — in which case a middleware
 * rewrite can still take the request to another Function's route, which that answer corrects.
 */
export function functionFor(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
  method = 'GET',
): string | undefined {
  if (manifest.app.functions === undefined) {
    return PRIMARY_FUNCTION;
  }
  if (isReserved(manifest, url, headers, true)) {
    return undefined;
  }
  const { pathname } = url;
  const props = pairedPropsFunction(manifest, url, headers);
  if (props !== undefined) return props;
  const exact = exactFunction(manifest, pathname);
  if (exact !== undefined) return exact;
  // Where a member is answered, not with what: the router finds one by its slashed spelling
  // wherever no redirect takes the slash off. Any redirect that would was asked above.
  if (manifest.dynamicRoutes === undefined || !isCanonicalPathname(pathname, true))
    return undefined;
  const reserved =
    manifest.reservedRoutes === undefined
      ? undefined
      : firstReservedRule(manifest.reservedRoutes, url, headers, false);
  if (reserved !== undefined) {
    return method === 'GET' ? rewriteFunction(manifest, url, headers, reserved) : undefined;
  }
  const dynamic = casedDynamicRouteFor(manifest.dynamicRoutes, url, headers);
  return dynamic === undefined ? undefined : (dynamic.function ?? PRIMARY_FUNCTION);
}

function exactFunction(manifest: ProjectManifest, pathname: string): string | undefined {
  const shell = findRouteEntry(manifest, pathname);
  if (shell !== undefined) {
    return shell.function ?? PRIMARY_FUNCTION;
  }
  const body = findRouteBody(manifest, pathname) ?? findStaticPage(manifest, pathname);
  if (body !== undefined) {
    return body.function ?? PRIMARY_FUNCTION;
  }
  const exactFunctions = manifest.exactFunctions;
  // Found as a route is (`pageKeyOf`): decoded whole, an escaped slash named another page's
  // Function (`/docs/a%2Fb` for that of the member `/docs/a/b`).
  const exact =
    exactFunctions === undefined ? undefined : pageKeyOf(exactFunctions, pathname, manifest);
  if (exact !== undefined && exactFunctions !== undefined) {
    return exactFunctions[exact];
  }
  return isExactPathname(manifest, pathname) ? PRIMARY_FUNCTION : undefined;
}

const FIRST_CAPTURE = '$1';
const SIMPLE_SLUG = /^[\w-]+(?:\/[\w-]+)*$/u;

/** The first Function for a proved afterFiles landing. The Function still routes the original URL. */
function rewriteFunction(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
  reserved: CompiledRule<ReservedRoute>,
): string | undefined {
  const destination = reserved.rule.dispatchDestination;
  if (destination === undefined || staticFileKey(manifest, url.pathname) !== undefined) {
    return undefined;
  }
  if (
    manifest.middleware !== undefined &&
    middlewareApplies(manifest.middleware.matchers, url, headers)
  ) {
    return undefined;
  }
  let pathname = destination;
  if (destination.endsWith(FIRST_CAPTURE)) {
    const slug = execWithin(patternOf(reserved), url.pathname)?.[1];
    // In particular, removing a suffix from the source can leave "." or "..".
    if (slug === undefined || !SIMPLE_SLUG.test(slug)) return undefined;
    pathname = destination.slice(0, -FIRST_CAPTURE.length) + slug;
  }
  const landed = new URL(url);
  landed.pathname = pathname;
  if (staticFileKey(manifest, pathname) !== undefined || manifest.images?.path === pathname) {
    return undefined;
  }
  const exact = exactFunction(manifest, pathname);
  const dynamic = routedDynamicRouteFor(manifest, landed, headers);
  const owner = dynamic === undefined ? undefined : (dynamic.function ?? PRIMARY_FUNCTION);
  // A prerendered member and an exact entrypoint can look alike in these tables. Where the
  // dynamic and exact readings disagree, leave the rewritten-path decision to the router.
  if (exact !== undefined && owner !== undefined && exact !== owner) return undefined;
  return exact ?? owner;
}

/** Versioned props are sent to the Function of their actual member or native class. */
function pairedPropsFunction(
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): string | undefined {
  const pathname = url.pathname;
  const props =
    manifest.pagesDataPrefix === undefined
      ? undefined
      : pageOfPagesData(
          manifest.pagesDataPrefix,
          manifest.pagesDataBasePath ?? '',
          pathname,
          manifest.trailingSlash === true,
        );
  if (props !== undefined) {
    const pageUrl = new URL(url.href);
    pageUrl.pathname = props;
    const page = findStaticPage(manifest, props);
    if (page?.staticPagePrivacy === PAGES_FALLBACK_PRIVACY && page.dataPathname === pathname)
      return page.function ?? PRIMARY_FUNCTION;
    const fallback = findPagesFallback(manifest, pageUrl, headers);
    if (fallback?.dataPathname === pathname) return fallback.entry.function ?? PRIMARY_FUNCTION;
  }
  return undefined;
}

/**
 * The name a Function is reached by: the first's `scriptName`, or the one `functions` gives. An
 * app Function the deployment does not run is `undefined` — a name a Function answered with that
 * the deployment never had, which whoever asked must not act on.
 */
export function functionScript(app: AppRuntime, name: string): string | undefined {
  if (name === PRIMARY_FUNCTION) {
    return app.scriptName;
  }
  const { functions } = app;
  return functions !== undefined && Object.hasOwn(functions, name) ? functions[name] : undefined;
}
