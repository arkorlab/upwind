/** Failure-only copies of a fixed public fixture's compiled JavaScript, never a general sanitizer. */
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { mkdir, open, opendir, realpath, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

const MAX_FILES = 256;
const MAX_FILE_BYTES = 16_777_216;
const MAX_TOTAL_BYTES = 67_108_864;
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 16;
const DIAGNOSTIC_DIRECTORY = 'upwind-native-next-diagnostics';
// eslint-disable-next-line no-bitwise -- POSIX open flags are bitmasks; O_NOFOLLOW prevents following a source symlink.
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// eslint-disable-next-line no-bitwise -- Add nonblocking mode so a replaced source FIFO cannot block diagnostic cleanup.
const FILE_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;

interface Summary {
  files: number;
  bytes: number;
  truncated: boolean;
}
interface Collection {
  readonly destination: string;
  readonly summary: Summary;
  entries: number;
}

function descriptorPath(handle: FileHandle, name?: string): string {
  const base = `/proc/self/fd/${handle.fd}`;
  return name === undefined ? base : `${base}/${name}`;
}

function safeName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('.') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !/\p{Cc}/u.test(name)
  );
}

function allowedEntry(prefix: string, name: string): boolean {
  return safeName(name) && (prefix !== '' || name === 'pages' || name === 'chunks');
}

function javascriptText(bytes: Buffer): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return !text.includes('\0') && !/sourceMappingURL\s*=\s*data:/u.test(text);
  } catch {
    return false;
  }
}

async function boundedBytes(handle: FileHandle, remaining: number): Promise<Buffer | undefined> {
  const before = await handle.stat();
  if (!before.isFile() || before.nlink !== 1 || before.size > Math.min(MAX_FILE_BYTES, remaining))
    return undefined;
  const buffer = Buffer.alloc(before.size + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  const after = await handle.stat();
  if (
    length !== before.size ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  )
    return undefined;
  const bytes = buffer.subarray(0, length);
  // A .js extension alone must not admit native bytes or an embedded source-map payload.
  return javascriptText(bytes) ? bytes : undefined;
}

async function copyJavaScript(
  directory: FileHandle,
  name: string,
  relative: string,
  state: Collection,
): Promise<void> {
  // Retain compiled code, never generated manifest data (including build-time encryption metadata).
  if (!name.endsWith('.js') || name.endsWith('-manifest.js')) return;
  await using file = await open(descriptorPath(directory, name), FILE_FLAGS);
  const bytes = await boundedBytes(file, MAX_TOTAL_BYTES - state.summary.bytes);
  if (bytes === undefined) {
    state.summary.truncated = true;
    return;
  }
  const target = path.join(state.destination, relative);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  state.summary.files += 1;
  state.summary.bytes += bytes.length;
}

async function collect(
  directory: FileHandle,
  prefix: string,
  depth: number,
  state: Collection,
): Promise<void> {
  const entries = await opendir(descriptorPath(directory));
  for await (const entry of entries) {
    if (
      state.entries >= MAX_ENTRIES ||
      state.summary.files >= MAX_FILES ||
      state.summary.bytes >= MAX_TOTAL_BYTES
    ) {
      state.summary.truncated = true;
      break;
    }
    state.entries += 1;
    if (!allowedEntry(prefix, entry.name)) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (depth >= MAX_DEPTH) {
        state.summary.truncated = true;
        continue;
      }
      await using child = await open(descriptorPath(directory, entry.name), DIRECTORY_FLAGS);
      await collect(child, relative, depth + 1, state);
    } else if (entry.isFile()) {
      await copyJavaScript(directory, entry.name, relative, state);
    }
  }
}

/** Call only after fixture identity checks and child-group cleanup, and only on a failed control. */
export async function retainNativeNextDiagnostics(
  fixture: string,
  runnerTemp: string,
): Promise<Readonly<Summary>> {
  assert.equal(process.platform, 'linux', 'Diagnostics require the isolated Linux control');
  const root = await realpath(runnerTemp);
  const parent = path.dirname(fixture);
  assert.ok(
    path.isAbsolute(fixture) &&
      path.basename(fixture) === 'fixture' &&
      path.dirname(parent) === root &&
      path.basename(parent).startsWith('upwind-native-next-'),
    "Diagnostics require this control's temporary fixture",
  );
  await using rootDirectory = await open(root, DIRECTORY_FLAGS);
  await using parentDirectory = await open(
    descriptorPath(rootDirectory, path.basename(parent)),
    DIRECTORY_FLAGS,
  );
  await using fixtureDirectory = await open(
    descriptorPath(parentDirectory, 'fixture'),
    DIRECTORY_FLAGS,
  );
  await using nextDirectory = await open(
    descriptorPath(fixtureDirectory, '.next'),
    DIRECTORY_FLAGS,
  );
  await using serverDirectory = await open(
    descriptorPath(nextDirectory, 'server'),
    DIRECTORY_FLAGS,
  );
  const destination = path.join(root, DIAGNOSTIC_DIRECTORY);
  // Refuse an existing output, including a symlink. Never reuse somebody else's directory.
  await mkdir(destination, { mode: 0o700 });
  const state: Collection = {
    destination,
    summary: { files: 0, bytes: 0, truncated: false },
    entries: 0,
  };
  await collect(serverDirectory, '', 0, state);
  return Object.freeze({ ...state.summary });
}
