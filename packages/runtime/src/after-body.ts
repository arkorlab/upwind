import { AsyncLocalStorage } from 'node:async_hooks';

import { copyBuildPublication } from './publication.ts';

/**
 * Once the response is done with, do this, once: the visitor's bytes come first. Done with is sent
 * in full, or given up by the client. A client cancels prefetches as a matter of course — every
 * one a navigation overtakes — and a regeneration begun only once the body had been read to its
 * end was never begun behind one that was cancelled: an entry only ever prefetched stayed stale,
 * or expired, and each expired prefetch paid for a render of its own every time.
 */
export function afterBody(response: Response, then: () => void): Response {
  return onceRead(response, 'end', then);
}

/**
 * Do this, once, as soon as whatever reads the response — the runtime writing it out, or a stream
 * it passes through on the way — has taken its first bytes, rather than once it is done with: what
 * `then` begins is never in front of those bytes, and does not wait behind the rest of them. A body
 * done with before it gave any — empty, failed, or given up by the client — has it done then, as
 * `afterBody` would.
 */
export function afterFirstBytes(response: Response, then: () => void): Response {
  return onceRead(response, 'first bytes', then);
}

/** How far the body has been read when the work is begun. */
type Moment = 'end' | 'first bytes';

function onceRead(response: Response, moment: Moment, then: () => void): Response {
  const { body } = response;
  if (body === null) {
    then();
    return response;
  }
  // Run in the request's context, whoever reads the body: the runtime writing the response out
  // reads it from outside the request, and a regeneration begun from that read ran outside it too
  // — under workerd its generation was stamped with the wall clock rather than the request's.
  const later = AsyncLocalStorage.bind(then);
  const early = moment === 'first bytes';
  let done = false;
  const once = (): void => {
    if (!done) {
      done = true;
      later();
    }
  };
  const reader = body.getReader();
  const through = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (error) {
          // A body that fails part way has still been sent all it will be: the entry is as stale as
          // it was, and its regeneration no less due.
          once();
          throw error;
        }
        if (read.done) {
          controller.close();
          once();
          return;
        }
        controller.enqueue(read.value);
        if (early && read.value.byteLength > 0) {
          once();
        }
      },
      cancel(reason) {
        once();
        return reader.cancel(reason);
      },
    },
    // Where the work waits for the first bytes, read only as the reader asks: a chunk read ahead
    // into this stream's own queue as the response is made — before it was even handed on — is one
    // nobody has taken, and its bytes are on their way nowhere yet.
    { highWaterMark: early ? 0 : 1 },
  );
  return copyBuildPublication(response, new Response(through, response));
}
