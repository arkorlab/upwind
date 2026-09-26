import { concatBytes } from './bytes.ts';
import { withDeadline } from './deadline.ts';
import { releaseStream } from './stream.ts';

/**
 * Bounded reads of bodies a remote origin controls.
 *
 * Everything fetched from a submitted origin is attacker-shaped: the host can answer quickly with a
 * body far larger than the isolate's memory (a compressed response that expands on the way in is
 * the cheapest version of this), or answer its headers and then stall forever. Both are bounded
 * here, and the result is always exactly the first `limit` bytes, however the origin chunked them,
 * so two reads of the same document hash the same.
 */

const KIB = 1024;
const MIB = KIB * KIB;
const MAX_ORIGIN_DOCUMENT_MIB = 8;
/** Matches the proof sampler's `maxBodyBytes`, so eligibility and proof read the same document. */
export const MAX_ORIGIN_DOCUMENT_BYTES = MAX_ORIGIN_DOCUMENT_MIB * MIB;

export interface ReadPrefixOptions {
  readonly limit: number;
  /** Wall-clock budget for the whole read. Throws `DeadlineError` when it runs out. */
  readonly timeoutMs: number;
}

/** Read at most `options.limit` bytes of a body, then cancel the rest. */
export async function readBodyPrefix(
  body: ReadableStream<Uint8Array> | null,
  options: ReadPrefixOptions,
): Promise<Uint8Array> {
  if (body === null) {
    return new Uint8Array();
  }
  const deadline = Date.now() + options.timeoutMs;
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < options.limit) {
      const { done, value } = await withDeadline(
        reader.read(),
        deadline - Date.now(),
        'origin body read',
      );
      if (done) {
        break;
      }
      // Cut where the limit is, not where the chunk ends. Keeping the whole of a crossing chunk
      // and slicing afterwards leaves the oversized allocation behind the returned view, so the
      // bound the caller asked for is the bound on nothing: one chunk of an origin's choosing
      // sets how much of the isolate this holds.
      const room = options.limit - total;
      parts.push(value.byteLength > room ? value.subarray(0, room) : value);
      total += value.byteLength;
    }
  } finally {
    // Never awaited: a socket that stopped sending may never acknowledge the cancel either, and
    // waiting for it here would hand back the very hang the deadline exists to bound.
    releaseStream(reader, 'prefix read complete');
  }
  return concatBytes(parts);
}

/**
 * A whole body, or the news that it went past the limit — with the body intact either way.
 *
 * Only a `complete` body can be measured, hashed, or given to a fixed-length `Response`. An
 * `over-limit` one is still every byte the origin sent, in order, for a caller that is delivering
 * it: refusing to hold a response is not refusing to pass it on. A caller that was only keeping a
 * copy lets that stream go.
 */
export type BoundedBody =
  | { readonly kind: 'complete'; readonly bytes: Uint8Array }
  | { readonly kind: 'over-limit'; readonly body: ReadableStream<Uint8Array> };

export interface BoundedReadOptions {
  readonly limit: number;
  /**
   * Longest the body may go without a chunk arriving. Throws `DeadlineError` when it runs out.
   *
   * Silence is what tells an origin that stopped sending from a body that is merely slow: this
   * reads at the pace of whoever else holds the body, so a large asset behind a patient client
   * looks exactly like a dead connection except in how long the quiet lasts.
   */
  readonly stallMs: number;
  /**
   * Longest the whole read may take. Throws `DeadlineError` when it runs out.
   *
   * Not a budget for the *delivery* — whoever else holds this body is not waiting on this reader,
   * and the bytes reach them either way. It is a budget against the caller's own runtime, which
   * stops background work at some point of its choosing: a read cut off there reports nothing at
   * all, and giving up first is what leaves an outcome to record.
   */
  readonly budgetMs: number;
}

/** Thrown into a limited body's stream once it passes its limit; the reader sees why it ended. */
class BodyLimitError extends Error {
  constructor(limit: number, options?: ErrorOptions) {
    super(`body exceeds ${limit} bytes`, options);
    this.name = 'BodyLimitError';
  }
}

/** Whether a stream failed for passing the limit `limitBody` put on it. */
export function isBodyLimitError(error: unknown): boolean {
  return error instanceof BodyLimitError;
}

/**
 * A body counted as it passes, that fails once it passes `limit`: for a body to be handed on
 * whole — to a service, to a client — but never past the size the caller will stand for.
 */
export function limitBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
): ReadableStream<Uint8Array> {
  let total = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) {
        controller.error(new BodyLimitError(limit));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return body.pipeThrough(counter);
}

/** The chunks already read, then the rest of the reader they came from. */
function resumeStream(
  parts: readonly Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel: (reason: unknown) => reader.cancel(reason),
  });
}

export interface PeekedBody {
  /** The first bytes, up to `length` of them; fewer when the body is shorter. */
  readonly prefix: Uint8Array;
  /** The whole body, the prefix included, to be consumed once. */
  readonly body: ReadableStream<Uint8Array>;
}

/**
 * Look at the first bytes of a body without giving any of it up: what was read is handed back
 * ahead of the rest, so the body can still be streamed whole to wherever it was going.
 */
export async function peekBody(
  body: ReadableStream<Uint8Array>,
  length: number,
  timeoutMs: number,
): Promise<PeekedBody> {
  const deadline = Date.now() + timeoutMs;
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < length) {
      const { done, value } = await withDeadline(reader.read(), deadline - Date.now(), 'body peek');
      if (done) {
        break;
      }
      parts.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    releaseStream(reader, 'body peek failed');
    throw error;
  }
  return { prefix: concatBytes(parts).subarray(0, length), body: resumeStream(parts, reader) };
}

/**
 * Read a body to its end, or give up once it passes `limit`.
 *
 * A Cloudflare Function subrequest arrives without `Content-Length` (the runtime sets that from the
 * data source, and a subrequest body is a stream), so counting is the only way to learn how many
 * bytes there are — and the length is the verdict on whether a copy can be kept.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  options: BoundedReadOptions,
): Promise<BoundedBody> {
  if (body === null) {
    return { kind: 'complete', bytes: new Uint8Array() };
  }
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  const deadline = Date.now() + options.budgetMs;
  let total = 0;
  try {
    // `<=`, so a body of exactly `limit` bytes is complete: one more read is what distinguishes it
    // from a body that has more to come.
    while (total <= options.limit) {
      // Whichever runs out first. A caller telling the two apart has only to compare how long it
      // waited with the budget it gave: the stall can only fire while there is budget left.
      const { done, value } = await withDeadline(
        reader.read(),
        Math.min(options.stallMs, deadline - Date.now()),
        'origin body read',
      );
      if (done) {
        // Nothing to release: a body read to its end is closed, and the reader holding a lock on a
        // closed stream is holding nothing. The paths below let go of one still open.
        return { kind: 'complete', bytes: concatBytes(parts) };
      }
      parts.push(value);
      total += value.byteLength;
    }
  } catch (error) {
    // Not awaited, for the reason `readBodyPrefix` gives: a socket that stopped sending may never
    // acknowledge the cancel either.
    releaseStream(reader, 'bounded read failed');
    throw error;
  }
  return { kind: 'over-limit', body: resumeStream(parts, reader) };
}
