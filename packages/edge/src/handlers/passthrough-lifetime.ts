import { classifyRequest } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

/**
 * How long a passthrough is kept going once its client has gone. Only a Server Action outlives its
 * client, held through the invalidation receipt its answer carries; any other request, a streaming
 * Route Handler's or a Pages API's, is cancelled with the client as before.
 */

/** What a form is sent as, which Next.js takes for a possible Action without `next-action`. */
const FORM_URLENCODED = 'application/x-www-form-urlencoded';
const FORM_MULTIPART = 'multipart/form-data';

/**
 * Whether a passthrough is dispatched on a signal of its own rather than the client's: a POST that
 * may be an Action by the headers forwarded after the middleware, not already aborted on arrival.
 */
export function outlivesClient(request: Request, headers: Headers): boolean {
  return (
    request.method === 'POST' &&
    (sentByForm(headers) ||
      classifyRequest({
        method: request.method,
        url: new URL(request.url),
        headers,
        manifest: undefined,
        deployment: undefined,
      }).kind === 'action') &&
    !request.signal.aborted
  );
}

/**
 * Whether a POST is a form the browser navigated with, which Next.js takes for a possible Action as
 * the runtime does (`getIsPossibleServerAction`): a form submitted before hydration, or without
 * JavaScript, names its Action in its body and sends no `next-action` header (greptile). A script's
 * form POST is no navigation, and stays cancelled with its client as any other request is (greptile).
 */
function sentByForm(headers: Headers): boolean {
  const type = headers.get('content-type');
  return (
    headers.get('sec-fetch-mode') === 'navigate' &&
    (type === FORM_URLENCODED || (type?.startsWith(FORM_MULTIPART) ?? false))
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
