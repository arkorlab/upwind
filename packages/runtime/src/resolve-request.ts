import { resolveRoutes, type ResolveRoutesResult } from '@next/routing';
import { CACHE_OUTCOME_HEADER } from '@stayingupwind/core/paas';
import { releaseStream } from '@stayingupwind/core/util';

import { afterBody, outcomeOn } from './generations.ts';
import { middlewareInvoker, type MiddlewareTrace } from './middleware-invoke.ts';
import { settleRewrittenPath } from './rewritten-path.ts';
import {
  parametersDecode,
  pathnamesFor,
  redirectResponse,
  routedHeaders,
  routingI18n,
  routingTables,
  undecodedResponse,
  withRoutingHeaders,
} from './routing.ts';
import { externalRewrite, type RoutedInput } from './serve.ts';
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
 * What routing answers a request with itself, where it does, in the order the usual path reads it
 * (`routeAndServe`): a redirect; a 400, for a parameter that does not decode; what another origin
 * answers, where a rewrite sends the request there (`externalRewrite`) — asked as routing hands the
 * request on, with what it uploads; or, where it found no route for it (no pathname, or nothing to
 * invoke), a rule's status (`routingAnswer`). Where it found no route and says nothing itself, the
 * render stands: the route the edge named was regenerated, and the edge serves the requests after
 * this one from that generation, which the usual path's not-found would answer otherwise.
 */
async function answeredByRouting(
  routed: ResolveRoutesResult,
  asked: { readonly request: Request; readonly headers: Headers },
): Promise<Response | undefined> {
  const { redirect, resolvedHeaders } = routed;
  if (redirect !== undefined) {
    return redirectResponse(redirect.url.href, redirect.status, resolvedHeaders);
  }
  if (!parametersDecode(routed.routeMatches)) {
    return undecodedResponse(resolvedHeaders);
  }
  if (routed.externalRewrite !== undefined) {
    const forwarded = new Request(asked.request, { headers: asked.headers });
    return withRoutingHeaders(
      await externalRewrite(forwarded, routed.externalRewrite),
      resolvedHeaders,
    );
  }
  const unrouted = routed.resolvedPathname === undefined || routed.invocationTarget === undefined;
  return unrouted ? routingAnswer(routed) : undefined;
}

/**
 * The answer a regeneration in the foreground gave, with what routing adds to every answer the usual
 * path gives (`answerResolved` in `handle.ts`): the headers `next.config` sets on the request — a
 * `Content-Security-Policy`, say, without which the page would go out unprotected — and what a
 * rewrite says of the path a payload was rendered for. Routed as the usual path routes the request,
 * but without the middleware, which the regeneration did not run either; and where routing answers
 * it itself — a redirect, a 400, another origin's answer, a rule's status, which a request it finds
 * no route for comes back with — answered so, as the usual path answers it (`routeAndServe`,
 * `unrouted`), the render let go.
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
  const itself = await answeredByRouting(routed, { request: input.request, headers });
  if (itself !== undefined) {
    // The render is not read, nor what the request uploads, as on every routing exit — but for what
    // another origin was sent, which took it. What the regeneration came to is still said
    // (`CACHE_OUTCOME_HEADER`): it ran, whatever answers.
    releaseStream(input.request.body, 'routing exit: handler body unused');
    releaseStream(answer.body, 'foreground answer: routing answered the request itself');
    const outcome = answer.headers.get(CACHE_OUTCOME_HEADER);
    return outcome === null ? itself : outcomeOn(itself, outcome);
  }
  const routedAnswer = withRoutingHeaders(answer, routed.resolvedHeaders);
  // What the request uploads is let go of once the answer is done with — and only then, as the
  // render may read it while it streams. A request with none, as every document a regeneration is
  // asked for is, has nothing to let go of, and its answer goes out as it came.
  const { body } = input.request;
  return body === null
    ? routedAnswer
    : afterBody(routedAnswer, () => {
        releaseStream(body, 'foreground answer: handler body unused');
      });
}
