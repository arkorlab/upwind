import { pagesDataPathname } from '@upwind/core/bundle';
import type { RouteEntryDescriptor } from '@upwind/core/cache';

import { nodeHandlerOf } from '../entries.ts';
import { descriptorFor } from '../generations.ts';
import { findShell, getStore, type Store } from '../store.ts';
import { requestContext } from './context.ts';
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
 */

interface RevalidateInput {
  readonly urlPath: string;
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
    throw new Error(`revalidate: no Node.js entrypoint for ${descriptor.route}`);
  }
  const outcome = await regenerate({
    runtime: context.runtime,
    request: context.request,
    handler,
    target: {
      descriptor,
      reason: 'manual',
      dataPathname:
        descriptor.kind === 'pages'
          ? pagesDataPathname(store.manifest.buildId, pathname)
          : undefined,
    },
    waitUntil: context.waitUntil,
    run: context.run,
  });
  if (outcome.kind !== 'published') {
    throw new Error(`revalidate: ${pathname} was not regenerated (${outcome.kind})`);
  }
}
