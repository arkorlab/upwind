import { type ForwardingContext, VALIDATION_HEADER } from '@stayingupwind/core/request';

import type { AssetOutcome } from './handlers/asset.ts';

/** What the edge knows about a request before any handler looks at it. */

export type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

export function coloOf(request: IncomingRequest): string | undefined {
  return request.cf?.colo;
}

/**
 * Bot Management's verdict, where the zone has it. The generated type declares `botManagement`
 * as always present — it is the Enterprise shape — while a zone without the product has no such
 * field at all, so it is read as the optional thing it is.
 */
export function verifiedBotOf(request: IncomingRequest): boolean {
  const cf = request.cf as { botManagement?: { verifiedBot?: boolean } } | undefined;
  return cf?.botManagement?.verifiedBot === true;
}

export function forwardingFor(
  request: IncomingRequest,
  previewDomain: string,
  previewHost: string,
): ForwardingContext {
  return {
    previewDomain,
    previewHost,
    clientIp: request.headers.get('cf-connecting-ip') ?? undefined,
    clientCountry: request.cf?.country,
  };
}

const CREDENTIAL_HEADERS: readonly string[] = ['authorization', 'cookie'];

/** Whether the request carries credentials an anonymous fetch would not. */
export function hasCredentials(headers: Headers): boolean {
  return CREDENTIAL_HEADERS.some((name) => headers.has(name));
}

/** Whether a refused asset response is one this client must not be handed as it stands. */
export function unshareable(request: Request, asset: AssetOutcome): boolean {
  return asset.response.headers.has('set-cookie') || hasCredentials(request.headers);
}

/** Copy of the headers without edge-internal control headers (never forwarded to the origin). */
export function stripEdgeHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete(VALIDATION_HEADER);
  return out;
}
