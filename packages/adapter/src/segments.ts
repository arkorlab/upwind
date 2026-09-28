import type { Prerender } from '@stayingupwind/core/bundle';

import type { BuildContext } from './collect.ts';

/**
 * How the build spelled the path of a file it wrote, read back.
 *
 * Two things stand between a route and the path of a file `next build` writes for it: the spelling
 * `normalizePagePath` gives the route, and the `basePath` `normalizePathnames` puts on afterwards.
 * Both are undone here, in that order, so what a path names can be read off it rather than matched
 * against a shape invented in this repository.
 */

/** Every pathname Next.js names carries the app's `basePath`; so does everything named here. */
export function withBasePath(basePath: string, pathname: string): string {
  return `${basePath}${pathname}`;
}

/**
 * A pathname as Next.js had it before the `basePath` went on.
 *
 * `normalizePathnames` prefixes every output's pathname at the very end of the build, after the
 * paths of the files it wrote were composed from the bare route — so the prefix has to come off
 * before those paths can be read back. Prefixing the root leaves the base path alone, since
 * `addPathPrefix('/', '/docs')` is `/docs/` and the trailing slash is then taken off, which is the
 * one case where taking the prefix off would otherwise leave nothing.
 */
function withoutBasePath(pathname: string, basePath: string): string {
  if (basePath === '' || !pathname.startsWith(basePath)) {
    return pathname;
  }
  return pathname === basePath ? '/' : pathname.slice(basePath.length);
}

/**
 * How the build spells a route in the paths of the files it writes for it, as `normalizePagePath`
 * does (`shared/lib/page-path/normalize-page-path.ts`): the root is written `/index`, and a route
 * that already begins with `/index` is nested under a second one. Both spellings are given, the
 * route's own first, so a reading anchored on one of them need not decide which case a route is —
 * each back under the `basePath`, which is the state the pathnames being read are in.
 */
function builtAs(pathname: string, basePath: string): string[] {
  const bare = withoutBasePath(pathname, basePath);
  const spellings = bare === '/' ? ['/index'] : [bare, `/index${bare}`];
  return spellings.map((spelling) => withBasePath(basePath, spelling));
}

/**
 * The value of `next-router-segment-prefetch` this output answers — `undefined` for an output that
 * is not a prefetch segment.
 *
 * Next.js writes a segment's pathname from its document's own: `path.join(normalizePagePath(route)
 * + prefetchSegmentDirSuffix, segmentPath) + prefetchSegmentSuffix`, in
 * `build/adapter/build-complete.ts`, where `segmentPath` is one of the `segmentPaths` the render
 * recorded and is the header value itself. Both suffixes arrive with the build (`routing.rsc`), so
 * this reads the pathname back the way that wrote it rather than matching a shape of its own.
 *
 * Anchored on the document the output travels with, not on a suffix found anywhere in the path: a
 * route whose own last part happens to read like one is still read as itself. An output the reading
 * does not account for keeps no segment path and travels with the Function, which is where every
 * prefetch went before this was recorded. That is the answer for a build that spells such a path
 * some way not seen here — never a guess at which document a segment belongs to. The host serves
 * what this names, and naming the wrong document would answer one page's prefetch with part of
 * another.
 */
export function segmentPathOf(
  prerender: Prerender,
  document: Prerender | undefined,
  basePath: string,
  rsc: BuildContext['routing']['rsc'],
): string | undefined {
  const { prefetchSegmentDirSuffix: dir, prefetchSegmentSuffix: suffix } = rsc;
  if (document === undefined || !prerender.pathname.endsWith(suffix)) {
    return undefined;
  }
  const named = prerender.pathname.slice(0, -suffix.length);
  const spellings = builtAs(document.pathname, basePath);
  for (const route of spellings) {
    const base = `${route}${dir}`;
    if (named.startsWith(base) && named[base.length] === '/') {
      return named.slice(base.length);
    }
  }
  return undefined;
}
