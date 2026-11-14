import { isLocalAddress } from '@stayingupwind/core/images';
import { dnsSpelling, isUnderAnyDomain } from '@stayingupwind/host/domains';

import type { EdgeContext } from '../strategies/context.ts';

/** How long the edge waits on an origin a middleware rewrote to, matching Next.js's default proxy timeout. */
export const EXTERNAL_REWRITE_TIMEOUT_MS = 30_000;

/** Combine the visitor's cancellation signal with the external rewrite upstream timeout. */
export function externalRewriteSignal(clientSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([clientSignal, AbortSignal.timeout(EXTERNAL_REWRITE_TIMEOUT_MS)]);
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
