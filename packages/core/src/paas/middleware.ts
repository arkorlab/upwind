import type { MiddlewareMatcher } from '../manifest/schema.ts';
import { conditionsHold } from '../request/conditions.ts';

/**
 * The middleware protocol as Next.js speaks it over HTTP, for the edge to read a middleware Worker's
 * answer without a Node runtime. The same reading `@next/routing` makes inside the application's
 * Worker; kept apart so the edge carries none of that package.
 */

const NEXT_HEADER = 'x-middleware-next';
const REWRITE_HEADER = 'x-middleware-rewrite';
const OVERRIDE_HEADERS_HEADER = 'x-middleware-override-headers';
const REQUEST_HEADER_PREFIX = 'x-middleware-request-';
const SET_COOKIE_HEADER = 'set-cookie';
/** Middleware-protocol headers that never reach a client. */
const PROTOCOL_HEADERS: ReadonlySet<string> = new Set([
  'content-length',
  NEXT_HEADER,
  OVERRIDE_HEADERS_HEADER,
  REWRITE_HEADER,
  'x-middleware-redirect',
  'x-middleware-refresh',
  'x-middleware-set-cookie',
]);
/**
 * What a middleware may not add to a response the edge composed: the body is the edge's, and so is
 * how it is encoded, framed and cached.
 */
const UNMERGEABLE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'cache-control',
  'connection',
  'content-encoding',
  'content-length',
  'content-type',
  'transfer-encoding',
]);

export type MiddlewareResult =
  /** The middleware answered the request itself: a redirect, or a whole response. */
  | { readonly kind: 'responded'; readonly response: Response }
  /**
   * The request goes on, as the middleware left it: to `url` (the request's own, or a rewrite of
   * it on the same origin), with `requestHeaders` for whoever handles it and `responseHeaders`
   * added to whatever answer comes back.
   */
  | {
      readonly kind: 'continue';
      readonly url: URL;
      readonly rewritten: boolean;
      readonly requestHeaders: Headers;
      readonly responseHeaders: Headers;
    }
  /** A rewrite to another origin: fetched from there, as the request the middleware left. */
  | {
      readonly kind: 'external-rewrite';
      readonly url: URL;
      readonly requestHeaders: Headers;
      readonly responseHeaders: Headers;
    };

/**
 * Replace the request headers the middleware chose to. `x-middleware-override-headers` lists every
 * header the request is to carry afterwards; each is taken from `x-middleware-request-<name>`, and
 * a header on the request that the list does not name is dropped.
 */
function applyRequestOverrides(response: Response, requestHeaders: Headers): Headers {
  const listed = response.headers.get(OVERRIDE_HEADERS_HEADER);
  if (listed === null) {
    return new Headers(requestHeaders);
  }
  const names = new Set(
    listed
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name !== ''),
  );
  const out = new Headers();
  for (const name of names) {
    const value = response.headers.get(`${REQUEST_HEADER_PREFIX}${name}`);
    if (value !== null) {
      out.set(name, value);
    }
  }
  return out;
}

function responseHeadersOf(response: Response): Headers {
  const out = new Headers();
  for (const [name, value] of response.headers) {
    if (PROTOCOL_HEADERS.has(name) || name.startsWith(REQUEST_HEADER_PREFIX)) {
      continue;
    }
    out.append(name, value);
  }
  return out;
}

/**
 * Read what a middleware Worker's response asks for.
 *
 * `requestUrl` is the request the middleware was given; a rewrite is resolved against it, and a
 * rewrite that lands on another origin is reported as such rather than followed.
 */
export function readMiddlewareResponse(
  response: Response,
  requestUrl: URL,
  requestHeaders: Headers,
): MiddlewareResult {
  const rewrite = response.headers.get(REWRITE_HEADER);
  const next = response.headers.get(NEXT_HEADER);
  // Neither `x-middleware-next` nor a rewrite: the middleware answered the request itself, and
  // what it answered with is the response — `Location` or not. Next.js marks this one
  // `x-middleware-refresh` and finishes the request with the middleware's own body and status
  // (`server/lib/router-utils/resolve-routes.js`).
  if (rewrite === null && next === null) {
    return { kind: 'responded', response };
  }
  const forwarded = applyRequestOverrides(response, requestHeaders);
  const responseHeaders = responseHeadersOf(response);
  // A rewrite to another origin finishes the request before the `Location` below is read, which is
  // the order Next.js reads them in and therefore the order the edge reads them in.
  const target = rewrite === null ? undefined : new URL(rewrite, requestUrl);
  if (target !== undefined && target.origin !== requestUrl.origin) {
    return { kind: 'external-rewrite', url: target, requestHeaders: forwarded, responseHeaders };
  }
  // A `Location` is the middleware's answer whatever the status: on a redirect status Next.js
  // finishes with the redirect, and on any other status it finishes with the middleware's body and
  // status and passes the header through — only the *redirect* treatment is skipped, never the
  // response. Reading it as `continue` served the document or file underneath in place of a
  // middleware's own 401 or 403 that names a login page.
  if (response.headers.has('location')) {
    return { kind: 'responded', response };
  }
  if (target === undefined) {
    return {
      kind: 'continue',
      url: requestUrl,
      rewritten: false,
      requestHeaders: forwarded,
      responseHeaders,
    };
  }
  return {
    kind: 'continue',
    url: target,
    rewritten: target.pathname !== requestUrl.pathname || target.search !== requestUrl.search,
    requestHeaders: forwarded,
    responseHeaders,
  };
}

/**
 * Whether the application's middleware would run for this request: any matcher whose pattern the
 * pathname matches, and whose `has` conditions all hold and `missing` conditions all fail. The
 * patterns are the ones Next.js compiled for its own router, matched as it matches them.
 */
export function middlewareApplies(
  matchers: readonly MiddlewareMatcher[],
  url: URL,
  headers: Headers,
): boolean {
  return matchers.some((matcher) => {
    // Case-insensitive, as Next.js matches them, and without the unicode flag, as it compiled them.
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp
    if (!new RegExp(matcher.sourceRegex, 'i').test(url.pathname)) {
      return false;
    }
    return conditionsHold(matcher, url, headers);
  });
}

/** The response headers a middleware asked to add, merged onto a response the edge composed. */
export function mergeMiddlewareResponseHeaders(target: Headers, added: Headers): void {
  for (const [name, value] of added) {
    if (UNMERGEABLE_RESPONSE_HEADERS.has(name)) {
      continue;
    }
    if (name === SET_COOKIE_HEADER) {
      target.append(name, value);
    } else {
      target.set(name, value);
    }
  }
}
