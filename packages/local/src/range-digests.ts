import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';

import type { StaticFileEntry } from '@stayingupwind/core/manifest';

import type { CheckedStack } from './answers.ts';
import type { Reading } from './reading.ts';

const READ_BUFFER_BYTES = 65_536;
/** Build blobs are immutable; browser samples share only their expected range digest. */
const digests = new WeakMap<CheckedStack, Map<string, Promise<string | undefined>>>();

/** The bytes of a file from `start` up to `stop`, exclusive: a span of it, ending at its end or before. */
interface Span {
  readonly start: number;
  readonly stop: number;
}

/** The already-authenticated whole response can prove a span its head and tail cover together. */
function keptDigest(whole: Reading, { start, stop }: Span, length: number): string | undefined {
  const fromTail = length - whole.tail.length;
  if (start >= fromTail) {
    return createHash('sha256')
      .update(whole.tail.subarray(start - fromTail, stop - fromTail))
      .digest('hex');
  }
  if (stop <= whole.head.length) {
    return createHash('sha256').update(whole.head.subarray(start, stop)).digest('hex');
  }
  if (whole.head.length < fromTail) return undefined;
  return createHash('sha256')
    .update(whole.head.subarray(start))
    .update(whole.tail.subarray(whole.head.length - fromTail, stop - fromTail))
    .digest('hex');
}

/** Hash the complete build span with bounded memory, never just its retained prefix or tail. */
async function readDigest(
  stack: CheckedStack,
  file: StaticFileEntry,
  { start, stop }: Span,
): Promise<string | undefined> {
  try {
    await using descriptor = await open(path.join(stack.bundleDir, 'blobs', file.sha256), 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(READ_BUFFER_BYTES, stop - start));
    let position = start;
    while (position < stop) {
      const wanted = Math.min(buffer.length, stop - position);
      const { bytesRead } = await descriptor.read(buffer, 0, wanted, position);
      if (bytesRead === 0) return undefined;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * The identity bytes of a span of the file (`Span`); absent when the build cannot supply them. By
 * what the whole answer kept of them, where it kept them all (`whole`); by the blob otherwise.
 */
export function spanDigestOf(
  stack: CheckedStack,
  file: StaticFileEntry,
  span: Span,
  whole?: Reading,
): Promise<string | undefined> {
  const retained = whole === undefined ? undefined : keptDigest(whole, span, file.byteLength);
  if (retained !== undefined) return Promise.resolve(retained);
  let known = digests.get(stack);
  if (known === undefined) {
    known = new Map();
    digests.set(stack, known);
  }
  const key = `${file.sha256}:${file.byteLength}:${span.start}:${span.stop}`;
  let digest = known.get(key);
  if (digest === undefined) {
    digest = readDigest(stack, file, span);
    known.set(key, digest);
  }
  return digest;
}

/** The identity bytes from `start` to the file's end; absent when the build cannot supply them. */
export function rangeDigestOf(
  stack: CheckedStack,
  file: StaticFileEntry,
  start: number,
  whole?: Reading,
): Promise<string | undefined> {
  return spanDigestOf(stack, file, { start, stop: file.byteLength }, whole);
}
