import { releaseStream, withDeadline } from '@stayingupwind/core/util';

/** A cache hit nobody is waiting for has no reader left to release its body. */
export async function releaseLateImage(
  lookup: Promise<Response | undefined> | undefined,
): Promise<void> {
  const late = await lookup;
  releaseStream(late?.body, 'an image cache hit that came too late');
}

/** A source read that answered after its wait ended still has no reader for its body. */
export function releaseLateSource(
  pending: Promise<{ readonly body: ReadableStream<Uint8Array> | null | undefined }>,
): void {
  void pending
    .then((response) => {
      releaseStream(response.body, 'image source abandoned');
      return null;
    })
    .catch(() => {
      // A fetch cancelled with its request usually fails instead of answering.
    });
}

/** The image's bytes, and how the edge ends them without waiting for another read. */
export interface Cuttable {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cut: (reason: unknown) => void;
}

/**
 * The source as the service is handed it: read only as the service reads it, and cut on the edge's
 * word — or the client's departure — at once, whatever either was in the middle of. A pipe would
 * not do: its abort waits for a chunk it has read to be written, which a service that stopped
 * reading never takes, and the source is never let go.
 */
export function cuttable(source: ReadableStream<Uint8Array>, signal?: AbortSignal): Cuttable {
  const reader = source.getReader();
  let ended = false;
  let input: ReadableStreamDefaultController<Uint8Array> | undefined;
  function finish(): void {
    ended = true;
    signal?.removeEventListener('abort', abandon);
  }
  function cut(reason: unknown): void {
    if (ended) {
      return;
    }
    finish();
    input?.error(reason);
    releaseStream(reader, reason instanceof Error ? reason.message : String(reason));
  }
  function abandon(): void {
    cut(signal?.reason);
  }
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        input = controller;
        if (signal?.aborted === true) {
          abandon();
        } else {
          signal?.addEventListener('abort', abandon, { once: true });
        }
      },
      async pull(controller) {
        let read: ReadableStreamReadResult<Uint8Array>;
        try {
          read = await reader.read();
        } catch (error) {
          finish();
          throw error;
        }
        if (ended) {
          return;
        }
        if (read.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(read.value);
        }
      },
      cancel(reason: unknown) {
        finish();
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, cut };
}

/** A wait the client still wants, with its listener removed however that wait ends. */
export async function imageWithin<T>(
  pending: Promise<T>,
  signal: AbortSignal,
  budgetMs: number,
  what: string,
): Promise<T> {
  let abandon: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abandon = () => {
      // DOM §3.3 requires the abort reason itself, including a non-Error value.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason);
    };
    if (signal.aborted) {
      abandon();
    } else {
      signal.addEventListener('abort', abandon, { once: true });
    }
  });
  try {
    return await withDeadline(Promise.race([pending, cancelled]), budgetMs, what);
  } finally {
    if (abandon !== undefined) {
      signal.removeEventListener('abort', abandon);
    }
  }
}
