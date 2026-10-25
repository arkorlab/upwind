import { gzipSync } from 'node:zlib';

import { compareCodeUnits } from '@stayingupwind/core/util';

const BLOCK = 512;
const MEBIBYTE = 1024 * 1024;
const MAX_FILES = 100_000;
const MAX_ARCHIVE_BYTES = 1024 * MEBIBYTE;
const MAX_COMPRESSED_BYTES = 256 * MEBIBYTE;
const MAX_PATH_CHARACTERS = 240;
const TRAILER_BLOCKS = 2;
const OCTAL_RADIX = 8;
const CHECKSUM_DIGITS = 6;
const CHECKSUM_SPACE = 0x20;
const COMPRESSION_LEVEL = 6;
const FILE_MODE = 0o644;
const EXECUTABLE_MODE = 0o755;
const USTAR = {
  name: [0, 100],
  mode: [100, 8],
  uid: [108, 8],
  gid: [116, 8],
  size: [124, 12],
  mtime: [136, 12],
  checksum: [148, 8],
  type: [156, 1],
  magic: [257, 6],
  version: [263, 2],
  prefix: [345, 155],
} as const;
type Field = readonly [offset: number, length: number];

export interface NodeArchiveFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly executable?: boolean | undefined;
}

function portable(name: string): void {
  if (
    name.length > MAX_PATH_CHARACTERS ||
    name.startsWith('/') ||
    /[\\:\p{Cc}]/u.test(name) ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Node artifact contains a nonportable file name');
  }
}

function field(header: Buffer, [start, length]: Field, text: string): void {
  if (Buffer.byteLength(text) > length)
    throw new Error('Node artifact tar field exceeds its limit');
  header.write(text, start, length, 'utf8');
}

function octal(header: Buffer, location: Field, value: number): void {
  const encoded = value.toString(OCTAL_RADIX).padStart(location[1] - 1, '0');
  field(header, location, `${encoded}\0`);
}

function pathFields(header: Buffer, name: string): void {
  if (Buffer.byteLength(name) <= USTAR.name[1]) {
    field(header, USTAR.name, name);
    return;
  }
  const split = [...name.matchAll(/\//gu)]
    .map((match) => match.index)
    .find((at) => {
      return (
        Buffer.byteLength(name.slice(0, at)) <= USTAR.prefix[1] &&
        Buffer.byteLength(name.slice(at + 1)) <= USTAR.name[1]
      );
    });
  if (split === undefined) throw new Error('Node artifact path cannot be represented in USTAR');
  field(header, USTAR.name, name.slice(split + 1));
  field(header, USTAR.prefix, name.slice(0, split));
}

function fileHeader(file: NodeArchiveFile): Buffer {
  const header = Buffer.alloc(BLOCK);
  pathFields(header, file.name);
  octal(header, USTAR.mode, file.executable === true ? EXECUTABLE_MODE : FILE_MODE);
  octal(header, USTAR.uid, 0);
  octal(header, USTAR.gid, 0);
  octal(header, USTAR.size, file.bytes.byteLength);
  octal(header, USTAR.mtime, 0);
  header.fill(CHECKSUM_SPACE, USTAR.checksum[0], USTAR.checksum[0] + USTAR.checksum[1]);
  field(header, USTAR.type, '0');
  field(header, USTAR.magic, 'ustar\0');
  field(header, USTAR.version, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const encoded = checksum.toString(OCTAL_RADIX).padStart(CHECKSUM_DIGITS, '0');
  field(header, USTAR.checksum, `${encoded}\0 `);
  return header;
}

function uniquePath(name: string, seen: Set<string>): void {
  portable(name);
  if (seen.has(name)) throw new Error('Node artifact contains duplicate paths');
  const parts = name.split('/');
  for (let at = 1; at < parts.length; at += 1) {
    if (seen.has(parts.slice(0, at).join('/')))
      throw new Error('Node artifact file shadows a directory');
  }
  seen.add(name);
}

/** Canonical USTAR: sorted, unique regular files, fixed ownership/time/mode, no links or PAX. */
export function nodeArtifactArchive(files: readonly NodeArchiveFile[]): Uint8Array {
  if (files.length > MAX_FILES) throw new Error('Node artifact has too many files');
  const chunks: Uint8Array[] = [];
  const seen = new Set<string>();
  let size = BLOCK * TRAILER_BLOCKS;
  const ordered = files.toSorted((a, b) => compareCodeUnits(a.name, b.name));
  for (const file of ordered) {
    uniquePath(file.name, seen);
    const header = fileHeader(file);
    const padding = (BLOCK - (file.bytes.byteLength % BLOCK)) % BLOCK;
    size += BLOCK + file.bytes.byteLength + padding;
    if (size > MAX_ARCHIVE_BYTES)
      throw new Error('Node artifact exceeds its uncompressed size limit');
    chunks.push(header, file.bytes, Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * TRAILER_BLOCKS));
  const compressed = gzipSync(Buffer.concat(chunks), { level: COMPRESSION_LEVEL });
  if (compressed.byteLength > MAX_COMPRESSED_BYTES)
    throw new Error('Node artifact exceeds its compressed size limit');
  return compressed;
}
