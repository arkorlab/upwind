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

/** Request parses the final URL; a second URL object ahead of it would parse it twice. */
function forwardedUrl(request: Request, ctx: ForwardingContext): string {
  const url = new URL(request.url);
  return `https://${ctx.previewHost}${url.pathname}${url.search}`;
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
  return new Request(forwardedUrl(input.clientRequest, input.ctx), {
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
 * the application's Worker is reached by name, so it is asked on the host it was asked on. It is
 * cancelled with the client's: a visitor who leaves takes the render they no longer wait for with
 * them, where the runtime says so of a request (its `signal`).
 */
export function buildPassthroughRequest(
  clientRequest: Request,
  ctx: ForwardingContext,
  credentials: HostCredentials,
): Request {
  const headers = sanitizePassthroughHeaders(clientRequest.headers, ctx);
  // Fetch establishes a native WebSocket from this header. Other hop-by-hop headers stay out,
  // and continuation requests never carry it: only the client's own passthrough can upgrade.
  if (clientRequest.headers.get('upgrade')?.toLowerCase() === 'websocket') {
    headers.set('upgrade', 'websocket');
  }
  const init: RequestInit & { duplex?: 'half' } = {
    method: clientRequest.method,
    headers: withoutHostCredentials(headers, credentials),
    redirect: 'manual',
    signal: clientRequest.signal,
  };
  if (clientRequest.method !== 'GET' && clientRequest.method !== 'HEAD') {
    init.body = clientRequest.body;
    // Streaming request bodies require half-duplex mode in Fetch.
    init.duplex = 'half';
  }
  return new Request(forwardedUrl(clientRequest, ctx), init);
}
