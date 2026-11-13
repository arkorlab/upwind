import { LOG_CORRELATION_HEADER } from '@stayingupwind/core/paas';
import { type ForwardingContext, VALIDATION_HEADER } from '@stayingupwind/core/request';

import type { AssetOutcome } from './handlers/asset.ts';

/** What the edge knows about a request before any handler looks at it. */

export type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/** The original request owns this value, including when routing rebuilds its forwarding context. */
const LOG_CORRELATION = Symbol.for('@stayingupwind/edge/log-correlation');

/** Materialize one ingress-owned UUID, reused when routing rebuilds its forwarding context. */
function logCorrelationFor(request: IncomingRequest): string {
  const original = request as IncomingRequest & { [LOG_CORRELATION]?: string };
  const existing = original[LOG_CORRELATION];
  if (existing !== undefined) return existing;
  const id = crypto.randomUUID();
  original[LOG_CORRELATION] = id;
  return id;
}

/**
 * Only an actual dispatch reads the lazy id. Matcher evaluation, cache keys and static answers do
 * not mint one or see it in their headers. A new forwarding context still reads the original
 * request's value, rather than the request a middleware rewrote or a retry cloned.
 */
export function stampLogCorrelation(request: Request, read?: () => string): void {
  const id = read?.();
  if (id === undefined) request.headers.delete(LOG_CORRELATION_HEADER);
  else request.headers.set(LOG_CORRELATION_HEADER, id);
}

export function coloOf(request: Pick<IncomingRequest, 'cf'>): string | undefined {
  return request.cf?.colo;
}

/**
 * Bot Management's verdict, where the zone has it. The generated type declares `botManagement`
 * as always present — it is the Enterprise shape — while a zone without the product has no such
 * field at all, so it is read as the optional thing it is.
 */
export function verifiedBotOf(request: Pick<IncomingRequest, 'cf'>): boolean {
  const cf = request.cf as { botManagement?: { verifiedBot?: boolean } } | undefined;
  return cf?.botManagement?.verifiedBot === true;
}

/** Capture trusted forwarding facts and defer identity generation until a hosted dispatch. */
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
    logCorrelationId: () => logCorrelationFor(request),
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
