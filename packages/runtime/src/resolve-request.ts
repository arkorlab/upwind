import { resolveRoutes, type ResolveRoutesResult } from '@next/routing';

import { middlewareInvoker, type MiddlewareTrace } from './middleware-invoke.ts';
import { settleRewrittenPath } from './rewritten-path.ts';
import {
  pathnamesFor,
  routedHeaders,
  routingI18n,
  routingTables,
  withRoutingHeaders,
} from './routing.ts';
import type { RoutedInput } from './serve.ts';
import type { Store } from './store.ts';

/**
 * A request routed as Next.js's router routes it, by the deployment's own tables: for the answer it
 * resolves to (`handle.ts`), and for what routing adds to an answer that came another way.
 */

/** What routing is asked about a request: where it is, the headers the router is handed, its body. */
export interface RoutingAsk {
  readonly url: URL;
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null | undefined;
  /** Leave the middleware out: one the edge has run, or none this Function holds. */
  readonly skipMiddleware: boolean;
  readonly trace: MiddlewareTrace;
}

/** A middleware's part in routing, before routing has run it: none yet. */
export function untraced(): MiddlewareTrace {
  return {
    invoked: false,
    response: undefined,
    requestHeaders: undefined,
    rewrite: undefined,
    status: undefined,
  };
}

/** A request routed as Next.js's router routes it, by this deployment's tables. */
export function routingOf(
  input: RoutedInput,
  store: Store,
  asked: RoutingAsk,
): Promise<ResolveRoutesResult> {
  const { url } = asked;
  const { basePath, i18n } = store.manifest.config;
  return resolveRoutes({
    url,
    buildId: store.manifest.buildId,
    basePath,
    requestBody: asked.body ?? new ReadableStream(),
    headers: asked.headers,
    pathnames: pathnamesFor(store, url),
    ...(i18n !== null && i18n !== undefined && { i18n: routingI18n(i18n) }),
    routes: routingTables(store, asked.skipMiddleware, url),
    invokeMiddleware: middlewareInvoker(input, store, asked.trace),
  });
}

/**
 * The answer a regeneration in the foreground gave, with what routing adds to every answer the usual
 * path gives (`answerResolved` in `handle.ts`): the headers `next.config` sets on the request — a
 * `Content-Security-Policy`, say, without which the page would go out unprotected — and what a
 * rewrite says of the path a payload was rendered for. Routed as the usual path routes the request,
 * but without the middleware, which the regeneration did not run either.
 */
export async function withRoutingOf(
  input: RoutedInput,
  store: Store,
  answer: Response,
): Promise<Response> {
  const url = new URL(input.request.url);
  const headers = routedHeaders(input.request, url, store.manifest.config.basePath);
  const routed = await routingOf(input, store, {
    url,
    headers,
    body: undefined,
    skipMiddleware: true,
    trace: untraced(),
  });
  settleRewrittenPath(routed.resolvedHeaders, headers, url, undefined);
  return withRoutingHeaders(answer, routed.resolvedHeaders);
}
