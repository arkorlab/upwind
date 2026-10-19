import {
  pagesDataPathnameUnder,
  type Prerender,
  sharedShellPathname,
} from '@stayingupwind/core/bundle';
import {
  appPathFor,
  deriveEntry,
  IMPLICIT_TAG_PREFIX,
  implicitTagsFor,
  MAX_TAG_LENGTH,
  normalizeRoutePathname,
  type RouteEntryDescriptor,
  sharedShellTagOf,
} from '@stayingupwind/core/cache';

import { nodeHandlerOf } from '../entries.ts';
import { descriptorFor } from '../generations.ts';
import { escapedNameOf } from '../name-spellings.ts';
import { elsewhere } from '../placement.ts';
import { routingParameters } from '../route-parameters.ts';
import {
  completedShell,
  entrypointKindOf,
  findShell,
  getStore,
  queryCompletedShell,
  type Store,
} from '../store.ts';
import { requestContext } from './context.ts';
import { generationClassShell } from './generation-tags.ts';
import { invalidateNow } from './handlers.ts';
import { regenerate } from './regenerate.ts';
import type { CacheRuntime } from './runtime.ts';

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
 * A page a reusable terminal shell stands for is regenerated as that shell, which its class shares;
 * an entry of the page's own, where it has one, is then invalidated by the page's tags.
 */

interface RevalidateInput {
  readonly urlPath: string;
}

/**
 * The tags a page at `pathname` is cached under as itself, as `revalidatePath` names them — and, in
 * an application that keeps its pages at a trailing slash (`trailingSlash`), as an entry rendered
 * for a request at that spelling is tagged: a regeneration names its entry by the pathname the edge
 * asked for, slash and all (`generationTagValues`).
 */
function pathTags(store: Store, pathname: string): string[] {
  const tags = [`${IMPLICIT_TAG_PREFIX}${pathname}`];
  const slashed = `${IMPLICIT_TAG_PREFIX}${pathname}/`;
  if (pathname === '/') {
    tags.push(`${IMPLICIT_TAG_PREFIX}/index`);
  } else if (store.manifest.config.trailingSlash && slashed.length <= MAX_TAG_LENGTH) {
    // Within the host's bound alone: past it, the host would refuse the call with the page's
    // other tags in it, which a page in another Function sends whatever their length.
    tags.push(slashed);
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

/** Only a built, resumable class leaves the visitor's dynamic tail unresolved during regeneration. */
function sharedPathname(store: Store, shell: Prerender): string | undefined {
  return store.manifest.config.cacheComponents === true &&
    entrypointKindOf(store, shell.route) === 'app-page'
    ? sharedShellPathname(shell)
    : undefined;
}

function manualPathname(store: Store, shell: Prerender, pathname: string): string {
  return (
    sharedPathname(store, shell) ??
    queryCompletedShell(shell, pathname) ??
    completedShell(shell, pathname)
  );
}

/** The selected page's existing manual key, or the identity of its reusable terminal shell. */
function routeOf(store: Store, pathname: string): RouteEntryDescriptor | undefined {
  const named = store.prerendersByPathname.get(pathname);
  // The router resolves a closed route's concrete page by name before its dynamic routes. Open
  // fallback seeds are not in pathnames: one of those must still yield to a more specific route.
  if (named !== undefined && store.pathnames.includes(pathname)) {
    const shell = findShell(store, named.route, pathname);
    if (shell?.id === named.id) {
      return descriptorFor(store, named.route, manualPathname(store, shell, pathname));
    }
  }
  for (const route of orderedRoutes(store)) {
    const shell = findShell(store, route, pathname);
    if (shell !== undefined) {
      return descriptorFor(store, route, manualPathname(store, shell, pathname));
    }
  }
  return undefined;
}

/**
 * A page a shared shell stands for may also hold an entry of its own, rendered for its parameters
 * where a host asked for one (`CACHE_UPGRADE_HEADER`), which publishing the shared shell does not
 * replace. Once it is published, that entry is invalidated by the page's own tags, as for a page in
 * another Function — never by the shared identity, whose new generation is in place. At each of its
 * `spellings`: the one asked, which an entry of its own was made under — an escaped one, of a value
 * that reads as the shell's placeholder, among them — and the name the build gives it. Never by a
 * tag the shell carries itself: a page spelled as one of its route's layouts (`/blog/layout`, of
 * `/blog/[slug]`) is tagged as that layout is, and invalidated by it, would take the shell just
 * published, and every page under the layout, with it; such a page's own entry keeps its lifetime.
 */
async function invalidateOwnEntry(
  runtime: CacheRuntime,
  store: Store,
  spellings: readonly string[],
  shell: RouteEntryDescriptor,
): Promise<void> {
  const carried = new Set(implicitTagsFor(appPathFor(shell.kind, shell.route)));
  const own = new Set(
    spellings
      .filter((spelling) => spelling !== shell.pathname)
      .flatMap((spelling) => pathTags(store, spelling))
      .filter((tag) => tag.length <= MAX_TAG_LENGTH && !carried.has(tag)),
  );
  if (own.size > 0) {
    await invalidateNow(runtime, [...own]);
  }
}

export async function platformRevalidate(input: RevalidateInput): Promise<void> {
  const context = requestContext();
  if (context?.runtime === undefined) {
    return;
  }
  const { runtime } = context;
  const store = getStore();
  const asked = input.urlPath.split('?', 1)[0] ?? input.urlPath;
  const name = escapedNameOf(store, asked) ?? asked;
  // Use the same built name and trailing-slash normalization as routing and the entry's key.
  // This is the concrete request path, distinct from the class a blocking shell completes to.
  const pathname = normalizeRoutePathname(
    name.length > 1 && name.endsWith('/') ? (store.slashSpellings.get(name) ?? name) : name,
  );
  const descriptor = routeOf(store, pathname);
  if (descriptor === undefined) {
    throw new Error(`revalidate: no page answers ${pathname}`);
  }
  // A page on the edge runtime has no generation to make: nothing here captures its render.
  const handler = await nodeHandlerOf(context.tables, descriptor.route);
  const shell = findShell(store, descriptor.route, pathname);
  const shared = shell !== undefined && sharedPathname(store, shell) === descriptor.pathname;
  const tags = async (): Promise<string[]> => {
    // A shared class can hold a long resolved prefix. Its bounded identity is sufficient even
    // when the visitor's legacy pathname tag would exceed the cache host's tag-length limit.
    const values = pathTags(store, pathname).filter(
      (tag) => !shared || tag.length <= MAX_TAG_LENGTH,
    );
    if (shared) {
      const { entryId } = await deriveEntry(runtime.scopeId, descriptor);
      values.push(sharedShellTagOf(entryId));
    }
    return values;
  };
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
    await invalidateNow(context.runtime, await tags());
    return;
  }
  // As routing hands a render of a request for it the page's parameters, where Next.js would read
  // them otherwise off its name (`routingParameters`).
  // The previous generation stays servable if this local attempt fails. Other isolates learn a
  // successful publication through their normal record refresh, as for any manual regeneration.
  const parameters = routingParameters(store, descriptor.route, descriptor.pathname);
  const targetShell = findShell(store, descriptor.route, descriptor.pathname);
  const outcome = await regenerate({
    runtime: context.runtime,
    request: context.request,
    handler,
    target: {
      descriptor,
      isClass: generationClassShell(descriptor, targetShell),
      reason: 'manual',
      allowHeader: targetShell?.allowHeader,
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
  if (shared) {
    const spellings = [normalizeRoutePathname(asked), pathname];
    await invalidateOwnEntry(context.runtime, store, spellings, descriptor);
  }
}
