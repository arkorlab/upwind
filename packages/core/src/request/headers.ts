import { IP_COUNTRY_HEADER } from '../paas/protocol.ts';
import {
  CONTINUATION_ACCEPT,
  EDGE_BYPASS_COOKIE,
  HOP_BY_HOP_HEADERS,
  INTERNAL_REQUEST_HEADER_PREFIXES,
  INTERNAL_REQUEST_HEADERS,
  MIDDLEWARE_PREFETCH_HEADER,
  PASSTHROUGH_RESPONSE_HEADER_DENYLIST,
  PLATFORM_HEADER_PREFIX,
  RESPONSE_HEADER_DENY_PREFIXES,
  RESPONSE_HEADER_DENYLIST,
  ROUTER_PROTOCOL_HEADERS,
  SHELL_RESPONSE_HEADER_ALLOWLIST,
  STORED_RESPONSE_HEADER_DENY_PREFIXES,
  STORED_RESPONSE_HEADER_DENYLIST,
} from './constants.ts';
import { type CookieHostContext, rewriteSetCookieForPreview, stripCookies } from './cookies.ts';

export interface ForwardingContext extends CookieHostContext {
  /** Real client IP as observed by the platform (e.g. `cf-connecting-ip`). */
  readonly clientIp: string | undefined;
  /** The client's country as the platform observed it; forwarded to a hosted app's runtime. */
  readonly clientCountry?: string | undefined;
}

function isInternalRequestHeader(name: string): boolean {
  if (HOP_BY_HOP_HEADERS.includes(name) || INTERNAL_REQUEST_HEADERS.includes(name)) {
    return true;
  }
  return (
    name !== MIDDLEWARE_PREFETCH_HEADER &&
    INTERNAL_REQUEST_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function baseSanitized(headers: Headers, ctx: ForwardingContext): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (isInternalRequestHeader(name)) {
      continue;
    }
    out.append(name, value);
  }
  out.set('x-forwarded-host', ctx.previewHost);
  out.set('x-forwarded-proto', 'https');
  if (ctx.clientIp !== undefined) {
    out.set('x-forwarded-for', ctx.clientIp);
  }
  if (ctx.clientCountry !== undefined) {
    out.set(IP_COUNTRY_HEADER, ctx.clientCountry);
  }
  out.set('via', '1.1 arkor-edge');
  const cookie = stripCookies(out.get('cookie'), [EDGE_BYPASS_COOKIE]);
  if (cookie === null) {
    out.delete('cookie');
  } else {
    out.set('cookie', cookie);
  }
  return out;
}

/**
 * Headers for the continuation GET. The router protocol headers are dropped (this is a document
 * request), encoding is forced to identity so byte offsets are meaningful, and conditional/range
 * headers are removed because the edge already committed to a 200 with the full shell.
 */
export function sanitizeContinuationHeaders(headers: Headers, ctx: ForwardingContext): Headers {
  const out = baseSanitized(headers, ctx);
  for (const name of ROUTER_PROTOCOL_HEADERS) {
    out.delete(name);
  }
  for (const name of [
    'range',
    'if-none-match',
    'if-modified-since',
    'if-match',
    'if-range',
    'if-unmodified-since',
    'content-length',
    'content-type',
  ]) {
    out.delete(name);
  }
  out.set('accept', CONTINUATION_ACCEPT);
  out.set('accept-encoding', 'identity');
  return out;
}

/**
 * Headers for transparent proxying. The client's router protocol headers, conditional headers,
 * range and encoding preferences survive; only platform-internal headers are removed.
 *
 * Nothing about the host is translated: an application's Function is reached by name and asked on
 * the host the client used — a customer's own hostname included — so what it sees is what the
 * client sent, and its own `Origin`/`Host` check is the one that decides.
 */
export function sanitizePassthroughHeaders(headers: Headers, ctx: ForwardingContext): Headers {
  return baseSanitized(headers, ctx);
}

/** Keep only headers that are safe to replay with an edge-served shell. */
export function filterShellResponseHeaders(
  headers: Iterable<[string, string]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    if (!SHELL_RESPONSE_HEADER_ALLOWLIST.includes(name)) {
      continue;
    }
    if (RESPONSE_HEADER_DENYLIST.includes(name)) {
      continue;
    }
    if (RESPONSE_HEADER_DENY_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

/**
 * Keep what a response stored whole may be replayed with: everything it was answered with but
 * what no stored response is (`STORED_RESPONSE_HEADER_DENYLIST`). An allowlist is a shell's, whose
 * headers go out ahead of a resume that may disagree with them; a response replayed whole says
 * again only what it said, so its own headers are the answer — a download's disposition, its
 * CORS grants, the `Location` of a redirect, whatever the application named for itself.
 *
 * A header its `Connection` names belonged to the one transmission as much as `Connection` did:
 * an intermediary removes it before forwarding (RFC 9110 §7.6.1), and a cache may before storage
 * (RFC 9111 §3.1).
 */
export function filterStoredResponseHeaders(
  headers: Iterable<[string, string]>,
): Record<string, string> {
  const answered = [...headers];
  const connectionOptions = new Set(
    answered
      .filter(([name]) => name.toLowerCase() === 'connection')
      .flatMap(([, value]) => value.split(',').map((option) => option.trim().toLowerCase())),
  );
  const out: Record<string, string> = {};
  for (const [rawName, value] of answered) {
    const name = rawName.toLowerCase();
    if (
      STORED_RESPONSE_HEADER_DENYLIST.includes(name) ||
      connectionOptions.has(name) ||
      STORED_RESPONSE_HEADER_DENY_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

export type PassthroughResponseContext = CookieHostContext;

/**
 * A header a proxied response does not keep: the denylist, and the platform's own. A runtime
 * reports to the edge on its response (what a regeneration came to); that is the edge's to read
 * and remove, never a client's to see.
 */
function hiddenFromPassthrough(name: string): boolean {
  return (
    PASSTHROUGH_RESPONSE_HEADER_DENYLIST.includes(name) || name.startsWith(PLATFORM_HEADER_PREFIX)
  );
}

/**
 * Copy proxied response headers, dropping the ones a proxy may not replay and scoping cookies to
 * the host the client used.
 *
 * A redirect is left exactly as the application wrote it: its Function was asked on that same host,
 * so a `Location` naming the origin already names the host the client is on.
 */
export function rewritePassthroughResponseHeaders(
  headers: Headers,
  ctx: PassthroughResponseContext,
): Headers {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (hiddenFromPassthrough(name)) {
      continue;
    }
    if (name === 'set-cookie') {
      out.append(name, rewriteSetCookieForPreview(value, ctx));
      continue;
    }
    out.append(name, value);
  }
  return out;
}

const INLINE_DISPOSITION = 'inline';

/**
 * Whether `content-disposition` says to render the document, which is the one value worth dropping.
 *
 * Presence is not the question: `inline` is the header's default meaning and Next.js emits it on
 * ordinary pages — nextjs.org itself does. Dropping it changes nothing, because rendering a
 * document inline is what a document response already says.
 *
 * Everything else is left with the origin. `attachment` is a download, and a disposition this does
 * not recognise is not something to guess about with a page the edge would then serve as a
 * document — including an empty one.
 */
export function rendersInline(value: string): boolean {
  return (value.split(';', 1)[0] ?? '').trim().toLowerCase() === INLINE_DISPOSITION;
}
