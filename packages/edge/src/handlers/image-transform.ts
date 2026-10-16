import { releaseStream, withDeadline } from '@stayingupwind/core/util';

import type { ImageTransformRequest, TransformImage } from '../edge-runtime.ts';

/** What the service answers a transformation with. */
type Transformed = Awaited<ReturnType<TransformImage>>;

/** What a transformation answers once it is past its budget, let go of unread. */
async function releaseLate(pending: Promise<Transformed>): Promise<void> {
  releaseStream((await pending).body, 'image transformation past its budget');
}

/**
 * Ask the Images service for a transformation, held to `budgetMs`.
 *
 * A host's transformer takes no signal, and a deadline only stops the wait: a transformation past
 * its budget went on reading its source, and made a result nobody read, while the source was asked
 * for again to be served in its place. So the service reads the source through a pipe the edge can
 * cut (`pipeThrough`, under a signal of its own), and one that runs past its budget, or fails, has
 * it cut — the source let go — and what it answers late released unread.
 */
export async function transformWithin(
  transform: TransformImage,
  source: ReadableStream<Uint8Array>,
  request: ImageTransformRequest,
  budgetMs: number,
): Promise<Transformed> {
  const cut = new AbortController();
  const piped = source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), {
    signal: cut.signal,
  });
  const pending = transform(piped, request);
  try {
    return await withDeadline(pending, budgetMs, 'image transformation');
  } catch (error) {
    cut.abort(error);
    void releaseLate(pending).catch(() => {
      // It failed, as one whose source was cut does: nothing came of it to let go.
    });
    throw error;
  }
}
