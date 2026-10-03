import { namesNoFile, withTrailingSlash } from '../manifest/dynamic.ts';
import type { DeploymentBundle, Prerender } from './schema.ts';

/**
 * How a request spells a pathname of the build. Next.js names what it builds without a trailing
 * slash, and an application that keeps its pages behind one (`trailingSlash`) is asked for each of
 * them with it: `next build` writes a redirect of `/about` to `/about/`, ahead of everything else,
 * and serves the page at the spelling it redirects to.
 */

/** A dynamic route's template: the class shell no request names, `[` and all. */
export function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

/**
 * Whether the build keeps its pages behind a trailing slash: `trailingSlash`, and the redirect
 * `next build` adds to put every page there. Where `skipTrailingSlashRedirect` leaves that redirect
 * out, Next.js serves a page at both spellings, and the edge serves it at the one the build named
 * it by, as it always did — the spelling without the slash stays the edge's.
 */
export function keepsTrailingSlash(bundle: DeploymentBundle): boolean {
  const { skipTrailingSlashRedirect, trailingSlash } = bundle.config;
  return trailingSlash && !skipTrailingSlashRedirect;
}

/**
 * The spelling a request asks for a pathname of the build by: behind the trailing slash an
 * application keeps its pages behind (`withTrailingSlash`), and as the build named it otherwise.
 * The base path's own root gains the slash whatever its last segment reads like — `next build`
 * redirects it by name (`/docs.v1` → `/docs.v1/`), not by the pattern the other pages go by.
 *
 * A rule of `next.config` is judged against this, as the router judges one against the request.
 * Read against the name the build gave the page instead, the redirect `next build` adds for
 * `trailingSlash` claimed every page but the root, and kept all of them off the edge.
 */
export function requestedPathname(bundle: DeploymentBundle, pathname: string): string {
  if (!keepsTrailingSlash(bundle)) {
    return pathname;
  }
  const { basePath } = bundle.config;
  return basePath !== '' && pathname === basePath ? `${pathname}/` : withTrailingSlash(pathname);
}

/**
 * Every spelling the router finds a pathname of the build by: as the build named it, as a request
 * asks for it (`requestedPathname`), and — where the application has `trailingSlash` — with the
 * slash, wherever its last segment names no file. That takes in a shipped file (`/manual/` is the
 * file `/manual`) and a path under `/.well-known`, which Next.js's redirect gives no slash but which
 * its router finds by one all the same, as a page or a file of that name. The router finds them so
 * whether or not the build writes the redirect: `skipTrailingSlashRedirect` leaves the page named
 * without the slash, and the router still finds it by both spellings.
 */
export function routerSpellings(bundle: DeploymentBundle, pathname: string): string[] {
  const takesSlash =
    bundle.config.trailingSlash &&
    namesNoFile(pathname) &&
    !isTemplate(pathname) &&
    !pathname.endsWith('/');
  return [
    ...new Set([
      pathname,
      requestedPathname(bundle, pathname),
      ...(takesSlash ? [`${pathname}/`] : []),
    ]),
  ];
}

/**
 * The name a manifest gives the route a prerender is served as: the spelling a request asks for
 * the page by, so the edge finds it by the request's own pathname and the other spelling goes to
 * the Function to redirect; and a dynamic route's class shell by its template, which the manifest's
 * dynamic routes name it by and no request spells.
 */
export function routePathnameOf(bundle: DeploymentBundle, prerender: Prerender): string {
  const { pathname } = prerender;
  return isTemplate(pathname) ? pathname : requestedPathname(bundle, pathname);
}
