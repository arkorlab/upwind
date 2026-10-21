import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';

import type { StaticFileEntry } from '@stayingupwind/core/manifest';

import type { CheckedStack } from './answers.ts';
import type { Reading } from './reading.ts';

const READ_BUFFER_BYTES = 65_536;
/** Build blobs are immutable; browser samples share only their expected range digest. */
const digests = new WeakMap<CheckedStack, Map<string, Promise<string | undefined>>>();

/** The already-authenticated whole response can prove a range its head and tail cover together. */
function keptDigest(whole: Reading, start: number, length: number): string | undefined {
  const fromTail = length - whole.tail.length;
  if (start >= fromTail) {
    return createHash('sha256')
      .update(whole.tail.subarray(start - fromTail))
      .digest('hex');
  }
  if (whole.head.length < fromTail) return undefined;
  return createHash('sha256')
    .update(whole.head.subarray(start))
    .update(whole.tail.subarray(whole.head.length - fromTail))
    .digest('hex');
}

/** Hash the complete build range with bounded memory, never just its retained prefix or tail. */
async function readDigest(
  stack: CheckedStack,
  file: StaticFileEntry,
  start: number,
): Promise<string | undefined> {
  try {
    await using descriptor = await open(path.join(stack.bundleDir, 'blobs', file.sha256), 'r');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(READ_BUFFER_BYTES, file.byteLength - start));
    let position = start;
    while (position < file.byteLength) {
      const wanted = Math.min(buffer.length, file.byteLength - position);
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

/** The identity bytes from `start` to the file's end; absent when the build cannot supply them. */
export function rangeDigestOf(
  stack: CheckedStack,
  file: StaticFileEntry,
  start: number,
  whole?: Reading,
): Promise<string | undefined> {
  const retained = whole === undefined ? undefined : keptDigest(whole, start, file.byteLength);
  if (retained !== undefined) return Promise.resolve(retained);
  let known = digests.get(stack);
  if (known === undefined) {
    known = new Map();
    digests.set(stack, known);
  }
  const key = `${file.sha256}:${file.byteLength}:${start}`;
  let digest = known.get(key);
  if (digest === undefined) {
    digest = readDigest(stack, file, start);
    known.set(key, digest);
  }
  return digest;
}
