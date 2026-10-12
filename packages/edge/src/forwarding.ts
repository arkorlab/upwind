import {
  type ForwardingContext,
  sanitizeContinuationHeaders,
  sanitizePassthroughHeaders,
} from '@stayingupwind/core/request';
import { type HostCredentials, withoutHostCredentials } from '@stayingupwind/host/credentials';

export interface ResumeRequestInput {
  readonly clientRequest: Request;
  readonly ctx: ForwardingContext;
  readonly signal: AbortSignal;
}

/**
 * Build the resume GET for a route of a hosted application: the client's own path and query, so
 * that a class's shell (`/en/[orgSlug]`) resumes for the member the client asked for (`/en/acme`)
 * — the runtime reads the route's parameters off the path — on the host the Worker is asked on,
 * which is the host the client used.
 */
export function buildResumeRequest(
  input: ResumeRequestInput,
  credentials: HostCredentials,
): Request {
  const clientUrl = new URL(input.clientRequest.url);
  const originUrl = new URL(
    `https://${input.ctx.previewHost}${clientUrl.pathname}${clientUrl.search}`,
  );
  return new Request(originUrl.href, {
    headers: withoutHostCredentials(
      sanitizeContinuationHeaders(input.clientRequest.headers, input.ctx),
      credentials,
    ),
    redirect: 'manual',
    signal: input.signal,
  });
}

/**
 * Build a transparent proxy request (any method, streamed body), on the host the client used:
 * the application's Worker is reached by name, so it is asked on the host it was asked on.
 */
export function buildPassthroughRequest(
  clientRequest: Request,
  ctx: ForwardingContext,
  credentials: HostCredentials,
): Request {
  const clientUrl = new URL(clientRequest.url);
  const originUrl = new URL(`https://${ctx.previewHost}${clientUrl.pathname}${clientUrl.search}`);
  const hasBody = clientRequest.method !== 'GET' && clientRequest.method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = {
    method: clientRequest.method,
    headers: withoutHostCredentials(
      sanitizePassthroughHeaders(clientRequest.headers, ctx),
      credentials,
    ),
    redirect: 'manual',
  };
  if (hasBody) {
    init.body = clientRequest.body;
    // Streaming request bodies require half-duplex mode in Fetch.
    init.duplex = 'half';
  }
  return new Request(originUrl.href, init);
}
