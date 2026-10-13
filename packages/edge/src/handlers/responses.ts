import { mergeMiddlewareResponseHeaders } from '@stayingupwind/core/paas';
import {
  EDGE_DEBUG_HEADER,
  NO_STORE_CACHE_CONTROL,
  type PassthroughResponseContext,
  PLATFORM_HEADER_PREFIX,
  rewriteSetCookieForPreview,
  SHARED_CACHE_CONTROL_HEADERS,
} from '@stayingupwind/core/request';

const NOT_FOUND_STATUS = 404;
const CACHE_CONTROL_HEADER = 'cache-control';
const S_MAXAGE_DIRECTIVE = 's-maxage';
const PRIVATE_DIRECTIVE = 'private';
const NO_STORE_DIRECTIVE = 'no-store';
const PUBLIC_DIRECTIVE = 'public';
const BAD_GATEWAY_STATUS = 502;
export const SERVICE_UNAVAILABLE_STATUS = 503;

/** A page of the edge's own, kept by no cache, with the debug header saying why it was sent. */
export function html(body: string, status: number, debug: string): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': NO_STORE_CACHE_CONTROL,
      [EDGE_DEBUG_HEADER]: debug,
    },
  });
}

function directiveName(part: string): string {
  return part.split('=', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * The directives of a `Cache-Control` value, parted at the commas outside quoted strings
 * (RFC 9110 §5.6.1, §5.6.4): `private="Set-Cookie, X-Id"` is one directive, not two.
 */
function cacheDirectives(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (quoted && char === '\\') {
      // A quoted pair: the character after it is the string's, a quote or a comma included.
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * `private` naming no field: the whole response one visitor's. One naming fields
 * (`private="Set-Cookie"`) keeps only those from a shared cache, which may store the rest
 * (RFC 9111 §5.2.2.7), so it is not the privacy this asks for.
 */
function isBarePrivate(part: string): boolean {
  return part.toLowerCase() === PRIVATE_DIRECTIVE;
}

const SET_COOKIE_HEADER = 'set-cookie';

/**
 * Merge what a middleware answered with into a response, its cookies scoped as a Function's are
 * (`rewritePassthroughResponseHeaders`): on a host under the shared domain, a `Domain` that would
 * hand a cookie to every other site under it is taken off. And none of the edge's own headers is
 * a middleware's to set.
 *
 * Scoped where they are merged, not where the middleware answered: the splice compares what a
 * resume writes back with the cookies the middleware handed the render, as the render was given
 * them (`sentCookies`).
 */
export function mergeScopedMiddlewareHeaders(
  target: Headers,
  added: Headers,
  scope: PassthroughResponseContext,
): void {
  const scoped = new Headers();
  for (const [name, value] of added) {
    if (name.startsWith(PLATFORM_HEADER_PREFIX)) {
      continue;
    }
    scoped.append(
      name,
      name === SET_COOKIE_HEADER ? rewriteSetCookieForPreview(value, scope) : value,
    );
  }
  mergeMiddlewareResponseHeaders(target, scoped);
}

/** Upstream CDN directives must not override the edge's admission or privacy decision. */
export function removeSharedCacheOverrides(headers: Headers): void {
  for (const name of SHARED_CACHE_CONTROL_HEADERS) {
    headers.delete(name);
  }
}

/**
 * Keep a response from everybody, the browser included: what a project whose delivery is private
 * (`privateDelivery`) answers with, however the application said it may be kept. A browser could
 * otherwise hand it back without the host being asked — to a visitor it no longer lets through.
 */
export function keptByNobody(headers: Headers): void {
  removeSharedCacheOverrides(headers);
  headers.set(CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL);
}

/**
 * Make a proxied response unstorable by a shared cache, leaving the browser's own caching intact.
 *
 * Passthrough responses have not passed immutable asset admission, so no shared cache may hold an
 * independent copy of one. `private` applies that decision to every shared cache. Upstream
 * CDN-specific headers have higher precedence than Cache-Control and are removed first, along
 * with `s-maxage` and `public`. The browser's own caching directives survive intact.
 *
 * Admitted immutable assets do not come through here. They are content-addressed and vary on
 * nothing, which is what makes the edge's own named cache safe to hold them in.
 */
export function privateCacheControl(headers: Headers): void {
  removeSharedCacheOverrides(headers);
  const raw = headers.get(CACHE_CONTROL_HEADER);
  if (raw === null) {
    headers.set(CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL);
    return;
  }
  // `s-maxage` is for the shared caches that are to keep nothing of this, and a `private` naming
  // fields would let them keep the rest: both go, the latter for a bare `private`.
  const kept = cacheDirectives(raw).filter((part) => {
    const name = directiveName(part);
    return name !== S_MAXAGE_DIRECTIVE && (name !== PRIVATE_DIRECTIVE || isBarePrivate(part));
  });
  const unshared = kept.some(
    (part) => isBarePrivate(part) || directiveName(part) === NO_STORE_DIRECTIVE,
  );
  if (unshared) {
    headers.set(CACHE_CONTROL_HEADER, kept.join(', '));
    return;
  }
  const shareable = kept.filter((part) => directiveName(part) !== PUBLIC_DIRECTIVE);
  headers.set(CACHE_CONTROL_HEADER, [PRIVATE_DIRECTIVE, ...shareable].join(', '));
}

export function notFoundResponse(reason: string): Response {
  return html(
    '<!doctype html><title>Not found</title><h1>Not found</h1>',
    NOT_FOUND_STATUS,
    `error;reason=${reason}`,
  );
}

export function badGatewayResponse(reason: string): Response {
  return html(
    '<!doctype html><title>Upstream error</title><h1>The application could not be reached</h1>',
    BAD_GATEWAY_STATUS,
    `error;reason=${reason}`,
  );
}

/** The edge could not read its own state for this request (not an origin problem). */
export function serviceUnavailableResponse(reason: string): Response {
  return html(
    '<!doctype html><title>Temporarily unavailable</title><h1>Please retry shortly</h1>',
    SERVICE_UNAVAILABLE_STATUS,
    `error;reason=${reason}`,
  );
}
