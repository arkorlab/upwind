import { withTrailingSlash } from '../manifest/dynamic.ts';
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
  const { basePath, trailingSlash } = bundle.config;
  if (!trailingSlash) {
    return pathname;
  }
  return basePath !== '' && pathname === basePath ? `${pathname}/` : withTrailingSlash(pathname);
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
