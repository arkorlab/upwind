import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Hex } from '@upwind/core/artifact';
import type { BlobRef } from '@upwind/core/bundle';

/**
 * Content-addressed files under `<outDir>/blobs/<sha256>`. Writing the same bytes twice costs one
 * hash and no second write, so a shell that several routes share is stored once. The bytes are
 * what is shared; each reference carries the media type its own caller named, since two files
 * with the same bytes — two empty ones, say — need not be the same kind of file.
 */
export class BlobStore {
  readonly #dir: string;
  readonly #seen = new Set<string>();

  constructor(outDir: string) {
    this.#dir = path.join(outDir, 'blobs');
  }

  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
  }

  async put(bytes: Uint8Array, contentType: string): Promise<BlobRef> {
    const sha256 = await sha256Hex(bytes);
    if (!this.#seen.has(sha256)) {
      await writeFile(path.join(this.#dir, sha256), bytes);
      this.#seen.add(sha256);
    }
    return { sha256, byteLength: bytes.byteLength, contentType };
  }

  async putText(text: string, contentType: string): Promise<BlobRef> {
    return this.put(new TextEncoder().encode(text), contentType);
  }

  async putFile(filePath: string, contentType: string): Promise<BlobRef> {
    return this.put(new Uint8Array(await readFile(filePath)), contentType);
  }

  get count(): number {
    return this.#seen.size;
  }
}

const JAVASCRIPT = 'text/javascript; charset=utf-8';
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.rsc': 'text/x-component',
  '.js': JAVASCRIPT,
  '.mjs': JAVASCRIPT,
  '.cjs': JAVASCRIPT,
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

/** Content type from a file name; `application/octet-stream` for anything unlisted. */
export function contentTypeFor(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
