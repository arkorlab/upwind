import { isDeadlineError, releaseStream, withDeadline } from '@stayingupwind/core/util';

import type { EdgeRuntime, ImageTransformRequest, TransformImage } from '../edge-runtime.ts';
import { logWarn } from '../observability/logger.ts';
import { cuttable, imageWithin } from './image-stream.ts';

/** What the service answers a transformation with. */
type Transformed = Awaited<ReturnType<TransformImage>>;

/** What a transformation answers once it is past its budget, let go of unread. */
async function releaseLate(pending: Promise<Transformed>, reason: string): Promise<void> {
  releaseStream((await pending).body, reason);
}

/**
 * Ask the Images service for a transformation, held to `budgetMs`.
 *
 * A host's transformer takes no signal, and a deadline only stops the wait: a transformation past
 * its budget went on reading its source, and made a result nobody read, while the source was asked
 * for again to be served in its place. So the service reads the source through a stream the edge
 * can cut (`cuttable`), and one that runs past its budget, or fails — before it answers at all,
 * too — has it cut, the source let go, and what it answers late released unread. So does one whose
 * client left before the service answered: nobody remains to take the result.
 */
export async function transformWithin(
  transform: TransformImage,
  source: ReadableStream<Uint8Array>,
  request: ImageTransformRequest,
  { budgetMs, signal }: { readonly budgetMs: number; readonly signal: AbortSignal },
): Promise<Transformed> {
  const input = cuttable(source);
  let pending: Promise<Transformed> | undefined;
  try {
    signal.throwIfAborted();
    // A transformer that throws before it answers is one that failed, and one that answers with
    // something other than a promise has answered: a promise it returns is taken as it is.
    pending = Promise.resolve(transform(input.stream, request));
    return await imageWithin(pending, signal, budgetMs, 'image transformation');
  } catch (error) {
    input.cut(error instanceof Error ? error : new Error(String(error)));
    if (pending !== undefined) {
      const reason = isDeadlineError(error)
        ? 'image transformation past its budget'
        : 'image transformation abandoned';
      void releaseLate(pending, reason).catch(() => {
        // It failed, as one whose source was cut does: nothing came of it to let go.
      });
    }
    throw error;
  }
}

/** What the rest of a result too large to hold is streamed on under (`withinBudget`). */
export interface ResultRest {
  readonly runtime: Pick<EdgeRuntime, 'now'>;
  /** What all the reads of the result together may wait on it, the first part's among them. */
  readonly budgetMs: number;
  /** What the read of its first part took of that. */
  readonly spentOnFirstPart: number;
  /** The image's `url`, for the log of a result that stopped arriving. */
  readonly href: string;
  /**
   * Told what went out of the result, once, however its stream ends: read to its end, given up on,
   * or let go of by the client — or by an answer that carries no body, before any of it went out.
   */
  readonly ended: (sent: number) => void;
}

/**
 * The rest of a result too large to hold, streamed on within what its first part left of the budget
 * it was read under: all the reads of the result together, the first part's among them, may wait on
 * it no longer than that — one budget for the whole answer, not one more for its rest. It is the
 * result's time that counts, never the client's — a read is asked for only once the client has
 * taken the last — so a client that takes its time over a large image is not cut off, and a result
 * that stops arriving, or trickles, is let go of rather than holding the response open for as long
 * as the client waits. Only a response on this path pays for it: a timer each read.
 */
export function withinBudget(
  body: ReadableStream<Uint8Array>,
  rest: ResultRest,
): ReadableStream<Uint8Array> {
  const { runtime, ended } = rest;
  const reader = body.getReader();
  let spent = rest.spentOnFirstPart;
  let sent = 0;
  let told = false;
  const end = (): void => {
    if (!told) {
      told = true;
      ended(sent);
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const asked = runtime.now();
      let read: ReadableStreamReadResult<Uint8Array>;
      try {
        // One budget in two places, as for the first part: what is left of it is the stall too.
        read = await withDeadline(reader.read(), rest.budgetMs - spent, 'image result');
      } catch (error) {
        logWarn('image result stopped arriving', {
          href: rest.href,
          detail: error instanceof Error ? error.message : String(error),
        });
        // Not awaited: a result that stopped arriving may never acknowledge the cancel either.
        releaseStream(reader, 'image result stopped arriving');
        end();
        controller.error(error);
        return;
      }
      spent += runtime.now() - asked;
      if (read.done) {
        end();
        controller.close();
        return;
      }
      sent += read.value.byteLength;
      controller.enqueue(read.value);
    },
    cancel: (reason: unknown) => {
      end();
      return reader.cancel(reason);
    },
  });
}
