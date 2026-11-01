import { type MiddlewareResult, responseToMiddlewareResult } from '@next/routing';
import { headerRulesFor } from '@stayingupwind/core/manifest';
import { onLoopbackOrigin } from '@stayingupwind/core/paas';
import { REDIRECT_STATUSES } from '@stayingupwind/core/request';

import { middlewareHandler } from './entries.ts';
import { edgeJudgesHeaderRules, hasBody } from './incoming.ts';
import { withHeadersChanged } from './reframe.ts';
import { type MiddlewareInvoker, routedHeaders } from './routing.ts';
import type { HandleInput, RoutedInput } from './serve.ts';
import { deploymentConfig, type Store } from './store.ts';

/**
 * Running the application's middleware: on its own, when the edge asks for that alone, and for the
 * router, as a phase of routing a request.
 */

export const MIDDLEWARE_ENTRY_ID = '/_middleware';
const HTTP_OK = 200;
/** What a Pages Router data URL ends in. */
const DATA_SUFFIX = '.json';
const REWRITE_HEADER = 'x-middleware-rewrite';
type HeaderManifest = Parameters<typeof headerRulesFor>[0];
const terminalHeaderRules = new WeakMap<Store, HeaderManifest>();

/** Only the header rules that ran before middleware; keep their compiled patterns reusable. */
function headersBeforeMiddleware(store: Store): HeaderManifest {
  let manifest = terminalHeaderRules.get(store);
  if (manifest === undefined) {
    manifest = {
      routerReferences: store.manifest.routerReferences,
      headerRules: store.manifest.routing.beforeMiddleware.flatMap((rule) => {
        return rule.headers === undefined ||
          rule.destination !== undefined ||
          rule.status !== undefined
          ? []
          : [
              {
                sourceRegex: rule.sourceRegex,
                headers: rule.headers,
                has: rule.has,
                missing: rule.missing,
              },
            ];
      }),
    };
    terminalHeaderRules.set(store, manifest);
  }
  return manifest;
}

/** The router's terminal Location path loses its earlier headers and still carries transport fields. */
function terminalLocationResponse(
  input: RoutedInput,
  store: Store,
  response: Response,
  requestHeaders: Headers,
): Response {
  const configured = edgeJudgesHeaderRules(input.request.headers)
    ? {}
    : headerRulesFor(headersBeforeMiddleware(store), new URL(input.request.url), requestHeaders)
        .headers;
  return withHeadersChanged(response, (headers) => {
    for (const [name, value] of Object.entries(configured)) {
      if (name === 'set-cookie') {
        const cookies = headers.getSetCookie();
        headers.delete(name);
        headers.append(name, value);
        for (const cookie of cookies) headers.append(name, cookie);
      } else if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
    const transport = [...headers.keys()].filter((name) => name.startsWith('x-middleware-'));
    for (const name of transport) headers.delete(name);
  });
}

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
 * A data request routed under the default locale it did not name (`localizedDataUrl`): the URL it
 * was routed at, and the URL it came at.
 */
export interface LocalizedData {
  readonly routed: URL;
  readonly asked: URL;
}

/**
 * The URL a middleware is handed for `url`, the one routing invokes it at: a data request routed
 * under the default locale it did not name is handed as it came, which is what Next.js hands it
 * (`initURL`, where `skipProxyUrlNormalize` hands the URL as it came) — the locale is the route's,
 * put in front of it for matching alone (`middleware_next_data`). Handed the routed URL, a
 * middleware that rewrites by the path it is handed sent the request to a path with the locale in
 * it (`skip-trailing-slash-redirect`).
 */
function asked(url: URL, localized: LocalizedData | undefined): URL {
  if (url.pathname !== localized?.routed.pathname) {
    return url;
  }
  const original = new URL(url);
  original.pathname = localized.asked.pathname;
  return original;
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
  localized?: LocalizedData,
): MiddlewareInvoker {
  return async (ctx) => {
    trace.invoked = true;
    const handed = middlewareUrl(asked(ctx.url, localized), store);
    const response = await runMiddleware(
      input,
      new Request(handed, {
        method: input.request.method,
        headers: ctx.headers,
        ...(hasBody(input.request.method) && { body: ctx.requestBody, duplex: 'half' }),
      }),
    );
    if (response === undefined) {
      return {};
    }
    const location = response.headers.get('location');
    const beforeOverride =
      location === null || location === '' || REDIRECT_STATUSES.has(response.status)
        ? undefined
        : new Headers(ctx.headers);
    const result = responseToMiddlewareResult(response, ctx.headers, ctx.url);
    keptOnLoopback(result, ctx.url);
    // The routing helper passes a non-redirect Location through but leaves bodySent unset.
    // Next.js finishes with that response's body and status (resolve-routes.ts), before a
    // same-origin rewrite or next can continue. An external rewrite still takes precedence.
    if (
      beforeOverride !== undefined &&
      result.redirect === undefined &&
      (result.rewrite === undefined || result.rewrite.origin === ctx.url.origin)
    ) {
      result.bodySent = true;
      trace.response = terminalLocationResponse(input, store, response, beforeOverride);
    }
    if (result.bodySent === true && trace.response === undefined) {
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
 * to apply. It reads one thing of the manifest — the base path, which tells a data request apart
 * (`routedHeaders`) — and reads it without the store, which is built over every route, prerender
 * and file the deployment has: the middleware Function, whose first request that shell waits on,
 * carries only the head of the manifest (`deploymentConfig`).
 */
export async function answerMiddlewareOnly(input: RoutedInput): Promise<Response> {
  const { request } = input;
  const headers = routedHeaders(request, new URL(request.url), deploymentConfig().basePath);
  const response = await runMiddleware(input, new Request(request, { headers }));
  return response ?? new Response(null, { status: HTTP_OK, headers: { 'x-middleware-next': '1' } });
}
