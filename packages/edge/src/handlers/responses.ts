import {
  mergeMiddlewareResponseHeaders,
  MIDDLEWARE_SET_COOKIE_HEADER,
  type MiddlewareResult,
  readMiddlewareResponse,
} from '@stayingupwind/core/paas';
import {
  EDGE_DEBUG_HEADER,
  hasRouteBodyControlHeader,
  HOP_BY_HOP_HEADERS,
  NO_STORE_CACHE_CONTROL,
  NULL_BODY_STATUS,
  PASSTHROUGH_RESPONSE_HEADER_DENYLIST,
  type PassthroughResponseContext,
  PLATFORM_HEADER_PREFIX,
  rewriteSetCookieForPreview,
  SHARED_CACHE_CONTROL_HEADERS,
} from '@stayingupwind/core/request';
import { type HostCredentials, withoutHostCredentials } from '@stayingupwind/host/credentials';

const HTTP_OK_STATUS = 200;
const NOT_FOUND_STATUS = 404;
const CACHE_CONTROL_HEADER = 'cache-control';
const S_MAXAGE_DIRECTIVE = 's-maxage';
const PRIVATE_DIRECTIVE = 'private';
const NO_STORE_DIRECTIVE = 'no-store';
const PUBLIC_DIRECTIVE = 'public';
const BAD_GATEWAY_STATUS = 502;
export const SERVICE_UNAVAILABLE_STATUS = 503;
/** Keep visible ASCII except the field delimiter and percent escape marker. */
const UNSAFE_IN_DEBUG = /[^\u{20}-\u{24}\u{26}-\u{3A}\u{3C}-\u{7E}]/gu;

/** One opaque diagnostic field, including strings with lone UTF-16 surrogates. */
export function safeDiagnosticField(value: string): string {
  // JSON also represents lone surrogates, which URI encoding alone refuses.
  return value.replaceAll(UNSAFE_IN_DEBUG, (character) =>
    encodeURIComponent(JSON.stringify(character).slice(1, -1)),
  );
}

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
const CONNECTION_HEADER = 'connection';
const CONTENT_LENGTH_HEADER = 'content-length';

/**
 * The headers a message's `Connection` names: the one hop's as much as `Connection` is, so a proxy
 * removes them with it (RFC 9110 §7.6.1), as a response stored whole loses them
 * (`filterStoredResponseHeaders`). Matched against the message's own names, never handed to
 * `Headers` as names, so an option that is no header's name removes nothing and throws nothing.
 * A deferred rule can add its options without copying Headers. `undefined` without either,
 * which is most.
 */
export function nominatedBy(
  headers: Headers,
  additional?: string,
): ReadonlySet<string> | undefined {
  let connection = headers.get(CONNECTION_HEADER);
  if (additional !== undefined) {
    connection = connection === null ? additional : `${connection},${additional}`;
  }
  return connection === null
    ? undefined
    : new Set(connection.split(',').map((option) => option.trim().toLowerCase()));
}

/** Local middleware control fields, kept through parsing and never sent to a client. */
const MIDDLEWARE_PROTOCOL_HEADERS: ReadonlySet<string> = new Set([
  MIDDLEWARE_SET_COOKIE_HEADER,
  'x-middleware-next',
  'x-middleware-override-headers',
  'x-middleware-redirect',
  'x-middleware-refresh',
  'x-middleware-rewrite',
]);

export function middlewareProtocolHeader(name: string): boolean {
  return MIDDLEWARE_PROTOCOL_HEADERS.has(name) || name.startsWith('x-middleware-request-');
}

/**
 * Decode local control before filtering transport fields: a nominated Location still decides a
 * middleware's own answer. For a continuing answer, the ordinary additions seen by the render and
 * by response decisions must be the same ones the client may receive. Explicit request overrides
 * and the cookie handoff remain local protocol, independently of those ordinary additions.
 * Hosts composing the edge's handlers use this transport boundary rather than core's protocol-only
 * decoder. With no Connection options, the existing parser and its allocations suffice.
 */
export function readMiddlewareAnswer(
  response: Response,
  url: URL,
  client: Headers,
  handed: Headers,
): MiddlewareResult {
  const result = readMiddlewareResponse(response, url, client);
  if (result.kind === 'responded') return result;
  const nominated = nominatedBy(response.headers);
  let transported = response;
  if (nominated !== undefined) {
    transported = new Response(response.body, response);
    for (const [name] of response.headers) {
      if (nominated.has(name) && !middlewareProtocolHeader(name)) {
        transported.headers.delete(name);
      }
    }
    transported.headers.delete(CONNECTION_HEADER);
  }
  if (result.kind === 'external-rewrite') {
    return readMiddlewareResponse(transported, url, handed);
  }
  return transported === response ? result : readMiddlewareResponse(transported, url, client);
}

/**
 * Whether an answer's status lets it say how long it is (RFC 9110 §8.6): no 1xx or 204 does, and a
 * 205 says only that it is empty, which is all a 205 is (§15.3.6). A deferred value is judged
 * in place of the original length, as if the runtime had already applied that rule.
 */
export function statusAllowsLength(response: Response, candidate?: string): boolean {
  const { status } = response;
  if (status < HTTP_OK_STATUS || status === NULL_BODY_STATUS.noContent) {
    return false;
  }
  return (
    status !== NULL_BODY_STATUS.resetContent ||
    (candidate ?? response.headers.get(CONTENT_LENGTH_HEADER)) === '0'
  );
}

/**
 * Copy a forwarded answer with its native transport, including a WebSocket handshake. Filtering
 * the copy's headers avoids constructing another Headers and copying every allowed header twice.
 * Read names from the original: deleting from the iterator's own Headers would skip entries.
 *
 * `method` is that of the request answered. An answer to `HEAD` keeps its `Content-Length`, which
 * the denylist takes off a body the edge streams on, for the runtime to frame by what it streams:
 * such an answer has none, and the length is that of the answer a `GET` would get (RFC 9110
 * §9.3.2), which the runtime hands the client as given — where its status allows a length at all
 * (`statusAllowsLength`).
 */
export function forwardedResponse(
  response: Response,
  scope: PassthroughResponseContext,
  method: string,
): Response {
  const answer = new Response(response.body, response);
  const headers = answer.headers;
  const nominated = nominatedBy(response.headers);
  const kept =
    method === 'HEAD' && statusAllowsLength(response) ? CONTENT_LENGTH_HEADER : undefined;
  headers.delete(SET_COOKIE_HEADER);
  for (const [name, value] of response.headers) {
    if (
      (name !== kept && PASSTHROUGH_RESPONSE_HEADER_DENYLIST.includes(name)) ||
      name.startsWith(PLATFORM_HEADER_PREFIX) ||
      nominated?.has(name) === true
    ) {
      headers.delete(name);
    } else if (name === SET_COOKIE_HEADER) {
      headers.append(name, rewriteSetCookieForPreview(value, scope));
    }
  }
  return answer;
}

/**
 * Merge what a middleware answered with into a response, its cookies scoped as a Function's are
 * (`rewritePassthroughResponseHeaders`): on a host under the shared domain, a `Domain` that would
 * hand a cookie to every other site under it is taken off. And none of the edge's own headers is
 * a middleware's to set.
 *
 * Scoped where they are merged, not where the middleware answered: the splice compares what a
 * resume writes back with the cookies the middleware handed the render, as the render was given
 * them (`sentCookies`).
 * The middleware's `Connection` options exclude only its own additions, not the base answer's.
 * A handler may also reserve fields that describe or protect the representation it produced;
 * middleware cookies and the rest of its ordinary additions retain their existing precedence.
 */
export function mergeScopedMiddlewareHeaders(
  target: Headers,
  added: Headers,
  scope: PassthroughResponseContext,
  excluded?: ReadonlySet<string>,
): void {
  const nominated = nominatedBy(added);
  const scoped = new Headers();
  for (const [name, value] of added) {
    if (
      HOP_BY_HOP_HEADERS.includes(name) ||
      name.startsWith(PLATFORM_HEADER_PREFIX) ||
      nominated?.has(name) === true ||
      excluded?.has(name) === true
    ) {
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
 * Keep a proxied response from shared caches — unless the application said they may keep it —
 * leaving the browser's own caching intact.
 *
 * Passthrough responses have not passed immutable asset admission, so the edge keeps no copy of
 * one, and by default no shared cache may hold one either: `private` applies that to every shared
 * cache. Upstream CDN-specific headers have higher precedence than Cache-Control and are removed
 * first, and `s-maxage` goes with the shared caches it would have let keep the answer. The
 * browser's own caching directives survive intact.
 *
 * An answer whose own `Cache-Control` says `public` keeps it, as Next.js hands it on (decided
 * 2026-10-22): a `getServerSideProps` page's `public, max-age=3600`, an image route's
 * `public, max-age=0, must-revalidate`. A cache between the edge and the browser may then hold a
 * copy that no invalidation reaches, which is what the application asked for — for as long as it
 * said: its `s-maxage` stays, the lifetime it gave shared caches, which past the edge are those.
 * Only where it says so of itself, though (`saidPublic`), and only to a request that is `anonymous`
 * (`anonymousRequest`): one that carried nothing of a visitor's the application could have
 * answered by — no cookie or `Authorization` of its own, none of the Next.js control or
 * router-protocol headers — and was no validation. Nor anything a project whose delivery is
 * private serves (`privateDelivery`), which the callers keep from every cache after this
 * (`keptByNobody`).
 *
 * Admitted immutable assets do not come through here. They are content-addressed and vary on
 * nothing, which is what makes the edge's own named cache safe to hold them in.
 */
export function unsharedUnlessPublic(headers: Headers, anonymous: boolean): void {
  removeSharedCacheOverrides(headers);
  const raw = headers.get(CACHE_CONTROL_HEADER);
  if (raw === null) {
    headers.set(CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL);
    return;
  }
  const directives = cacheDirectives(raw);
  // The application's own word that shared caches may keep it goes out as it said it, `s-maxage`
  // and all: past the edge, which keeps nothing of this, the shared caches are the ones it names.
  if (anonymous && saidPublic(headers, directives)) {
    headers.set(CACHE_CONTROL_HEADER, directives.join(', '));
    return;
  }
  // Anything else is no shared cache's: `s-maxage` goes, and a `private` naming fields, which would
  // let one keep the rest, for a bare `private`.
  const kept = directives.filter((part) => {
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

/**
 * Whether an answer says of itself that a shared cache may keep all of it: a bare `public` — a
 * `public=…` is no directive a cache has to heed — with no `private` naming fields, which says a
 * shared cache is to keep none of those, and no cookie, which makes an answer one visitor's
 * whatever else it says.
 */
function saidPublic(headers: Headers, directives: readonly string[]): boolean {
  return (
    !headers.has(SET_COOKIE_HEADER) &&
    directives.some((part) => part.toLowerCase() === PUBLIC_DIRECTIVE) &&
    directives.every((part) => directiveName(part) !== PRIVATE_DIRECTIVE || isBarePrivate(part))
  );
}

/**
 * Whether a request carried nothing the application could have answered one visitor by, so that
 * what it said of the answer may stand (`unsharedUnlessPublic`): no validation, no cookie or
 * `Authorization` of its own (`carriesApplicationCredentials`), and none of the Next.js control or
 * router-protocol headers an answer is told apart by (`hasRouteBodyControlHeader`) — a navigation's
 * payload is one URL's answer as much as its document is, and a cache that keys by the URL alone
 * would hand either for the other.
 */
export function anonymousRequest(
  headers: Headers,
  credentials: HostCredentials,
  validated: boolean,
): boolean {
  return (
    !validated &&
    !carriesApplicationCredentials(headers, credentials) &&
    !hasRouteBodyControlHeader(headers)
  );
}

/**
 * Whether a request carries what an application could tell one visitor by: a cookie or an
 * `Authorization` of its own, once the host's credentials are taken off (`withoutHostCredentials`).
 */
export function carriesApplicationCredentials(
  headers: Headers,
  credentials: HostCredentials,
): boolean {
  if (!headers.has('cookie') && !headers.has('authorization')) return false;
  const application = withoutHostCredentials(new Headers(headers), credentials);
  return application.has('cookie') || application.has('authorization');
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

/** A conditional response with the full representation's headers, without its body length. */
export function notModifiedResponse(headers: Headers): Response {
  const kept = new Headers(headers);
  kept.delete(CONTENT_LENGTH_HEADER);
  return new Response(null, { status: NULL_BODY_STATUS.notModified, headers: kept });
}
