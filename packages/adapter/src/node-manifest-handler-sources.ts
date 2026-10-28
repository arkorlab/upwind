import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import type { NodeManifestHandlerSourcePin } from './node-manifest-handler-catalog.ts';

const MAX_SOURCE_BYTES = 4_194_304;
export interface NodeManifestHandlerFile {
  readonly file: string;
  readonly sha256: string;
  readonly identity: string;
}
export interface NodeManifestHandlerDirectory {
  readonly directory: string;
  readonly identity: string;
}
function refuse(reason: string): never {
  throw new AuditError(`Unproved Pages handler ${reason}; refusing helper member`);
}
function identity(info: Awaited<ReturnType<typeof lstat>>): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}
export async function checkedNodeManifestHandlerDirectory(
  directory: string,
): Promise<NodeManifestHandlerDirectory> {
  const info = await lstat(directory);
  if (!info.isDirectory() || (await realpath(directory)) !== directory)
    refuse('canonical Next directory');
  const final = await lstat(directory);
  if (!final.isDirectory() || final.dev !== info.dev || final.ino !== info.ino)
    refuse('Next directory changed while sealing');
  return Object.freeze({ directory, identity: `${info.dev}:${info.ino}` });
}
export async function assertCurrentNodeManifestHandlerDirectory(
  known: NodeManifestHandlerDirectory,
): Promise<void> {
  const actual = await checkedNodeManifestHandlerDirectory(known.directory);
  if (actual.identity !== known.identity) refuse('Next directory replaced');
}
/** Regular canonical files only. Bytes remain original and are never evaluated or rewritten. */
export async function checkedNodeManifestHandlerFile(
  file: string,
  sha256: string,
): Promise<NodeManifestHandlerFile> {
  const before = await lstat(file);
  if (!before.isFile() || before.size > MAX_SOURCE_BYTES || (await realpath(file)) !== file)
    refuse('regular bounded source identity');
  const known = identity(before);
  await using handle = await open(file, 'r');
  const opened = await handle.stat();
  if (!opened.isFile() || identity(opened) !== known) refuse('source changed before reading');
  const bytes = Buffer.alloc(before.size + 1);
  const read = await handle.read(bytes, 0, bytes.length, 0);
  const after = await handle.stat();
  if (
    read.bytesRead !== before.size ||
    identity(after) !== known ||
    createHash('sha256').update(bytes.subarray(0, read.bytesRead)).digest('hex') !== sha256
  )
    refuse('source bytes changed');
  const final = await lstat(file);
  if (identity(final) !== known || !final.isFile() || (await realpath(file)) !== file)
    refuse('source changed while sealing');
  return Object.freeze({ file, sha256, identity: known });
}
export function nodeManifestHandlerOrigin(root: string, relative: string): string {
  if (
    relative.length === 0 ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => part.length === 0 || part === '.' || part === '..')
  )
    refuse('source origin');
  const file = path.join(root, relative);
  if (beneath(root, file) !== relative.split('/').join(path.sep)) refuse('source origin boundary');
  return file;
}
export async function checkedNodeManifestHandlerPin(
  root: string,
  pin: NodeManifestHandlerSourcePin,
): Promise<NodeManifestHandlerFile> {
  return await checkedNodeManifestHandlerFile(
    nodeManifestHandlerOrigin(root, pin.relative),
    pin.sha256,
  );
}
export async function assertCurrentNodeManifestHandlerFiles(
  sources: Iterable<NodeManifestHandlerFile>,
): Promise<void> {
  for (const source of sources) {
    const actual = await checkedNodeManifestHandlerFile(source.file, source.sha256);
    if (actual.identity !== source.identity) refuse('source file replaced');
  }
}
