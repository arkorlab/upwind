import { PRIMARY_FUNCTION } from '../bundle/function-name.ts';
import { dynamicRouteFor, isExactPathname, isReserved } from './dynamic.ts';
import { findRouteEntry, keyOf } from './manifest.ts';
import type { AppRuntime, ProjectManifest } from './schema.ts';

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
): string | undefined {
  if (manifest.app.functions === undefined) {
    return PRIMARY_FUNCTION;
  }
  if (isReserved(manifest, url, headers, true)) {
    return undefined;
  }
  const { pathname } = url;
  const shell = findRouteEntry(manifest, pathname);
  if (shell !== undefined) {
    return shell.function ?? PRIMARY_FUNCTION;
  }
  const exactFunctions = manifest.exactFunctions;
  const exact = exactFunctions === undefined ? undefined : keyOf(exactFunctions, pathname);
  if (exact !== undefined && exactFunctions !== undefined) {
    return exactFunctions[exact];
  }
  if (isExactPathname(manifest, pathname)) {
    return PRIMARY_FUNCTION;
  }
  // Where a member is answered, not with what: the router finds one by its slashed spelling wherever
  // no redirect takes the slash off — `skipTrailingSlashRedirect` writes none — and a redirect that
  // would is a reserved route, asked above. The edge serves a member at the slash only where the
  // pages are kept there, but the Function that holds its route is the same either way.
  const dynamic = dynamicRouteFor(manifest, url, headers, true);
  return dynamic === undefined ? undefined : (dynamic.function ?? PRIMARY_FUNCTION);
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
