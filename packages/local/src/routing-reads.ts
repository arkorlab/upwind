import { isPagesDataRequestPath } from '@stayingupwind/core/bundle';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import {
  dataRequestHeaders,
  EDGE_BYPASS_COOKIE,
  getCookieValue,
  sanitizePassthroughHeaders,
} from '@stayingupwind/core/request';
import {
  CLASSIFIED_HEADER_PREFIXES,
  CLASSIFIED_HEADERS,
  STATIC_CLASSIFIED_HEADERS,
} from '@stayingupwind/edge/internal/classification-credentials.ts';
import { routingReadsFor } from '@stayingupwind/edge/internal/handlers/routing-headers.ts';
import type { HostCredentials } from '@stayingupwind/host/credentials';

import { FRONT_LINE_CODINGS } from './workers/protocol.ts';

/**
 * A request's headers as the edge is handed them — and the rules of `next.config`, the middleware's
 * matchers and the middleware with it — whatever the visitor sent: its `Accept-Encoding` the one
 * Cloudflare's front line sets on every request (`FRONT_LINE_CODINGS`), the visitor's own kept for
 * the edge to answer by alone, as the stack's edge is handed them too (`workers/edge.ts`).
 */
export function edgeReads(headers: Readonly<Record<string, string>> | Headers): Headers {
  const handed = new Headers(headers);
  handed.set('accept-encoding', FRONT_LINE_CODINGS);
  return handed;
}

/**
 * What the edge hands on of a request, exactly (`passthroughHeaders`): the front line's coding, then
 * the shared forwarder's Via, internal-header and recovery-cookie handling — which takes `Host` off
 * with the rest it does not hand on. The standalone host owns no credentials. Only request headers
 * supply clientIp here; runtime.cf country is not fabricated. What the middleware is handed, as the
 * edge reads its answer against (`readMiddlewareAnswer`).
 */
export function forwardedReads(
  url: URL,
  headers: Readonly<Record<string, string>> | Headers,
): Headers {
  const handed = edgeReads(headers);
  return sanitizePassthroughHeaders(handed, {
    previewDomain: 'invalid',
    previewHost: url.hostname,
    clientIp: handed.get('cf-connecting-ip') ?? undefined,
  });
}

/**
 * `headers` with the `Host` the Function's runtime gives a request that reaches it without one —
 * the host of the URL it is asked under (`edge-invoke.ts`, `node-bridge.ts` in the runtime) — before
 * Next.js routes it: forwarding takes it off, and a rule asking of it is answered there as every
 * request carries it (greptile).
 */
function withHostRestored(url: URL, headers: Headers): Headers {
  if (!headers.has('host')) {
    headers.set('host', url.host);
  }
  return headers;
}

/**
 * The standalone application's pre-middleware routing view, as Next.js routes a request: what the
 * edge hands on (`forwardedReads`), with the `Host` the Function's runtime gives it back
 * (`withHostRestored`). Keep this apart from raw classification and a middleware's
 * already-modified requestHeaders.
 */
export function routedReads(
  url: URL,
  headers: Readonly<Record<string, string>> | Headers,
): Headers {
  return withHostRestored(url, forwardedReads(url, headers));
}

/** The credentials the stack's standalone host keeps for itself: none. */
const NO_CREDENTIALS: HostCredentials = { cookies: [], headers: [] };

/**
 * Whether the edge's classification reads the header `name` as the visitor sent it, whatever
 * forwarding hands on (`keptForClassification` in the edge): one it reads by name itself — a
 * router's, a navigation's, an internal one it turns a request away for — but `x-real-ip`; and the
 * `cookie` header where it carries the edge's own recovery cookie.
 *
 * And `host`, which the check holds as sent where the edge's classification takes it off with the
 * rest of what forwarding does not hand on: the Function's runtime gives a request its `Host` back
 * from its URL before Next.js routes it (`edge-invoke.ts`, `node-bridge.ts` in the runtime), so a
 * rule asking of it is answered there as every request carries it.
 */
function keptForClassification(name: string, headers: Headers): boolean {
  if (name === 'cookie') {
    return getCookieValue(headers.get('cookie'), EDGE_BYPASS_COOKIE) !== undefined;
  }
  return (
    name === 'host' ||
    (name !== 'x-real-ip' &&
      (CLASSIFIED_HEADERS.has(name) || STATIC_CLASSIFIED_HEADERS.has(name))) ||
    CLASSIFIED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * A request's headers as the edge classifies it before any middleware runs (`headersToClassify`):
 * which route it is, whether a rule ahead of the filesystem claims it, whether a route's `bypassFor`
 * holds. As the visitor sent them (`edgeReads`), but for each forwarding field a routing condition
 * of the manifest reads (`routingReadsFor`), which takes the value forwarding hands on
 * (`routedReads`, Codex) — the edge's own `Via` among them — unless the classification reads that
 * field by name for itself (`keptForClassification`).
 */
export function classifiedReads(
  manifest: ProjectManifest,
  url: URL,
  headers: Readonly<Record<string, string>> | Headers,
): Headers {
  const sent = edgeReads(headers);
  const { forwardedFields } = routingReadsFor(manifest, NO_CREDENTIALS);
  const moved = forwardedFields.filter((name) => !keptForClassification(name, sent));
  if (moved.length === 0) {
    return sent;
  }
  const forwarded = routedReads(url, headers);
  for (const name of moved) {
    const value = forwarded.get(name);
    if (value === null) {
      sent.delete(name);
    } else {
      sent.set(name, value);
    }
  }
  return sent;
}

/**
 * The headers the middleware left on a request as the edge hands them on, and routes them by behind
 * it (`handedHeaders`): the shared forwarder's handling, under what the request as sent was
 * forwarded with (`routedReads`) — not the front line's coding again, which the middleware was
 * handed already — and the `Host` the Function's runtime gives it back, as Next.js routes it
 * (`withHostRestored`).
 */
export function handedReads(
  url: URL,
  sent: Readonly<Record<string, string>> | Headers,
  left: Headers,
): Headers {
  return withHostRestored(
    url,
    sanitizePassthroughHeaders(left, {
      previewDomain: 'invalid',
      previewHost: url.hostname,
      clientIp: edgeReads(sent).get('cf-connecting-ip') ?? undefined,
    }),
  );
}

/** The middleware's matcher view, including the data marker Next.js sets before matching. */
export function middlewareReads(
  manifest: Pick<ProjectManifest, 'pagesDataBasePath'>,
  url: URL,
  headers: Readonly<Record<string, string>> | Headers,
): Headers {
  const handed = routedReads(url, headers);
  return isPagesDataRequestPath(manifest.pagesDataBasePath ?? '', url.pathname)
    ? dataRequestHeaders(handed)
    : handed;
}
