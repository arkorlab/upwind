import type { MemberRoute } from './schema.ts';

/**
 * The entry a member of a class the build left no shell of is kept under, where Next.js keys the
 * class's entries on some of its parameters and not all.
 *
 * Next.js 16.4 keys the render of such a member by the shell it completes to
 * (`buildCompletedShellCacheKey`, in the page's handler): the route with the parameters
 * `generateStaticParams` may still provide filled in — the root parameters among them — and every
 * other parameter left a placeholder, `/de/fr/posts/[id]` for `/de/fr/posts/1` of
 * `/[lang]/[region]/posts/[id]`. A parameter no build can provide is resumed for each request
 * rather than rendered into what is kept, so every member that shares the rest shares one shell.
 * The build says which parameters those are by the query the class's entries vary on
 * (`allowQuery`, `nxtPlang` and `nxtPregion`); every release before 16.4 names all of them there,
 * and its members are each their own entry.
 */

/** A single-segment parameter of a route: `[id]`, and neither catch-all. */
const SINGLE_PARAMETER = /^\[([^.[\]]+)\]$/u;

/**
 * The parameters a class's entries are keyed by, by name and in the route's order, where the build
 * names some of the route's parameters and not all; `undefined` where it names all of them — each
 * member is its own entry — or none, and where this cannot read what it names: a key that is not a
 * parameter of the route, or a route with a catch-all.
 */
export function keyedParameters(
  route: string,
  allowQuery: readonly string[] | undefined,
): string[] | undefined {
  const allowed = new Set(allowQuery);
  const segments = route.split('/').filter((segment) => segment.startsWith('['));
  const names = segments.map((segment) => SINGLE_PARAMETER.exec(segment)?.[1]);
  if (allowed.size === 0 || names.includes(undefined)) {
    return undefined;
  }
  const keyed = names.filter((name) => name !== undefined && allowed.has(`nxtP${name}`));
  return keyed.length === allowed.size && keyed.length < names.length
    ? (keyed as string[])
    : undefined;
}

/**
 * The pathname a member is kept under, of a class keyed by `keyedBy` (`keyedParameters`): `route`
 * with those parameters as the member's pathname has them and every other one a placeholder. A
 * pathname that does not line up with the route segment for segment is its own: nothing here says
 * which of its values are which.
 *
 * Without a trailing slash, as the entry is keyed without one (`normalizeRoutePathname`).
 */
export function completedPathname(
  route: string,
  keyedBy: readonly string[],
  pathname: string,
): string {
  const bare = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const routeSegments = route.split('/');
  const segments = bare.split('/');
  if (segments.length !== routeSegments.length) {
    return pathname;
  }
  const keyed = new Set(keyedBy);
  const completed: string[] = [];
  for (const [index, segment] of routeSegments.entries()) {
    const value = segments[index] ?? '';
    const parameter = SINGLE_PARAMETER.exec(segment)?.[1];
    if (parameter === undefined && value !== segment) {
      return pathname;
    }
    completed.push(parameter === undefined || keyed.has(parameter) ? value : segment);
  }
  return completed.join('/');
}

/**
 * The pathname a member of a class with no shell is kept under, which its record is read by: its
 * own, or the shell its class's entries complete to (`MemberRoute.keyedBy`).
 */
export function memberEntryPathname(
  members: Pick<MemberRoute, 'route' | 'keyedBy'>,
  pathname: string,
): string {
  return members.keyedBy === undefined
    ? pathname
    : completedPathname(members.route, members.keyedBy, pathname);
}
