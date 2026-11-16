import { isLocalAddress } from '@stayingupwind/core/images';
import { PLATFORM_REQUEST_HEADERS } from '@stayingupwind/core/paas';
import { HOP_BY_HOP_HEADERS, PLATFORM_HEADER_PREFIX } from '@stayingupwind/core/request';
import { dnsSpelling, isUnderAnyDomain } from '@stayingupwind/host/domains';

import type { EdgeContext } from '../strategies/context.ts';
import { nominatedBy } from './responses.ts';

/** How long the edge waits on an origin's response headers on an external rewrite, matching Next.js's default proxy timeout. */
export const EXTERNAL_REWRITE_TIMEOUT_MS = 30_000;

const FORWARDED_HOST_HEADER = 'x-forwarded-host';

/**
 * What of a request is never another origin's: the edge's own headers (`PLATFORM_HEADER_PREFIX`, the
 * runtime's `PLATFORM_REQUEST_HEADERS` among them), what belongs to one connection alone
 * (`HOP_BY_HOP_HEADERS`, and whatever the request's `Connection` names, `nominatedBy`), and the
 * site's hostname, which the target's URL replaces.
 */
function notForAnotherOrigin(name: string): boolean {
  return (
    name === 'host' ||
    HOP_BY_HOP_HEADERS.includes(name) ||
    PLATFORM_REQUEST_HEADERS.includes(name) ||
    name.startsWith(PLATFORM_HEADER_PREFIX)
  );
}

/**
 * Forwarded request headers for an external rewrite: what the middleware left on the request,
 * minus hop-by-hop and edge-internal fields (`notForAnotherOrigin`), with `x-forwarded-host`
 * naming `previewHost` as Next.js's proxy sets it.
 */
export function externalRewriteHeaders(requestHeaders: Headers, previewHost: string): Headers {
  const headers = new Headers();
  const nominated = nominatedBy(requestHeaders);
  for (const [name, value] of requestHeaders) {
    if (!notForAnotherOrigin(name) && nominated?.has(name) !== true) {
      headers.append(name, value);
    }
  }
  headers.set(FORWARDED_HOST_HEADER, previewHost);
  return headers;
}

/**
 * Whether an external rewrite's target must be refused before fetching: off HTTP(S), a local or
 * special-purpose address (`isLocalAddress`), or a hostname this deployment or its host answers on
 * itself (`ownDomains`, `ownHostnames`, `previewHost`, or the request's own hostname), however
 * spelled in DNS (case or trailing root dot).
 */
export function externalRewriteRefused(target: URL, request: Request, edge: EdgeContext): boolean {
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return true;
  }
  if (isLocalAddress(target.hostname)) {
    return true;
  }
  const hostname = dnsSpelling(target.hostname);
  return (
    isUnderAnyDomain(hostname, edge.host.ownDomains) ||
    edge.host.ownHostnames?.some((own) => dnsSpelling(own) === hostname) === true ||
    hostname === dnsSpelling(edge.forwarding.previewHost) ||
    hostname === dnsSpelling(new URL(request.url).hostname)
  );
}
