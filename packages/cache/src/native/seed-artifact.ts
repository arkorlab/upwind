/* eslint-disable security/detect-non-literal-fs-filename -- A validated digest is the entire filename in the configured build directory. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';

import { sha256HexSchema } from '@stayingupwind/core/artifact';
import type { SeedArtifact } from '@stayingupwind/host/cache';

type Artifact = Pick<SeedArtifact, 'sha256' | 'byteLength'>;

export function validateSeedArtifact(artifact: Artifact, maximumBytes: number): void {
  if (
    !sha256HexSchema.validate(artifact.sha256) ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength < 0 ||
    artifact.byteLength > maximumBytes
  ) {
    throw new Error('native cache build artifact has an invalid digest or length');
  }
}

/** Read a confined regular file through one descriptor, within the declared and authority limits. */
export async function readSeedArtifact(
  directory: string,
  artifact: Artifact,
  maximumBytes: number,
): Promise<Uint8Array> {
  validateSeedArtifact(artifact, maximumBytes);
  const filename = path.join(directory, artifact.sha256);
  const before = await lstat(filename);
  if (!before.isFile() || before.size !== artifact.byteLength) {
    throw new Error('native cache build artifact is not a regular file of the declared length');
  }
  // Windows does not expose O_NOFOLLOW/O_NONBLOCK; verify the opened file's identity there too.
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : // eslint-disable-next-line no-bitwise -- operating-system file flags are combined as a mask.
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  await using file = await open(filename, flags);
  const opened = await file.stat();
  if (
    !opened.isFile() ||
    opened.dev !== before.dev ||
    opened.ino !== before.ino ||
    opened.size !== artifact.byteLength
  ) {
    throw new Error('native cache build artifact changed while opening it');
  }
  const bytes = new Uint8Array(artifact.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await file.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0)
      throw new Error('native cache build artifact ended before its declared length');
    offset += bytesRead;
  }
  const extra = await file.read(new Uint8Array(1), 0, 1, offset);
  if (
    extra.bytesRead !== 0 ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  ) {
    throw new Error('native cache build artifact does not match its digest');
  }
  return bytes;
}
