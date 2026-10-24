import { classifyRequest } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

/**
 * How long a passthrough is kept going once its client has gone. Only a Server Action outlives its
 * client, held through the invalidation receipt its answer carries; any other request, a streaming
 * Route Handler's or a Pages API's, is cancelled with the client as before.
 */

/**
 * Whether a passthrough is dispatched on a signal of its own rather than the client's: a POST the
 * headers forwarded after the middleware classify as an Action, not already aborted on arrival.
 */
export function outlivesClient(request: Request, headers: Headers): boolean {
  return (
    request.method === 'POST' &&
    classifyRequest({
      method: request.method,
      url: new URL(request.url),
      headers,
      manifest: undefined,
      deployment: undefined,
    }).kind === 'action' &&
    !request.signal.aborted
  );
}

/** Retain the receipt continuation, not an arbitrary response stream or a rejection. */
export async function mutationSettled(answer: Promise<Response>, client: Request): Promise<void> {
  try {
    const response = await answer;
    if (client.signal.aborted) releaseStream(response.body, 'mutation client disconnected');
  } catch {
    // The caller still observes the same answer or failure; background retention never rejects.
  }
}
