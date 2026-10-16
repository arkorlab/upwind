import { releaseStream, withDeadline } from '@stayingupwind/core/util';

import type { ImageTransformRequest, TransformImage } from '../edge-runtime.ts';

/** What the service answers a transformation with. */
type Transformed = Awaited<ReturnType<TransformImage>>;

/** What a transformation answers once it is past its budget, let go of unread. */
async function releaseLate(pending: Promise<Transformed>): Promise<void> {
  releaseStream((await pending).body, 'image transformation past its budget');
}

/** The source as the service is handed it, and how the edge ends it (`cuttable`). */
interface Cuttable {
  readonly stream: ReadableStream<Uint8Array>;
  readonly cut: (reason: Error) => void;
}

/**
 * The source as the service is handed it: read only as the service reads it, and cut on the edge's
 * word — the service's input errored, and the source's read cancelled, at once, whatever either was
 * in the middle of. A pipe would not do: its abort waits for a chunk it has read to be written,
 * which a service that stopped reading never takes, and the source is never let go.
 */
function cuttable(source: ReadableStream<Uint8Array>): Cuttable {
  const reader = source.getReader();
  let cutOff = false;
  let input: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>(
    {
      start: (controller) => {
        input = controller;
      },
      pull: async (controller) => {
        const read = await reader.read();
        if (cutOff) {
          return;
        }
        if (read.done) {
          controller.close();
        } else {
          controller.enqueue(read.value);
        }
      },
      cancel: (reason: unknown) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return {
    stream,
    cut: (reason) => {
      cutOff = true;
      input?.error(reason);
      releaseStream(reader, reason.message);
    },
  };
}

/**
 * Ask the Images service for a transformation, held to `budgetMs`.
 *
 * A host's transformer takes no signal, and a deadline only stops the wait: a transformation past
 * its budget went on reading its source, and made a result nobody read, while the source was asked
 * for again to be served in its place. So the service reads the source through a stream the edge
 * can cut (`cuttable`), and one that runs past its budget, or fails — before it answers at all,
 * too — has it cut, the source let go, and what it answers late released unread.
 */
export async function transformWithin(
  transform: TransformImage,
  source: ReadableStream<Uint8Array>,
  request: ImageTransformRequest,
  budgetMs: number,
): Promise<Transformed> {
  const input = cuttable(source);
  let pending: Promise<Transformed> | undefined;
  try {
    // A transformer that throws before it answers is one that failed, and one that answers with
    // something other than a promise has answered: a promise it returns is taken as it is.
    pending = Promise.resolve(transform(input.stream, request));
    return await withDeadline(pending, budgetMs, 'image transformation');
  } catch (error) {
    input.cut(error instanceof Error ? error : new Error(String(error)));
    if (pending !== undefined) {
      void releaseLate(pending).catch(() => {
        // It failed, as one whose source was cut does: nothing came of it to let go.
      });
    }
    throw error;
  }
}
