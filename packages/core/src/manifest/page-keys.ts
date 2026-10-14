import { compiledRules, patternOf } from '../request/compiled-patterns.ts';
import { testWithin } from '../request/pattern-budget.ts';
import { builtNameOf } from './built-names.ts';
import type { DynamicRoute, ProjectManifest } from './schema.ts';

/** What of a manifest tells a page of its own from a member of a dynamic route. */
type PagesOfTheirOwn = Pick<ProjectManifest, 'dynamicRoutes' | 'filesystemPages'>;

/**
 * Finding a page Next.js built by the path a request asks for it by, as Next.js finds it: in the
 * records of what it built that the edge reads — its routes, the pathnames it resolves exactly,
 * the Functions those are in.
 */

/** `pathname` decoded whole, or `undefined` where an escape in it is no escape. */
function decodedWhole(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

/**
 * Whether a pathname may be a member of a dynamic route: one of the routes' patterns matches it. A
 * pattern that cannot be asked — one that does not compile, or would cost more than a test is
 * allowed — is taken to match, so that a member is never taken for a page of its own.
 */
function mayBeMember(
  dynamicRoutes: readonly DynamicRoute[] | undefined,
  pathname: string,
): boolean {
  if (dynamicRoutes === undefined) {
    return false;
  }
  return compiledRules(dynamicRoutes).some((compiled) => {
    try {
      return testWithin(patternOf(compiled), pathname);
    } catch {
      return true;
    }
  });
}

/**
 * Whether a key is a page of its own: one the manifest lists as such (`filesystemPages`), or one no
 * dynamic route's pattern matches, and so no member of one.
 */
function isOwnPage(manifest: PagesOfTheirOwn, key: string): boolean {
  return (
    (manifest.filesystemPages !== undefined && Object.hasOwn(manifest.filesystemPages, key)) ||
    !mayBeMember(manifest.dynamicRoutes, key)
  );
}

/**
 * The key `record` holds a pathname under, as Next.js finds the page it asks for. Where no
 * delimiter is escaped, the path is read as spelled and then decoded, as it always was. Where one
 * is, the readings differ, and the order is Next.js's: its filesystem check finds a page of its
 * own (`isOwnPage`) as spelled and then decoded whole, ahead of any dynamic route (`getItem`,
 * `server/lib/router-utils/filesystem.ts`); a dynamic route then finds a member as spelled, or by
 * its built name (`builtNameOf`), reading an escaped slash as part of the value it is in.
 * `/docs/a%2fb` is the member `/docs/a%2Fb` (the value `a/b`), `/docs/c%2Fd` no member of a route
 * at `/docs/c/d`, and `/docs/a%2Fb` the page `/docs/a/b` where that is a page of its own. Decoded
 * whole for a member, an escaped slash was a separator, and the request was answered as another
 * page. Only a pathname with an escaped delimiter asks the dynamic routes' patterns anything.
 *
 * A manifest from before the pages of their own were listed is read as it was then, as spelled and
 * then decoded whole: it is a build whose Functions find a page so.
 */
export function pageKeyOf(
  record: Readonly<Record<string, unknown>>,
  pathname: string,
  manifest: PagesOfTheirOwn,
): string | undefined {
  if (!pathname.includes('%')) {
    return Object.hasOwn(record, pathname) ? pathname : undefined;
  }
  const decoded = decodedWhole(pathname);
  if (manifest.filesystemPages === undefined) {
    return memberKey(record, pathname, decoded);
  }
  const built = builtNameOf(pathname);
  if (decoded !== built) {
    const own = [pathname, decoded].find(
      (key) => key !== undefined && Object.hasOwn(record, key) && isOwnPage(manifest, key),
    );
    if (own !== undefined) {
      return own;
    }
  }
  return memberKey(record, pathname, built);
}

/** The key of a member, or of a page where the readings agree: as spelled, or by its other name. */
function memberKey(
  record: Readonly<Record<string, unknown>>,
  pathname: string,
  other: string | undefined,
): string | undefined {
  if (Object.hasOwn(record, pathname)) {
    return pathname;
  }
  return other !== undefined && Object.hasOwn(record, other) ? other : undefined;
}
