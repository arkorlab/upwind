import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 256;
const MAX_FILE_BYTES = 16_777_216;
const MAX_TOTAL_BYTES = 67_108_864;
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 16;
const MAX_PATH_LENGTH = 240;

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

interface PublicCodeFile {
  readonly name: string;
  readonly sha256: string;
  readonly source: string;
}

interface Inventory {
  bytes: number;
  entries: number;
  readonly files: PublicCodeFile[];
}

function compareNames(left: PublicCodeFile, right: PublicCodeFile): number {
  return Number(left.name > right.name) - Number(left.name < right.name);
}

async function boundedBytes(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  assert.equal(offset, size, 'Public code changed while collecting');
  return buffer.subarray(0, offset);
}

async function sourceFile(file: string, name: string, state: Inventory): Promise<void> {
  if (!name.endsWith('.js') || name.endsWith('-manifest.js')) return;
  const metadata = await lstat(file);
  assert.ok(metadata.isFile() && metadata.nlink === 1, 'Expected single-link public code');
  assert.ok(metadata.size <= MAX_FILE_BYTES, 'Public code file budget exceeded');
  state.bytes += metadata.size;
  assert.ok(
    state.bytes <= MAX_TOTAL_BYTES && state.files.length < MAX_FILES,
    'Public corpus budget exceeded',
  );
  // The compiler has exited; still bound allocation and reject a replaced final symlink.
  // eslint-disable-next-line no-bitwise -- These POSIX open flags retain read-only access and reject final symlinks.
  await using handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const actual = await handle.stat();
  assert.ok(
    actual.isFile() && actual.ino === metadata.ino && actual.dev === metadata.dev,
    'Public code identity changed',
  );
  const bytes = await boundedBytes(handle, metadata.size);
  const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  assert.ok(
    !source.includes('\0') && !/sourceMappingURL\s*=\s*data:/u.test(source),
    'Non-public code payload',
  );
  state.files.push({ name, sha256: sha256(bytes), source });
}

async function visit(
  root: string,
  relative: string,
  depth: number,
  state: Inventory,
): Promise<void> {
  assert.ok(depth <= MAX_DEPTH, 'Public corpus depth exceeded');
  const directory = path.join(root, relative);
  assert.ok((await lstat(directory)).isDirectory(), 'Expected public code directory');
  const entries = await readdir(directory, { withFileTypes: true });
  for (const item of entries) {
    state.entries += 1;
    assert.ok(state.entries <= MAX_ENTRIES, 'Public corpus entry budget exceeded');
    assert.ok(
      /^[\w.[\]-]+$/u.test(item.name) && item.name !== '.' && item.name !== '..',
      'Unsafe public code name',
    );
    assert.ok(!item.isSymbolicLink(), 'Public corpus must not follow symlinks');
    const name = path.posix.join(relative, item.name);
    assert.ok(name.length <= MAX_PATH_LENGTH, 'Public code path budget exceeded');
    if (item.isDirectory()) await visit(root, name, depth + 1, state);
    else if (item.isFile()) await sourceFile(path.join(root, name), name, state);
    else assert.fail('Unexpected public code filesystem entry');
  }
}

/** Only fixed, credential-free public compilation output is permitted as input to this CI collector. */
export async function publicPagesCorpus(project: string): Promise<readonly PublicCodeFile[]> {
  const canonical = await realpath(project);
  const server = path.join(canonical, '.next/server');
  assert.equal(await realpath(server), server, 'Public server path must not contain symlinks');
  const state: Inventory = { bytes: 0, entries: 0, files: [] };
  for (const name of ['chunks', 'pages']) await visit(server, name, 0, state);
  assert.ok(state.files.length > 0, 'Missing compiled public Pages code');
  return state.files.toSorted(compareNames);
}
