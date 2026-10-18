import {
  concatBytes,
  isDeadlineError,
  releaseStream,
  withDeadline,
} from '@stayingupwind/core/util';
import {
  PREFETCH_BLOB_PATH,
  PREFETCH_INTERNAL_ORIGIN,
  PREFETCH_SERVICE_BINDING,
} from '@stayingupwind/host/bindings';
import type { BundleBlobReader, BundleBlobsInit } from '@stayingupwind/runtime/bundle-blobs';

import { FUNCTION_READ_BYTES, functionReadBudget } from './read-budget.ts';

/**
 * One blob of a deployment's own bundle, read from the Worker that keeps the build's outputs.
 *
 * The adapter can leave a build's prefetch segments out of the Function — a large share of a large
 * application's bundle — and the edge serves those prefetches from the artifacts the deployment was
 * published with. This is how the Function answers one the edge could not: a middleware that
 * failed, an edge with no manifest to read, a request that reached the Worker without the edge
 * serving the prefetch at all. The same reader also answers an unshipped static file a rewrite
 * lands on. Shipped bytes and artifacts served by the edge do not pass through this fallback.
 *
 * This optional fallback accepts body bytes up to 32 MiB, sharing the Function isolate's existing
 * artifact/record read room. Its native buffer has one extra sentinel byte. A larger bundle blob still deploys and can be shipped or served by
 * the edge; this fallback fails, which the runtime logs and treats as a missing blob. Its claim
 * covers the owned read, not every response that may retain returned bytes afterward.
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

/** Workers adds this native operation; other hosts may expose only the standard BYOB reader. */
type NativeRead = (
  this: ReadableStreamBYOBReader,
  min: number,
  view: Uint8Array<ArrayBuffer>,
) => Promise<ReadableStreamReadResult<Uint8Array>>;

type ReadResult = Uint8Array | ReadableStreamReadResult<Uint8Array>;
interface BodyRead {
  readonly reader: ReadableStreamDefaultReader<Uint8Array> | ReadableStreamBYOBReader;
  readonly pending: Promise<ReadResult>;
}
const WRONG_LENGTH = 'bundle blob length mismatch';

function nativeReadOf(reader: ReadableStreamBYOBReader): NativeRead | undefined {
  const read: unknown = Reflect.get(reader, 'readAtLeast');
  return typeof read === 'function' ? (read as NativeRead) : undefined;
}

/** Only non-byte adapter streams take this bounded chunk path; native service bodies do not. */
async function otherBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return concatBytes(parts);
    total += value.byteLength;
    if (total > limit) throw new Error(WRONG_LENGTH);
    parts.push(value);
  }
}

/** One sentinel byte distinguishes exact EOF from a larger answer without reading it whole. */
function beginBody(body: ReadableStream<Uint8Array>, limit: number): BodyRead {
  let byob: ReadableStreamBYOBReader | undefined;
  try {
    byob = body.getReader({ mode: 'byob' });
  } catch {
    // A custom host may answer with a non-byte stream; keep that path bounded too.
  }
  if (byob !== undefined) {
    const read = nativeReadOf(byob);
    if (read !== undefined) {
      const capacity = limit + 1;
      try {
        return { reader: byob, pending: read.call(byob, capacity, new Uint8Array(capacity)) };
      } catch (error) {
        releaseStream(byob, 'bundle blob reader not started');
        byob.releaseLock();
        throw error;
      }
    }
    byob.releaseLock();
  }
  const reader = body.getReader();
  return { reader, pending: otherBytes(reader, limit) };
}

/** A declared bundle size, held to the isolate's existing whole-read ceiling. */
function readLimit(expected: number | undefined): number {
  if (expected === undefined) return FUNCTION_READ_BYTES;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > FUNCTION_READ_BYTES) {
    throw new Error('bundle blob exceeds the Function read budget');
  }
  return expected;
}

/** The blob's bytes, with room held until its owned consumer has actually stopped. */
async function blobOf(
  service: PrefetchService,
  request: Request,
  expected: number | undefined,
): Promise<Uint8Array | undefined> {
  const limit = readLimit(expected);
  const room = functionReadBudget();
  // The extra byte is the native reader's sentinel; the ceiling needs one byte beyond its claim.
  const release = room.takeAtOnce(limit + 1) ?? (await room.take(limit + 1, request.signal));
  let reading: BodyRead | undefined;
  const abort = (): void => {
    releaseStream(reading?.reader, 'bundle blob read abandoned');
  };
  try {
    const answer = await service.fetch(request);
    if (request.signal.aborted) {
      releaseStream(answer.body, 'bundle blob arrived after its deadline');
      request.signal.throwIfAborted();
    }
    if (!answer.ok) {
      releaseStream(answer.body, 'bundle blob not served');
      if (answer.status === HTTP_NOT_FOUND) return undefined;
      throw new Error(`the prefetch Worker answered ${answer.status} for a bundle blob`);
    }
    if (answer.body === null) {
      if (expected !== undefined && expected !== 0) throw new Error(WRONG_LENGTH);
      return new Uint8Array();
    }
    reading = beginBody(answer.body, limit);
    request.signal.addEventListener('abort', abort, { once: true });
    const result = await reading.pending;
    request.signal.throwIfAborted();
    const bytes = result instanceof Uint8Array ? result : (result.value ?? new Uint8Array());
    if (bytes.byteLength > limit || (expected !== undefined && bytes.byteLength !== expected)) {
      throw new Error(WRONG_LENGTH);
    }
    return bytes;
  } catch (error) {
    abort();
    throw error;
  } finally {
    request.signal.removeEventListener('abort', abort);
    try {
      reading?.reader.releaseLock();
    } finally {
      release();
    }
  }
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
  return async (sha256, expectedByteLength) => {
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
        blobOf(service, new Request(url, { signal: controller.signal }), expectedByteLength),
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
