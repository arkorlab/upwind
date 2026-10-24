import { classifyRequest } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

/**
 * How long a passthrough is kept going once its client has gone. Only a Server Action outlives its
 * client, held through the invalidation receipt its answer carries; any other request, a streaming
 * Route Handler's or a Pages API's, is cancelled with the client as before.
 */

/**
 * How long a detached Action is still held once its client has gone: long enough for an Action's
 * answer, and a bound on the work a caller can leave behind by sending what an Action sends and
 * leaving, since nothing a request carries proves it is one (Codex).
 */
export const DETACHED_ACTION_LIMIT_MS = 30_000;

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

/** The signal a detached Action is dispatched on, and what to do once its answer is in. */
export interface DetachedLifetime {
  readonly signal: AbortSignal;
  readonly answered: () => void;
}

/**
 * A signal of the dispatch's own. Until the answer's headers are in, the client's leaving does not
 * abort it, but the dispatch is aborted `DETACHED_ACTION_LIMIT_MS` after the client has gone.
 * Once they are in (`answered`), the receipt they carry has been taken, so the dispatch goes with
 * its client again: at once where the client has already gone, else as soon as it goes, so that a
 * body still streaming is not left running behind it (Codex).
 */
export function detachedLifetime(client: AbortSignal): DetachedLifetime {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const left = (): void => {
    timer = setTimeout(() => {
      controller.abort(new DOMException('a detached Action outlived its limit', 'TimeoutError'));
    }, DETACHED_ACTION_LIMIT_MS);
  };
  const follow = (): void => {
    controller.abort(client.reason);
  };
  client.addEventListener('abort', left, { once: true });
  return {
    signal: controller.signal,
    answered: () => {
      client.removeEventListener('abort', left);
      if (timer !== undefined) clearTimeout(timer);
      if (client.aborted) follow();
      else client.addEventListener('abort', follow, { once: true });
    },
  };
}

/** Retain the receipt continuation, not an arbitrary response stream or a rejection. */
export async function mutationSettled(
  answer: Promise<Response>,
  client: Request,
  lifetime: DetachedLifetime,
): Promise<void> {
  try {
    const response = await answer;
    if (client.signal.aborted) releaseStream(response.body, 'mutation client disconnected');
  } catch {
    // The caller still observes the same answer or failure; background retention never rejects.
  } finally {
    lifetime.answered();
  }
}
