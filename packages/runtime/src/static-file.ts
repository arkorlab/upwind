import type { BlobRef, StaticFile } from '@stayingupwind/core/bundle';

import type { RoutedInput } from './serve.ts';
import type { Store } from './store.ts';

/**
 * A file the manifest names, under `status`: with the bytes the Function carries, or — for one it
 * does not carry, a file under `_next/static` a rewrite of the build's may land on, which the
 * adapter lists for such a build only — with the host's, which keeps every file of the build.
 * `undefined` where neither has it. A `HEAD` is answered with the headers alone, and reads nothing
 * where the host could give the file: the host's bytes are a read of the whole of it.
 */
export async function staticFileResponse(
  input: RoutedInput,
  store: Store,
  file: StaticFile,
  status: number,
): Promise<Response | undefined> {
  const { sha256 } = file.blob;
  if (input.request.method === 'HEAD') {
    const answerable = input.blobs !== undefined || store.tryReadBlob(sha256) !== undefined;
    return answerable ? fileResponse(file, null, status) : undefined;
  }
  const bytes = store.tryReadBlob(sha256) ?? (await fromHost(input, file.blob));
  return bytes === undefined ? undefined : fileResponse(file, bytes, status);
}

function fileResponse(
  file: StaticFile,
  bytes: Uint8Array<ArrayBuffer> | null,
  status: number,
): Response {
  return new Response(bytes, {
    status,
    headers: {
      'content-type': file.blob.contentType,
      'cache-control': file.immutable
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=0, must-revalidate',
    },
  });
}

async function fromHost(
  input: RoutedInput,
  ref: BlobRef,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const bytes = await input.blobs?.(ref.sha256, ref.byteLength);
  return bytes === undefined ? undefined : new Uint8Array(bytes);
}

/**
 * The routed answer, as the host leaves it once routing's headers and a rewrite's status are on it:
 * as it is, here. A host that answers files by the edge's rules has more to say of a refusal it made
 * (`native/static-file.ts`).
 */
export function keptAfterRouting(response: Response): Response {
  return response;
}
