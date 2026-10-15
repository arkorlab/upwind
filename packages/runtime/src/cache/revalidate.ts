import { pagesDataPathnameUnder } from '@stayingupwind/core/bundle';
import { IMPLICIT_TAG_PREFIX, type RouteEntryDescriptor } from '@stayingupwind/core/cache';

import { nodeHandlerOf } from '../entries.ts';
import { descriptorFor } from '../generations.ts';
import { elsewhere } from '../placement.ts';
import { routingParameters } from '../route-parameters.ts';
import { completedShell, findShell, getStore, type Store } from '../store.ts';
import { requestContext } from './context.ts';
import { invalidateNow } from './handlers.ts';
import { regenerate } from './regenerate.ts';

/**
 * What a Pages Router `res.revalidate(urlPath)` does here: the page at that path is regenerated
 * now, as a manual attempt, and the call returns once the new generation is published. Next.js
 * reaches this through the router server methods it expects a server to provide; without a cache
 * the call is answered and nothing happens, as it would be with none.
 *
 * Anything but a published generation throws — a render with nothing to publish, an attempt
 * already holding the lease, a refusal. The caller is a webhook or a route that answers its own
 * caller once this resolves, and what it would be saying is that the page has been revalidated.
 *
 * Except for a page another app Function holds, in a build split across several: that one is
 * invalidated rather than rendered here, and is rendered by its own Function when next asked for.
 */

interface RevalidateInput {
  readonly urlPath: string;
}

/** The tags a page at `pathname` is cached under as itself, as `revalidatePath` names them. */
function pathTags(pathname: string): string[] {
  const tags = [`${IMPLICIT_TAG_PREFIX}${pathname}`];
  if (pathname === '/') {
    tags.push(`${IMPLICIT_TAG_PREFIX}/index`);
  }
  return tags;
}

/** The precedence of a route segment in Next.js's route tree (`sorted-routes.ts`). */
const OPTIONAL_CATCH_ALL_RANK = 3;

/** A literal segment sorts before a parameter, a catch-all and an optional catch-all. */
function segmentKind(segment: string): number {
  if (!segment.startsWith('[') || !segment.endsWith(']')) return 0;
  if (segment.startsWith('[[...') && segment.endsWith(']]')) return OPTIONAL_CATCH_ALL_RANK;
  return segment.startsWith('[...') ? 2 : 1;
}

/**
 * Next.js walks literal children before dynamic, catch-all and optional catch-all children, at
 * each level. Counting literals over the whole route would put `/[id]/edit` before `/blog/[...all]`,
 * though `/blog/edit` belongs to the latter. A route itself precedes any of its children.
 */
function compareRoutes(left: readonly string[], right: readonly string[]): number {
  // eslint-disable-next-line unicorn/prefer-iterator-zip -- Iterator.zip is not in this runtime's ES2024 library.
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index] ?? '';
    const b = right[index] ?? '';
    const kind = segmentKind(a) - segmentKind(b);
    if (kind !== 0) return kind;
    if (a !== b && segmentKind(a) === 0) return a < b ? -1 : 1;
  }
  return left.length - right.length;
}

/**
 * The manifest's shells are concrete prerenders first, then templates, not route precedence.
 * Prepare that precedence only for the first manual revalidation of an immutable deployment;
 * ordinary renders pay nothing for it and later calls reuse it.
 */
const routesByStore = new WeakMap<Store, readonly string[]>();

/** The deployment's source routes in precedence order, reused by later manual revalidations. */
function orderedRoutes(store: Store): readonly string[] {
  let routes = routesByStore.get(store);
  if (routes === undefined) {
    routes = [...store.shellsByRoute.keys()]
      .map((route) => ({ route, segments: route.split('/') }))
      .toSorted((a, b) => compareRoutes(a.segments, b.segments))
      .map(({ route }) => route);
    routesByStore.set(store, routes);
  }
  return routes;
}

/**
 * The route whose shell answers a pathname, and the entry it is kept under; `undefined` when none
 * does. A member of a route that blocks is kept under the shell it completes to, where the build
 * keys the route's entries by some of its parameters (`completedShell`): that entry is the one its
 * requests read, and the one Next.js 16.4 revalidates for it.
 */
function routeOf(store: Store, pathname: string): RouteEntryDescriptor | undefined {
  const name =
    pathname.length > 1 && pathname.endsWith('/')
      ? (store.slashSpellings.get(pathname) ?? pathname)
      : pathname;
  const named = store.prerendersByPathname.get(name);
  // The router resolves a closed route's concrete page by name before its dynamic routes. Open
  // fallback seeds are not in pathnames: one of those must still yield to a more specific route.
  if (named !== undefined && store.pathnames.includes(pathname)) {
    const shell = findShell(store, named.route, name);
    if (shell?.id === named.id) {
      return descriptorFor(store, named.route, completedShell(shell, name));
    }
  }
  for (const route of orderedRoutes(store)) {
    const shell = findShell(store, route, pathname);
    if (shell !== undefined) {
      return descriptorFor(store, route, completedShell(shell, pathname));
    }
  }
  return undefined;
}

export async function platformRevalidate(input: RevalidateInput): Promise<void> {
  const context = requestContext();
  if (context?.runtime === undefined) {
    return;
  }
  const pathname = input.urlPath.split('?', 1)[0] ?? input.urlPath;
  const store = getStore();
  const descriptor = routeOf(store, pathname);
  if (descriptor === undefined) {
    throw new Error(`revalidate: no page answers ${pathname}`);
  }
  // A page on the edge runtime has no generation to make: nothing here captures its render.
  const handler = await nodeHandlerOf(context.tables, descriptor.route);
  if (handler === undefined) {
    // A page in another app Function, where a build split its routes across several: an App
    // Router page a Pages Router handler asks for, since the Pages Router travels whole
    // (`split.ts`). This Function cannot render it, nor ask the one that holds it to; it is
    // invalidated instead, as `revalidatePath` invalidates a page, and rendered anew by its own
    // Function for the next request that asks for it.
    // A route on the edge runtime has no generation to invalidate, here or there.
    const entry = store.manifest.entrypoints.find((one) => one.id === descriptor.route);
    if (entry?.runtime === 'edge' || elsewhere(store, descriptor.route) === undefined) {
      throw new Error(`revalidate: no Node.js entrypoint for ${descriptor.route}`);
    }
    await invalidateNow(context.runtime, pathTags(pathname));
    return;
  }
  // As routing hands a render of a request for it the page's parameters, where Next.js would read
  // them otherwise off its name (`routingParameters`).
  const parameters = routingParameters(store, descriptor.route, descriptor.pathname);
  const outcome = await regenerate({
    runtime: context.runtime,
    request: context.request,
    handler,
    target: {
      descriptor,
      reason: 'manual',
      allowHeader: findShell(store, descriptor.route, descriptor.pathname)?.allowHeader,
      dataPathname:
        descriptor.kind === 'pages'
          ? pagesDataPathnameUnder(store.manifest.buildId, store.manifest.config.basePath, pathname)
          : undefined,
      ...(parameters !== undefined && { parameters }),
    },
    previewToken: store.manifest.bypassToken,
    waitUntil: context.waitUntil,
    run: context.run,
  });
  // A regeneration answers once its render is made; this caller is the one that waits for the
  // commit behind it, since what it answers its own caller is that the page has been published.
  const published = outcome.kind === 'accepted' ? await outcome.published : outcome;
  if (published.kind !== 'published') {
    throw new Error(`revalidate: ${pathname} was not regenerated (${published.kind})`);
  }
}
