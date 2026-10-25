import { gzipSync } from 'node:zlib';

import { compareCodeUnits } from '@stayingupwind/core/util';

const BLOCK = 512;
const MAX_FILES = 100_000;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;

export interface NodeArchiveFile {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly executable?: boolean | undefined;
}

function portable(name: string): void {
  if (
    name.length > 240 ||
    name.startsWith('/') ||
    /[\\:\p{Cc}]/u.test(name) ||
    name.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Node artifact contains a nonportable file name');
  }
}

function field(header: Buffer, start: number, length: number, text: string): void {
  if (Buffer.byteLength(text) > length)
    throw new Error('Node artifact tar field exceeds its limit');
  header.write(text, start, length, 'utf8');
}

function octal(header: Buffer, start: number, length: number, value: number): void {
  field(header, start, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

/** Canonical USTAR: sorted, unique regular files, fixed ownership/time/mode, no links or PAX. */
export function nodeArtifactArchive(files: readonly NodeArchiveFile[]): Uint8Array {
  if (files.length > MAX_FILES) throw new Error('Node artifact has too many files');
  const chunks: Uint8Array[] = [];
  const seen = new Set<string>();
  let size = BLOCK * 2;
  for (const file of files.toSorted((a, b) => compareCodeUnits(a.name, b.name))) {
    portable(file.name);
    if (seen.has(file.name)) throw new Error('Node artifact contains duplicate paths');
    const parts = file.name.split('/');
    for (let at = 1; at < parts.length; at += 1) {
      if (seen.has(parts.slice(0, at).join('/')))
        throw new Error('Node artifact file shadows a directory');
    }
    seen.add(file.name);
    const header = Buffer.alloc(BLOCK);
    const encoded = Buffer.byteLength(file.name);
    const split = [...file.name.matchAll(/\//gu)]
      .map((match) => match.index)
      .find(
        (at) =>
          Buffer.byteLength(file.name.slice(0, at)) <= 155 &&
          Buffer.byteLength(file.name.slice(at + 1)) <= 100,
      );
    if (encoded <= 100) field(header, 0, 100, file.name);
    else {
      if (split === undefined) throw new Error('Node artifact path cannot be represented in USTAR');
      field(header, 0, 100, file.name.slice(split + 1));
      field(header, 345, 155, file.name.slice(0, split));
    }
    octal(header, 100, 8, file.executable === true ? 0o755 : 0o644);
    octal(header, 108, 8, 0);
    octal(header, 116, 8, 0);
    octal(header, 124, 12, file.bytes.byteLength);
    octal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    field(header, 156, 1, '0');
    field(header, 257, 6, 'ustar\0');
    field(header, 263, 2, '00');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    field(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    const padding = (BLOCK - (file.bytes.byteLength % BLOCK)) % BLOCK;
    size += BLOCK + file.bytes.byteLength + padding;
    if (size > MAX_ARCHIVE_BYTES)
      throw new Error('Node artifact exceeds its uncompressed size limit');
    chunks.push(header, file.bytes, Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  const compressed = gzipSync(Buffer.concat(chunks), { level: 6 });
  if (compressed.byteLength > MAX_COMPRESSED_BYTES)
    throw new Error('Node artifact exceeds its compressed size limit');
  return compressed;
}
