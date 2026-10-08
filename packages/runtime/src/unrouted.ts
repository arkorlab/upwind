import type { ResolveRoutesResult } from '@next/routing';
import { isPagesDataPathname } from '@stayingupwind/core/bundle';
import { releaseStream } from '@stayingupwind/core/util';

import { notFound } from './documents.ts';
import { notFoundData } from './pages-not-found.ts';
import { missesInPlainText, redirectResponse, withRoutingHeaders } from './routing.ts';
import { plainNotFoundResponse, type RoutedInput } from './serve.ts';
import type { Store } from './store.ts';

/**
 * A request routing found no route for: a middleware redirect, or a rule that answers with a
 * status, comes back as headers and a status with no route behind them; anything else is the
 * not-found document, rendered for the request as the middleware left it — at the URL it
 * rewrote the request to, when it did, since the router hands back no URL of its own.
 */
export async function unrouted(
  routed: ResolveRoutesResult,
  forwarded: RoutedInput,
  store: Store,
  at: URL,
): Promise<Response> {
  const location = routed.resolvedHeaders?.get('location') ?? undefined;
  if (routed.status !== undefined) {
    // Nothing below will read the forwarded body — the slower half of the request's tee — and
    // leaving it queued keeps the whole upload in the isolate for an answer that has no body.
    releaseStream(forwarded.request.body, 'routing exit: handler body unused');
    return location === undefined
      ? new Response(null, { status: routed.status, headers: new Headers(routed.resolvedHeaders) })
      : redirectResponse(location, routed.status, routed.resolvedHeaders);
  }
  // A data request is answered in its own terms. The client router parses what comes back as the
  // page's props, and a document under a 404 would be parsed as those — Next.js answers its own
  // `notFound` on a data request with exactly this, and so does the platform for a page that is
  // not there at all.
  if (
    isPagesDataPathname(store.manifest.config.basePath, new URL(forwarded.request.url).pathname)
  ) {
    releaseStream(forwarded.request.body, 'pages data not found: handler body unused');
    return withRoutingHeaders(notFoundData(), routed.resolvedHeaders);
  }
  if (missesInPlainText(forwarded.request, at, store.manifest.config)) {
    releaseStream(forwarded.request.body, 'plain not found: handler body unused');
    return withRoutingHeaders(plainNotFoundResponse(), routed.resolvedHeaders);
  }
  return withRoutingHeaders(await notFound(forwarded, store, at), routed.resolvedHeaders);
}
