import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createGzip } from 'node:zlib';

import type { FunctionModule } from '@stayingupwind/core/bundle';

import type { FunctionSize } from './dependencies.ts';

/**
 * What the Function weighs, as Cloudflare weighs it: the modules it will be uploaded with, through
 * one gzip stream. One stream rather than one per module, because that is how the upload is
 * compressed, and a `.wasm` next to a bundle of the same library compresses with it.
 */
export async function functionSize(
  outDir: string,
  modules: readonly FunctionModule[],
): Promise<FunctionSize> {
  // What each module weighs is already on its blob; only the compressed size needs the bytes.
  const bytes = modules.reduce((total, module) => total + module.blob.byteLength, 0);
  const blobs = path.join(outDir, 'blobs');
  const gzip = createGzip();
  let gzipBytes = 0;
  let failure: unknown;
  gzip.on('data', (chunk: Buffer) => {
    gzipBytes += chunk.byteLength;
  });
  // A stream with no `error` listener takes the process down with it, and this one spends most of
  // its life waiting on a read; `once` only listens while it is awaited.
  gzip.on('error', (error: unknown) => {
    failure ??= error;
  });
  try {
    for (const module of modules) {
      const content = await readFile(path.join(blobs, module.blob.sha256));
      // An error raised while the read was awaited was only saved, and a stream that has failed
      // neither drains nor ends: waiting for either would never return.
      if (failure !== undefined) {
        break;
      }
      if (!gzip.write(content)) {
        await once(gzip, 'drain');
      }
    }
    if (failure === undefined) {
      gzip.end();
      await once(gzip, 'end');
    }
  } finally {
    gzip.destroy();
  }
  if (failure !== undefined) {
    throw new Error(`@stayingupwind/adapter: could not measure the Function`, { cause: failure });
  }
  return { bytes, gzipBytes };
}
