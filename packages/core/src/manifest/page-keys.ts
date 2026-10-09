import { compiledRules, patternOf } from '../request/compiled-patterns.ts';
import { testWithin } from '../request/pattern-budget.ts';
import { builtNameOf } from './built-names.ts';
import type { DynamicRoute } from './schema.ts';

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
 * The key `record` holds a pathname under, as Next.js finds the page it asks for: as the request
 * spelled it; then decoded whole, where that is a page of its own — no dynamic route's pattern
 * matches it, so it is no member of one — which Next.js's filesystem check finds ahead of any
 * dynamic route (`getItem`, `server/lib/router-utils/filesystem.ts`); and then by its built name
 * (`builtNameOf`), as a dynamic route reads a member's value, an escaped slash inside its segment.
 * `/docs/a%2fb` is the member `/docs/a%2Fb` (the value `a/b`), and `/docs/c%2Fd` no member of a
 * route at `/docs/c/d`; decoded whole, an escaped slash was a separator, and the request was
 * answered as another page. The readings differ only where a delimiter is escaped, and a pathname
 * with nothing to decode costs the one lookup it always did.
 */
export function pageKeyOf(
  record: Readonly<Record<string, unknown>>,
  pathname: string,
  dynamicRoutes: readonly DynamicRoute[] | undefined,
): string | undefined {
  if (Object.hasOwn(record, pathname)) {
    return pathname;
  }
  if (!pathname.includes('%')) {
    return undefined;
  }
  const built = builtNameOf(pathname);
  const decoded = decodedWhole(pathname);
  if (
    decoded !== undefined &&
    decoded !== built &&
    Object.hasOwn(record, decoded) &&
    !mayBeMember(dynamicRoutes, decoded)
  ) {
    return decoded;
  }
  return built !== undefined && Object.hasOwn(record, built) ? built : undefined;
}
