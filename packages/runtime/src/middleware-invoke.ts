import { type MiddlewareResult, responseToMiddlewareResult } from '@next/routing';
import { onLoopbackOrigin } from '@stayingupwind/core/paas';

import { middlewareHandler } from './entries.ts';
import { hasBody } from './incoming.ts';
import { preferredLocaleRedirect } from './locale-redirect.ts';
import { type MiddlewareInvoker, redirectResponse, routedHeaders } from './routing.ts';
import type { HandleInput, RoutedInput } from './serve.ts';
import { deploymentConfig, type Store } from './store.ts';

/**
 * Running the application's middleware: on its own, when the edge asks for that alone, and for the
 * router, as a phase of routing a request.
 */

export const MIDDLEWARE_ENTRY_ID = '/_middleware';
const HTTP_OK = 200;
const HTTP_TEMPORARY_REDIRECT = 307;
/** What a Pages Router data URL ends in. */
const DATA_SUFFIX = '.json';
const REWRITE_HEADER = 'x-middleware-rewrite';

export async function runMiddleware(
  input: HandleInput,
  request: Request,
): Promise<Response | undefined> {
  const handler = await middlewareHandler(input, MIDDLEWARE_ENTRY_ID);
  if (handler === undefined) {
    return undefined;
  }
  return handler(request, {
    waitUntil: input.waitUntil,
    requestMeta: { relativeProjectDir: '.' },
  });
}

/** What the middleware left behind that the router does not hand back. */
export interface MiddlewareTrace {
  /** Whether the middleware ran for this request, and so may still read its side of the body. */
  invoked: boolean;
  /** A whole response the middleware sent, to answer with as it is. */
  response: Response | undefined;
  /** The request headers as the middleware rewrote them, for whoever handles the request. */
  requestHeaders: Headers | undefined;
  /** Where the middleware rewrote the request to, when it did: what a route that matched nothing was asked at. */
  rewrite: URL | undefined;
  /** The status the middleware gave its rewrite, where it gave one other than 200. */
  status: number | undefined;
  /**
   * What the middleware set on its answer, where it let the request on: routing merges it with the
   * rules' headers, and a host answering a file by the edge's rules reads it apart.
   */
  responseHeaders: Headers | undefined;
}

/**
 * The URL a middleware is handed: for a data request, the page it is for.
 *
 * Next.js hands a middleware the page a `_next/data` request asks for, with the query, and the
 * request's `x-nextjs-data` says what it is (`runMiddleware`, `server/next-server.ts`); only
 * `skipProxyUrlNormalize` hands it the URL as it came. `@next/routing` hands it the data URL. The
 * middleware's adapter writes `x-nextjs-rewrite` and `x-nextjs-redirect` in the form of the URL it
 * was handed, so a redirect of `/_next/data/<id>/es/old-home.json` came back as the data URL of
 * `/es/new-home` where the client's router is answered with the page (`server/web/adapter.ts`).
 */
function middlewareUrl(url: URL, store: Store): URL {
  const { basePath, skipProxyUrlNormalize, trailingSlash } = store.manifest.config;
  const prefix = `${basePath}/_next/data/${store.manifest.buildId}/`;
  if (
    skipProxyUrlNormalize === true ||
    !url.pathname.startsWith(prefix) ||
    !url.pathname.endsWith(DATA_SUFFIX)
  ) {
    return url;
  }
  const page = url.pathname.slice(prefix.length, -DATA_SUFFIX.length);
  const normalized = new URL(url);
  const pathname = page === 'index' ? basePath || '/' : `${basePath}/${page}`;
  // With the trailing slash the application keeps its pages under (`maybeAddTrailingSlash`).
  normalized.pathname = trailingSlash && !pathname.endsWith('/') ? `${pathname}/` : pathname;
  return normalized;
}

/**
 * A rewrite to the same loopback server spelled another way, kept on the request's own origin, as
 * Next.js's router keeps it (`onLoopbackOrigin`): `@next/routing` compares the `localhost` a
 * middleware's `NextURL` spells with the `127.0.0.1` a request came in on, and proxied the rewrite
 * back to the same server by name. Said to the client as that router says it, relative to the
 * request — but for a path that begins `//`, which a reader would take for another host's
 * (greptile): that one is said whole. Nothing is asked of a rewrite on the request's own origin.
 */
function keptOnLoopback(result: MiddlewareResult, url: URL): void {
  const { rewrite } = result;
  if (rewrite === undefined || rewrite.origin === url.origin) {
    return;
  }
  const own = onLoopbackOrigin(rewrite, url);
  if (own === undefined) {
    return;
  }
  result.rewrite = own;
  const relative = `${own.pathname}${own.search}${own.hash}`;
  result.responseHeaders?.set(REWRITE_HEADER, relative.startsWith('//') ? own.href : relative);
}

/**
 * Run the middleware for the router and keep what it decided.
 *
 * `resolveRoutes` returns the response headers routing collected (a middleware's cookies among
 * them) but not the request headers a middleware overrode: those are read off the object the
 * middleware result was applied to, which the router hands in and never hands back.
 */
export function middlewareInvoker(
  input: RoutedInput,
  store: Store,
  trace: MiddlewareTrace,
): MiddlewareInvoker {
  return async (ctx) => {
    trace.invoked = true;
    const response = await runMiddleware(
      input,
      new Request(middlewareUrl(ctx.url, store), {
        method: input.request.method,
        headers: ctx.headers,
        ...(hasBody(input.request.method) && { body: ctx.requestBody, duplex: 'half' }),
      }),
    );
    if (response === undefined) {
      return {};
    }
    const result = responseToMiddlewareResult(response, ctx.headers, ctx.url);
    keptOnLoopback(result, ctx.url);
    if (result.bodySent === true) {
      trace.response = response;
    }
    trace.requestHeaders = result.requestHeaders;
    trace.responseHeaders = result.responseHeaders;
    trace.rewrite = result.rewrite;
    if (result.rewrite !== undefined && response.status !== HTTP_OK) {
      trace.status = response.status;
    }
    return result;
  };
}

/**
 * The middleware alone, run ahead of a shell the edge serves itself: its raw response, for the edge
 * to apply. It reads the routing configuration — the base path tells a data request apart
 * (`routedHeaders`), and root locale negotiation precedes user middleware — without the store,
 * which is built over every route, prerender and file the deployment has. The middleware Function,
 * whose first request that shell waits on, carries only the manifest head (`deploymentConfig`).
 */
export async function answerMiddlewareOnly(input: RoutedInput): Promise<Response> {
  const { request } = input;
  const config = deploymentConfig();
  const url = new URL(request.url);
  const headers = routedHeaders(request, url, config.basePath);
  const locale = preferredLocaleRedirect(config, url, headers, input);
  if (locale !== undefined) {
    return redirectResponse(locale, HTTP_TEMPORARY_REDIRECT, undefined);
  }
  const response = await runMiddleware(input, new Request(request, { headers }));
  return response ?? new Response(null, { status: HTTP_OK, headers: { 'x-middleware-next': '1' } });
}
