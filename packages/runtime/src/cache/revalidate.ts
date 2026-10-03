import { pagesDataPathname } from '@stayingupwind/core/bundle';
import { IMPLICIT_TAG_PREFIX, type RouteEntryDescriptor } from '@stayingupwind/core/cache';

import { nodeHandlerOf } from '../entries.ts';
import { descriptorFor } from '../generations.ts';
import { elsewhere } from '../placement.ts';
import { findShell, getStore, type Store } from '../store.ts';
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

/** The route whose shell answers a pathname, and its router; `undefined` when none does. */
function routeOf(store: Store, pathname: string): RouteEntryDescriptor | undefined {
  for (const route of store.shellsByRoute.keys()) {
    if (findShell(store, route, pathname) !== undefined) {
      return descriptorFor(store, route, pathname);
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
  const outcome = await regenerate({
    runtime: context.runtime,
    request: context.request,
    handler,
    target: {
      descriptor,
      reason: 'manual',
      allowHeader: findShell(store, descriptor.route, pathname)?.allowHeader,
      dataPathname:
        descriptor.kind === 'pages'
          ? pagesDataPathname(store.manifest.buildId, pathname)
          : undefined,
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
