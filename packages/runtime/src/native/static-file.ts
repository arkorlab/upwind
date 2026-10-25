import type { Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { StaticFile } from '@stayingupwind/core/bundle';

import type { RoutedInput } from '../serve.ts';
import type { Store } from '../store.ts';

const DIGEST = /^[a-f\d]{64}$/u;
const HTTP_NO_CONTENT = 204;
const HTTP_RESET_CONTENT = 205;
const HTTP_NOT_MODIFIED = 304;
const BODYLESS = new Set([HTTP_NO_CONTENT, HTTP_NOT_MODIFIED, HTTP_RESET_CONTENT]);

function requireMatchingFile(info: Stats, file: StaticFile): void {
  if (!info.isFile() || info.size !== file.blob.byteLength) {
    throw new Error('upwind: native static blob differs from its manifest');
  }
}

function responseHeaders(file: StaticFile): HeadersInit {
  return {
    'content-type': file.blob.contentType,
    'cache-control': file.immutable
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=0, must-revalidate',
  };
}

/**
 * Called only after the shared router and middleware selected this build-owned StaticFile.
 * A request pathname never becomes a filesystem path. The body stays on disk until consumed,
 * and cancelling its Web stream destroys the Node stream and closes the file descriptor.
 */
export async function staticFileResponse(
  input: RoutedInput,
  _store: Store,
  file: StaticFile,
  status: number,
): Promise<Response | undefined> {
  if (!DIGEST.test(file.blob.sha256)) throw new Error('upwind: invalid native bundle blob digest');
  input.request.signal.throwIfAborted();
  const root =
    typeof __ARKOR_BUNDLE_ROOT__ === 'undefined' ? import.meta.dirname : __ARKOR_BUNDLE_ROOT__;
  const location = path.join(root, 'blobs', file.blob.sha256);
  const headers = responseHeaders(file);
  if (input.request.method === 'HEAD' || BODYLESS.has(status)) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only a selected build-owned digest names this file.
      const info = await stat(location);
      requireMatchingFile(info, file);
      return new Response(null, { status, headers });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  let handle;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only a selected build-owned digest names this file.
    handle = await open(location, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    requireMatchingFile(info, file);
    input.request.signal.throwIfAborted();
    const stream = handle.createReadStream({ autoClose: true, signal: input.request.signal });
    try {
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
        status,
        headers,
      });
    } catch (error) {
      stream.destroy();
      throw error;
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
}
