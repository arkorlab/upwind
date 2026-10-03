/**
 * One blob of **this deployment's own bundle** from the host that kept it, for a build whose
 * Function was not given it (`AdapterOptions.unshippedOutputs`).
 *
 * The host module may export `createBundleBlobReader` beside `createCacheHost`; `function.ts` is
 * where that export is read, as the other generated modules are, which keeps this file importable
 * by a host — nothing here resolves `arkor:cache-host`.
 *
 * Deliberately not part of `CacheHost`. A bundle blob is not a cache entry: it was written once by
 * the build, it never expires and no tag withdraws it — and a deployment the host gave no cache
 * still has a bundle, so a reader that lived on the cache would be absent exactly where the cache
 * is, for a Function that needs the bytes just as much. The two know nothing of each other.
 *
 * Addressed by content, which is what makes it answerable at all: a caller can ask only for bytes
 * whose hash it already holds, and a Function's bundle names its own.
 */

/** The bytes of one blob, or `undefined` where the host does not hold it. */
export type BundleBlobReader = (sha256: string) => Promise<Uint8Array | undefined>;

/** What the host is handed to find its own way to wherever the build's outputs are kept. */
export interface BundleBlobsInit {
  readonly env: Record<string, unknown> | undefined;
}

/**
 * What a host module exports as `createBundleBlobReader` — or does not export at all, which is a
 * build that ships every blob. The optionality is in the type so that the declaration of
 * `arkor:cache-host` names one type and writes no union there: the type-aware lint reads that file
 * with a program of its own, which resolves neither this module nor a union mentioning it.
 */
export type BundleBlobsExport =
  | ((init: BundleBlobsInit) => BundleBlobReader | undefined)
  | undefined;

function log(message: string, fields: Record<string, string | number> = {}): void {
  // The Function's own log; nothing else records what its bundle reads did.
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: 'warn', msg: `next-runtime: ${message}`, ...fields }));
}

/**
 * A failure in as many words as it has, and never a failure of its own: a rejection need not be an
 * `Error`, and one that is an object with no prototype throws when it is read as a string — which
 * would turn a prefetch nobody can serve into a 500 (`failureMessage` in `function.ts`, for the
 * same reason).
 */
function detail(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error);
  } catch {
    return '';
  }
}

/**
 * The host's reader, held to what the runtime does with a failure; `undefined` for a host that
 * exports none or reaches nothing, which is a build that ships every blob.
 *
 * **Nothing here fails a request.** A factory that throws — and it is handed the Function's whole
 * environment, so it may — leaves a Function with no reader rather than one that answers 500 to
 * every route, the routes that read no blob included. A read that throws is answered `undefined`
 * the same way: to the caller a host that cannot answer and a blob that was never there mean the
 * same thing, the segment is served by nobody and the client navigates instead of prefetching.
 * Both are logged, because a host that offers this and is failing would otherwise be
 * indistinguishable from one that never offered it.
 *
 * Nothing is memoised. A read happens once per request, on a path the host could not serve, and a
 * cache of a build's bytes in an isolate serving every other request is not worth that; the host
 * is also the one that knows how to cache it.
 */
export function bundleBlobReader(
  create: BundleBlobsExport,
  init: BundleBlobsInit,
): BundleBlobReader | undefined {
  let made: BundleBlobReader | undefined;
  try {
    made = create?.(init);
  } catch (error) {
    log('bundle blob reader not made', { detail: detail(error) });
    return undefined;
  }
  if (made === undefined) {
    return undefined;
  }
  const read = made;
  return async (sha256) => {
    try {
      return await read(sha256);
    } catch (error) {
      log('bundle blob not read', { sha256, detail: detail(error) });
      return;
    }
  };
}
