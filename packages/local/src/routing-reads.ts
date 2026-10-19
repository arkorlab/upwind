import { isPagesDataRequestPath } from '@stayingupwind/core/bundle';
import type { ProjectManifest } from '@stayingupwind/core/manifest';
import { dataRequestHeaders, sanitizePassthroughHeaders } from '@stayingupwind/core/request';

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
 * The standalone application's pre-middleware routing view: the front line's coding, then the
 * shared forwarder's Via, internal-header and recovery-cookie handling. The standalone host owns
 * no credentials. Only request headers supply clientIp here; runtime.cf country is not fabricated.
 * Keep this apart from raw classification and a middleware's already-modified requestHeaders.
 */
export function routedReads(
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
