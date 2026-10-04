import type { BuildProjectManifestInput } from '../manifest/manifest.ts';
import type { DynamicRoute } from '../manifest/schema.ts';
import { PRIMARY_FUNCTION } from './function-name.ts';
import type { DeploymentBundle, Entrypoint, FunctionSpec, Prerender } from './schema.ts';
import { routerSpellings } from './spelling.ts';

/** A route's own name in brackets (`/[id]`): a class of pathnames, not one of them. */
function isTemplate(pathname: string): boolean {
  return pathname.includes('[');
}

/**
 * Which app Function a route's code is in.
 *
 * A bundle the build did not split has one, `app`, and every route is in it. A split bundle
 * (`SPLIT_BUNDLE_VERSION`) places each route in one of several, and says so on the entrypoint; a
 * route it says nothing of is the first's. Read the same way by everything that has to agree on
 * it — the host sending a request, the Function deciding whether a request is its own — so it is
 * read here, once.
 */

/** The number after `app-` that orders `app-10` after `app-9`. */
function ordinal(name: string): number {
  return name === PRIMARY_FUNCTION ? 1 : Number(name.slice(PRIMARY_FUNCTION.length + 1));
}

/** Every app Function of a bundle with its name, the first (`app`) first and the rest in order. */
export function appFunctions(
  bundle: Pick<DeploymentBundle, 'functions'>,
): (readonly [name: string, spec: FunctionSpec])[] {
  const split = Object.entries(bundle.functions.split ?? {}).toSorted(
    ([a], [b]) => ordinal(a) - ordinal(b),
  );
  return [[PRIMARY_FUNCTION, bundle.functions.app], ...split];
}

/** Whether the build split the routes across more than one app Function. */
export function isSplitBundle(bundle: Pick<DeploymentBundle, 'functions'>): boolean {
  return Object.keys(bundle.functions.split ?? {}).length > 0;
}

/** The app Function an entrypoint's code is in. */
export function functionOfEntrypoint(entry: Pick<Entrypoint, 'function'>): string {
  return entry.function ?? PRIMARY_FUNCTION;
}

/**
 * The app Function each placed route is in, by entrypoint id: only the routes outside the first,
 * since a route this does not name is the first's. Empty for a bundle that was not split.
 */
export function placedRoutes(
  entrypoints: readonly Pick<Entrypoint, 'id' | 'function'>[],
): ReadonlyMap<string, string> {
  const placed = new Map<string, string>();
  for (const entry of entrypoints) {
    if (entry.function !== undefined) {
      placed.set(entry.id, entry.function);
    }
  }
  return placed;
}

/**
 * The app Function that answers a route, by its entrypoint id: the one the route is placed in, or
 * the first. A route id no entrypoint has — a static file's, a page the build closed — is the
 * first's too; whoever asks has found no code of a route of its own to place.
 */
export function functionOfRoute(placed: ReadonlyMap<string, string>, route: string): string {
  return placed.get(route) ?? PRIMARY_FUNCTION;
}

/** The app Function that answers a prerender: the one its route is in. */
export function functionOfPrerender(
  placed: ReadonlyMap<string, string>,
  prerender: Pick<Prerender, 'route'>,
): string {
  return functionOfRoute(placed, prerender.route);
}

/**
 * Of the pathnames Next.js resolves exactly, the ones an app Function other than the first answers:
 * a route's own, and a prerendered member's, which its route's Function renders. A shell's pathname
 * is not among them — the host names the Function on the shell's own entry — and neither is any
 * pathname of a bundle that was not split, which places no route anywhere but the first.
 */
function exactFunctionsOf(
  bundle: DeploymentBundle,
  routeKeys: ReadonlySet<string>,
  placed: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  if (placed.size === 0) {
    return undefined;
  }
  const exact: Record<string, string> = {};
  const add = (pathname: string, route: string): void => {
    const owner = placed.get(route);
    if (owner !== undefined && !isTemplate(pathname) && !routeKeys.has(pathname)) {
      exact[pathname] = owner;
    }
  };
  // Under every spelling the exact pathnames have it by (`routerSpellings`): `/stream/` is the page
  // `/stream` where the application keeps its pages behind the slash, and is asked of its Function.
  for (const entry of bundle.entrypoints) {
    for (const spelling of routerSpellings(bundle, entry.pathname)) {
      add(spelling, entry.id);
    }
  }
  for (const prerender of bundle.prerenders) {
    for (const spelling of routerSpellings(bundle, prerender.pathname)) {
      add(spelling, prerender.route);
    }
  }
  return Object.keys(exact).length === 0 ? undefined : exact;
}

/** What `dynamicRouting` gives a manifest: the tables, and where a split bundle's routes are. */
export type DynamicRouting = Pick<
  BuildProjectManifestInput,
  'dynamicRoutes' | 'exactFunctions' | 'exactPathnames' | 'reservedRoutes'
>;

/**
 * The routing tables of a split bundle with each route's Function on them: on a dynamic route, the
 * Function its template's entrypoint is in — `routing.dynamicRoutes` and the tables' own are in one
 * order — and beside the exact pathnames, the ones another Function answers. A bundle that was not
 * split comes back as it went in, byte for byte.
 */
export function withFunctions(
  bundle: DeploymentBundle,
  routeKeys: ReadonlySet<string>,
  tables: DynamicRouting,
): DynamicRouting {
  const placed = placedRoutes(bundle.entrypoints);
  if (placed.size === 0) {
    return tables;
  }
  // A dynamic route's destination names its template the way an entrypoint's pathname does.
  const byTemplate = new Map(
    bundle.entrypoints.flatMap((entry) =>
      entry.function === undefined ? [] : [[entry.pathname, entry.function] as const],
    ),
  );
  const dynamicRoutes = tables.dynamicRoutes?.map((route, at): DynamicRoute => {
    const template = bundle.routing.dynamicRoutes[at]?.destination?.split('?', 1)[0];
    const owner = template === undefined ? undefined : byTemplate.get(template);
    return owner === undefined ? route : { ...route, function: owner };
  });
  const exactFunctions = exactFunctionsOf(bundle, routeKeys, placed);
  return {
    ...tables,
    ...(dynamicRoutes !== undefined && { dynamicRoutes }),
    ...(exactFunctions !== undefined && { exactFunctions }),
  };
}
