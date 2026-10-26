import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

const KIB = 1024;
const MIB = KIB * KIB;
const SCAN_MIB = 64;
const CHUNK_KIB = 64;
/** Matches the source archive's per-source bound; a violation fails the gate, never skips a file. */
export const MAX_FILE_BYTES = MIB;
/** The scanner already allows this much Git output; retained source bytes have the same ceiling. */
export const MAX_SCAN_BYTES = SCAN_MIB * MIB;
const CHUNK_BYTES = CHUNK_KIB * KIB;

export function boundedFile(root: string, file: string, remaining = MAX_SCAN_BYTES): Buffer {
  const location = path.resolve(root, file);
  const relative = path.relative(realpathSync(root), realpathSync(path.dirname(location)));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${file} is outside the repository`);
  }
  const before = lstatSync(location);
  if (!before.isFile()) throw new Error(`${file} is not a regular file`);
  const limit = Math.min(MAX_FILE_BYTES, remaining);
  if (before.size > limit) throw new Error(`${file} exceeds the vocabulary byte budget`);
  const flags =
    process.platform === 'win32'
      ? constants.O_RDONLY
      : // eslint-disable-next-line no-bitwise -- operating-system file flags are combined as a mask.
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const fd = openSync(location, flags);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${file} changed while opening or is not a regular file`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, limit - total + 1));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) return Buffer.concat(chunks, total);
      total += count;
      if (total > limit) throw new Error(`${file} exceeds the vocabulary byte budget`);
      chunks.push(chunk.subarray(0, count));
    }
    throw new Error(`${file} exceeds the vocabulary byte budget`);
  } finally {
    closeSync(fd);
  }
}
