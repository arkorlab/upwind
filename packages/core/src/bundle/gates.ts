import type { DynamicRoute } from '../manifest/schema.ts';
import type { Issue } from '../schema/index.ts';
import { type RouteGates, routeGatesSchema } from './carried.ts';
import type { DynamicRouting } from './functions.ts';
import { routeOfPathname } from './gate-routes.ts';
import type { DeploymentBundle } from './schema.ts';
import { routerSpellings } from './spelling.ts';

/**
 * The gates a build declares: for each route it names, the gate a host binds under the name given,
 * which the edge asks about a request of that route before it serves the request anything — a
 * document, a router's request, a prefetch, a `HEAD`. The build says only which route is whose;
 * what a gate answers, and where it runs, are the host's.
 *
 * What a manifest carries for the edge to find a request's gate by, beside the declaration itself:
 * the pathnames Next.js resolves exactly that are of a gated route (`gatedPathnamesOf`), and on each
 * dynamic route that lands on one, that route (`withGates`) — which nothing else names where the
 * route's class has no shell.
 */

/** The environment variable a build declares its gates in, as JSON: `{ "<route>": "<gate>" }`. */
export const ROUTE_GATES_ENV = 'UPWIND_ROUTE_GATES';

/** What an issue says: what the issues it is made of say — a record's key's, say — or its own. */
function messageOf(issue: Issue): string {
  const inner: unknown = issue['issues'];
  const messages = Array.isArray(inner)
    ? inner.flatMap((each: unknown) => {
        return typeof each === 'object' && each !== null && 'message' in each
          ? [String(each.message)]
          : [];
      })
    : [];
  return messages.length === 0 ? issue.message : messages.join(', ');
}

/** An issue as a refusal says it: where, and what. */
function said(issue: Issue): string {
  const where = issue.path.map(String).join('.');
  return where === '' ? messageOf(issue) : `${where}: ${messageOf(issue)}`;
}

/**
 * The gates `raw` declares — the value of `ROUTE_GATES_ENV` — or `undefined` where it declares
 * none: unset, blank, or an empty object. Anything else that is not such an object is refused, and
 * the refusal says what is wrong with it: a build that meant to declare a gate and was read as
 * declaring none would serve the route to every visitor, no gate asked.
 */
export function declaredRouteGates(raw: string | undefined): RouteGates | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${ROUTE_GATES_ENV} is not JSON: ${detail}`, { cause: error });
  }
  const gates = routeGatesSchema.safeParse(parsed);
  if (!gates.success) {
    const issues = gates.error.issues.map((issue) => said(issue)).join('; ');
    throw new Error(
      `${ROUTE_GATES_ENV} is to be an object of each route to the name of its gate (${issues})`,
    );
  }
  return Object.keys(gates.data).length === 0 ? undefined : gates.data;
}

/**
 * The routing tables with each dynamic route that lands on a gated route's page, or answers its
 * data, naming that route (`DynamicRoute.gated`): `pages` are the page each of the tables' dynamic
 * routes lands on or answers the data of, in their order (`pageRoutes`). A bundle that declares no
 * gate comes back as it went in, byte for byte.
 */
export function withGates(
  bundle: DeploymentBundle,
  tables: DynamicRouting,
  pages: readonly (string | undefined)[],
): DynamicRouting {
  const { gates } = bundle;
  if (gates === undefined || tables.dynamicRoutes === undefined) {
    return tables;
  }
  // The route each lands on, its data's included, however the build named the page it lands on.
  const routeOf = routeOfPathname(bundle);
  const dynamicRoutes = tables.dynamicRoutes.map((route, at): DynamicRoute => {
    const page = pages[at];
    const gated = page === undefined ? undefined : routeOf(page);
    return gated !== undefined && Object.hasOwn(gates, gated) ? { ...route, gated } : route;
  });
  return { ...tables, dynamicRoutes };
}

/**
 * The pathnames Next.js resolves exactly that are of a gated route, each with that route: the
 * route's own, every one the build prerendered of it — a member, a shell, a page's payload — and,
 * for a Pages Router page, the name its props are asked for by (`routeOfPathname`), under each
 * spelling the router finds one by (`routerSpellings`). `undefined` for a bundle that declares no
 * gate.
 */
export function gatedPathnamesOf(bundle: DeploymentBundle): Record<string, string> | undefined {
  const { gates } = bundle;
  if (gates === undefined) {
    return undefined;
  }
  const gated: Record<string, string> = {};
  const add = (pathname: string, route: string | undefined): void => {
    if (route === undefined || !Object.hasOwn(gates, route)) {
      return;
    }
    for (const spelling of routerSpellings(bundle, pathname)) {
      gated[spelling] = route;
    }
  };
  const routeOf = routeOfPathname(bundle);
  for (const entry of bundle.entrypoints) {
    add(entry.pathname, routeOf(entry.pathname));
  }
  for (const prerender of bundle.prerenders) {
    add(prerender.pathname, prerender.route);
  }
  return gated;
}
