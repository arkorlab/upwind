import { resolveRoutes, type ResolveRoutesResult } from '@next/routing';
import { releaseStream } from '@stayingupwind/core/util';

import { middlewareInvoker, type MiddlewareTrace } from './middleware-invoke.ts';
import { settleRewrittenPath } from './rewritten-path.ts';
import {
  pathnamesFor,
  redirectResponse,
  routedHeaders,
  routingI18n,
  routingTables,
  withRoutingHeaders,
} from './routing.ts';
import type { RoutedInput } from './serve.ts';
import type { Store } from './store.ts';
import { routingAnswer } from './unrouted.ts';

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
 * What routing answers a request with itself, where it does: a redirect, or — where it found no route
 * for it — a rule's status (`routingAnswer`).
 */
function answeredByRouting(routed: ResolveRoutesResult): Response | undefined {
  const { redirect } = routed;
  if (redirect !== undefined) {
    return redirectResponse(redirect.url.href, redirect.status, routed.resolvedHeaders);
  }
  return routed.resolvedPathname === undefined ? routingAnswer(routed) : undefined;
}

/**
 * The answer a regeneration in the foreground gave, with what routing adds to every answer the usual
 * path gives (`answerResolved` in `handle.ts`): the headers `next.config` sets on the request — a
 * `Content-Security-Policy`, say, without which the page would go out unprotected — and what a
 * rewrite says of the path a payload was rendered for. Routed as the usual path routes the request,
 * but without the middleware, which the regeneration did not run either; and where routing answers
 * it itself — a redirect, a rule's status, which a request it finds no route for comes back with —
 * answered so, as the usual path answers it (`routeAndServe`, `unrouted`), the render let go.
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
  const itself = answeredByRouting(routed);
  if (itself !== undefined) {
    releaseStream(answer.body, 'foreground answer: routing answered the request itself');
    return itself;
  }
  return withRoutingHeaders(answer, routed.resolvedHeaders);
}
