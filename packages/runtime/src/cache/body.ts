import { releaseStream } from '@stayingupwind/core/util';

/**
 * A body read whole to be kept, never past what may be kept: once it passes `limit` bytes the
 * rest is not read, the stream is let go, and there is nothing to show for it. What was already
 * read of it is dropped with it. Let go without waiting to hear that it was: a stream that never
 * acknowledges its cancellation would otherwise hold whatever is reading it for good.
 */
export async function readWithin(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.byteLength;
    if (total > limit) {
      releaseStream(reader, 'past what may be kept');
      return undefined;
    }
    chunks.push(next.value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
