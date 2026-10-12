import { isDeadlineError, withDeadline } from '@stayingupwind/core/util';
import {
  PREFETCH_BLOB_PATH,
  PREFETCH_INTERNAL_ORIGIN,
  PREFETCH_SERVICE_BINDING,
} from '@stayingupwind/host/bindings';
import type { BundleBlobReader, BundleBlobsInit } from '@stayingupwind/runtime/bundle-blobs';

/**
 * One blob of a deployment's own bundle, read from the Worker that keeps the build's outputs.
 *
 * The adapter can leave a build's prefetch segments out of the Function — a large share of a large
 * application's bundle — and the edge serves those prefetches from the artifacts the deployment was
 * published with. This is how the Function answers one the edge could not: a middleware that
 * failed, an edge with no manifest to read, a request that reached the Worker without the edge
 * serving the prefetch at all. Nothing on a working path comes through here.
 *
 * Beside `createCacheHost` and nothing to do with it (`@stayingupwind/runtime/bundle-blobs`): a
 * bundle blob is not a cache entry, and a deployment given no cache still has a bundle to read.
 */

/** A blob the Worker does not hold. Everything else it says is a failure, and is thrown. */
const HTTP_NOT_FOUND = 404;

/**
 * How long one blob may take, from the request to its last byte. The Worker that keeps the build's
 * outputs reads the blob from R2, and one that answered its headers and then went quiet in the body
 * would hold the Function's answer open until the runtime ended it. What an artifact's copy is
 * given (`COPY_READ_LIMIT_MS`): a prefetch segment is kilobytes, and one this slow is better given
 * up — the client navigates instead of prefetching.
 */
const BLOB_READ_MS = 10_000;

/** The one call a deployment's Worker makes on the prefetch Worker, as its binding takes it. */
interface PrefetchService {
  fetch(request: Request): Promise<Response>;
}

/** The blob's bytes, its body read to the end; `undefined` for one the Worker does not hold. */
async function blobOf(service: PrefetchService, request: Request): Promise<Uint8Array | undefined> {
  const answer = await service.fetch(request);
  if (!answer.ok) {
    if (answer.status === HTTP_NOT_FOUND) {
      // A blob nobody has, which is what the runtime does something sensible with.
      return undefined;
    }
    throw new Error(`the prefetch Worker answered ${answer.status} for a bundle blob`);
  }
  return new Uint8Array(await answer.arrayBuffer());
}

/**
 * The reader for these bindings, or nothing where the deployment was given no `ARKOR_PREFETCH` —
 * which the runtime reads as a blob nobody has, as it does where it is given no reader at all.
 *
 * No token travels with the request, and content addressing is the whole of why: a Function can ask
 * only for a hash its own bundle names, and the prefetch Worker answers no listing and no prefix. A
 * read that fails is thrown rather than swallowed, so the runtime logs it — the difference between
 * a blob that was never there and a Worker that is failing. So is one that runs past
 * `BLOB_READ_MS`, the request under it let go of with it.
 */
export function createBundleBlobReader(init: BundleBlobsInit): BundleBlobReader | undefined {
  const binding = init.env?.[PREFETCH_SERVICE_BINDING];
  if (typeof binding !== 'object' || binding === null) {
    return undefined;
  }
  const service = binding as PrefetchService;
  return async (sha256) => {
    // Encoded, though a bundle's own hashes are hex: the path is what the Worker builds its key
    // from, and a value that could carry a slash would be asking for a key of another shape.
    const url = new URL(
      `${PREFETCH_BLOB_PATH}${encodeURIComponent(sha256)}`,
      PREFETCH_INTERNAL_ORIGIN,
    );
    // The race is what bounds the wait, through the body as well as the headers; the signal is what
    // lets go of the request under it, whatever the binding makes of it.
    const controller = new AbortController();
    try {
      return await withDeadline(
        blobOf(service, new Request(url, { signal: controller.signal })),
        BLOB_READ_MS,
        'bundle blob read',
      );
    } catch (error) {
      if (isDeadlineError(error)) {
        controller.abort(error);
      }
      throw error;
    }
  };
}
