import { sha256Hex } from '@stayingupwind/core/artifact';
import { MAX_MANIFEST_BYTES } from '@stayingupwind/core/manifest';
import { readBoundedBody, releaseStream, withDeadline } from '@stayingupwind/core/util';

import type { BlobWorker } from '../edge-runtime.ts';
import { logWarn } from '../observability/logger.ts';

/**
 * Reads of the artifacts bucket through the blob Worker (`./blob-worker`).
 *
 * That Worker answers by content — a shipped file under its hash, a manifest's durable copy under
 * its id — and its Workers Cache is consulted before it runs: in the data center this edge is
 * running in, then in an upper tier every data center asks on a miss, with concurrent misses for
 * one path collapsed into one read of the bucket. A file one data center has read is the next
 * one's hit, where each data center's first request, and every long-tail miss, would otherwise
 * cross to the bucket's region for a page's render-blocking CSS and JavaScript.
 *
 * The bucket stays the authority. Where no binding is bound, or the Worker answers with anything
 * but the bytes asked for, these return nothing and the caller reads the bucket itself: a Worker
 * that is down, or deployed wrong, costs a read and not a file.
 */

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_NOT_FOUND = 404;
const SHA256_HEX = /^[\da-f]{64}$/u;
const CONTENT_RANGE = /^bytes (?<start>\d+)-(?<end>\d+)\/(?<size>\d+)$/u;
/** What `cf-cache-status` may say, as far as it is repeated on the edge's own answer. */
const CACHE_STATUS = /^[a-z]{1,16}$/u;
const WEAK_PREFIX = /^W\//u;
/**
 * The largest object Workers Cache keeps: every Worker is held to the Free plan's 512 MB for now,
 * however a megabyte is counted there. Past it nothing is kept, and what the cache does with a
 * range of an object it cannot keep is not written down — at worst, read the whole of it for every
 * part — so such a file is read from the bucket directly, a range as a range, as it always was.
 */
const CACHEABLE_BYTES = 500_000_000;
/**
 * How long the blob Worker has to answer before the bucket is read in its place. Its answer is the
 * headers of a hit, or of a miss it read the bucket for, upper tier and all; the bytes stream after.
 * A binding that took the request and never answers would otherwise hold the request for as long as
 * it is let run, the authoritative bucket never asked.
 */
const BLOB_WORKER_DEADLINE_MS = 2000;
/**
 * How long a manifest's body has, once the Worker has answered, and how long it may go quiet: a
 * manifest is at most `MAX_MANIFEST_BYTES`, and a cached one streams from this data center's cache.
 * A body that stalls would otherwise hold the lookup past every deadline, the bucket never asked.
 */
const MANIFEST_BODY_BUDGET_MS = 2000;

/** An image's cancellable storage read, counting only the requests it has actually started. */
export interface FileReadProgress {
  readonly signal: AbortSignal;
  requests: number;
}

/** One range of a file's bytes, as offsets into it. */
export interface BlobRange {
  readonly start: number;
  /** Inclusive. */
  readonly end: number;
}

/**
 * What asking the blob Worker for a file came to: its bytes; an answer without them, after which
 * the bucket is read; or no question at all — no binding, or a file past the cache's size.
 */
export type ShippedRead =
  | {
      readonly kind: 'bytes';
      readonly body: ReadableStream<Uint8Array>;
      /**
       * `true` when the body is the range asked for; `false` when it is the whole file, which the
       * caller cuts itself.
       */
      readonly partial: boolean;
      /** What the Worker's cache said of the read (`cf-cache-status`, lower-cased), if it said. */
      readonly cache: string | undefined;
    }
  | { readonly kind: 'unanswered' }
  | { readonly kind: 'unasked' };

const UNANSWERED: ShippedRead = { kind: 'unanswered' };
const UNASKED: ShippedRead = { kind: 'unasked' };

/** The file a manifest names, as far as a read of it needs. */
interface ShippedFile {
  readonly sha256: string;
  readonly byteLength: number;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ask(
  blobWorker: BlobWorker,
  path: string,
  headers: Readonly<Record<string, string>> = {},
  signal?: AbortSignal,
): Promise<Response | undefined> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let pending: Promise<Response> | undefined;
  try {
    pending = blobWorker(path, {
      headers,
      signal:
        signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal]),
    });
    return await withDeadline(pending, BLOB_WORKER_DEADLINE_MS, 'blob worker');
  } catch (error) {
    // Past the deadline the call is let go, so an answer that comes after leaves nothing open.
    controller.abort(error);
    if (signal !== undefined && pending !== undefined) {
      void pending
        .then((response) => {
          releaseStream(response.body, 'image source abandoned');
          return null;
        })
        .catch(() => {
          // An abandoned image's blob fetch usually rejects instead of answering late.
        });
    }
    signal?.throwIfAborted();
    logWarn('blob worker unreachable', { path, detail: errorDetail(error) });
    return undefined;
  }
}

/**
 * Whether a 206 is the part asked for, of a file the size the manifest says, and as long as the
 * part: the cache says how long a part it cut is, and a part that says nothing of it, or says
 * another length, is not taken — its bytes would go out as the range, short or over.
 */
function spans(response: Response, range: BlobRange, size: number): boolean {
  const groups = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '')?.groups;
  const length = response.headers.get('content-length');
  return (
    groups !== undefined &&
    Number(groups['start']) === range.start &&
    Number(groups['end']) === range.end &&
    Number(groups['size']) === size &&
    length !== null &&
    Number(length) === range.end - range.start + 1
  );
}

/**
 * Whether the Worker's answer says it is the file: the Worker tags what it serves with the hash it
 * is stored under (`./blob-worker`), which for a file is its digest, quoted, and weakly or not.
 */
function namesTheFile(response: Response, file: Pick<ShippedFile, 'sha256'>): boolean {
  const tag = response.headers.get('etag')?.replace(WEAK_PREFIX, '');
  return tag === `"${file.sha256}"`;
}

/**
 * Whether a whole answer is as long as the file, where it says how long it is. An encoded answer's
 * length is the encoding's, which comes off as the body is read.
 */
function hasLength(response: Response, byteLength: number): boolean {
  const length = response.headers.get('content-length');
  return (
    length === null || response.headers.has('content-encoding') || Number(length) === byteLength
  );
}

function cacheStatusOf(response: Response): string | undefined {
  const status = response.headers.get('cf-cache-status')?.toLowerCase();
  return status !== undefined && CACHE_STATUS.test(status) ? status : undefined;
}

/**
 * Anything but the bytes: the object's absence, a failure, an answer that is not the one asked for.
 * The bucket is asked next, and says which it was. An absence is a fact about the deployment,
 * which the caller reports once the bucket has said it too; anything else is the Worker's.
 */
function letGo(response: Response, path: string): void {
  releaseStream(response.body, 'blob worker answered without the bytes');
  if (response.status !== HTTP_NOT_FOUND) {
    logWarn('blob worker answered without the bytes', { path, status: response.status });
  }
}

/**
 * Whether a read of the file goes to the blob Worker before the bucket: there is one, and its cache
 * would keep the file. A file past what it keeps is read from the bucket alone.
 */
export function asksBlobWorker(
  blobWorker: BlobWorker | undefined,
  file: Pick<ShippedFile, 'byteLength'>,
): boolean {
  return blobWorker !== undefined && file.byteLength <= CACHEABLE_BYTES;
}

/**
 * A shipped file's bytes through the blob Worker: the whole file, or the one range asked for —
 * which the cache cuts from the whole file it keeps. Anything else is for the bucket to answer.
 */
export async function readShippedFile(
  blobWorker: BlobWorker | undefined,
  file: ShippedFile,
  range: BlobRange | undefined,
  progress?: FileReadProgress,
): Promise<ShippedRead> {
  if (blobWorker === undefined || !asksBlobWorker(blobWorker, file)) {
    return UNASKED;
  }
  progress?.signal.throwIfAborted();
  if (progress !== undefined) {
    progress.requests += 1;
  }
  const path = `/${file.sha256}`;
  const response = await ask(
    blobWorker,
    path,
    range === undefined ? {} : { range: `bytes=${range.start}-${range.end}` },
    progress?.signal,
  );
  if (response === undefined) {
    return UNANSWERED;
  }
  const cache = cacheStatusOf(response);
  const body = response.body as ReadableStream<Uint8Array> | null;
  // Bytes the Worker does not say are this file's — a binding pointed elsewhere, a cached answer of
  // another object — would go out under this file's tag and length, for a client to keep. The
  // bucket is read instead.
  if (body !== null && namesTheFile(response, file)) {
    if (response.status === HTTP_OK && hasLength(response, file.byteLength)) {
      return { kind: 'bytes', body, partial: false, cache };
    }
    if (
      range !== undefined &&
      response.status === HTTP_PARTIAL_CONTENT &&
      spans(response, range, file.byteLength)
    ) {
      return { kind: 'bytes', body, partial: true, cache };
    }
  }
  letGo(response, path);
  return UNANSWERED;
}

/**
 * A manifest's durable copy through the blob Worker, by an id that is its digest; `undefined` for
 * the bucket to be read instead. An id that is not a digest — none a deploy writes — is never asked
 * for, since the Worker keeps nothing under a name that does not say what it holds.
 *
 * Taken only when it is the bytes the id names. Whatever the bucket holds under an id is the
 * manifest, and is read as such however it reads; the Worker's answer is a copy of that, kept a
 * day across its own deploys, and a copy that has come to say something else — a version of the
 * Worker that read the wrong key, say — would otherwise be parsed, and held, as the manifest.
 */
export async function readManifestCopy(
  blobWorker: BlobWorker | undefined,
  manifestId: string,
): Promise<ArrayBuffer | undefined> {
  if (blobWorker === undefined || !SHA256_HEX.test(manifestId)) {
    return undefined;
  }
  const path = `/manifests/${manifestId}`;
  const response = await ask(blobWorker, path);
  if (response === undefined) {
    return undefined;
  }
  if (response.status !== HTTP_OK) {
    letGo(response, path);
    return undefined;
  }
  const bytes = await manifestBody(response, path);
  if (bytes === undefined) {
    return undefined;
  }
  if ((await sha256Hex(bytes)) !== manifestId) {
    logWarn('blob worker answered with other bytes', { path });
    return undefined;
  }
  return bytes.buffer as ArrayBuffer;
}

/**
 * The body of a manifest the Worker answered with, within its budget and the size no manifest
 * passes; `undefined`, and the body let go, past either.
 */
async function manifestBody(response: Response, path: string): Promise<Uint8Array | undefined> {
  try {
    const body = await readBoundedBody(response.body as ReadableStream<Uint8Array> | null, {
      limit: MAX_MANIFEST_BYTES,
      stallMs: MANIFEST_BODY_BUDGET_MS,
      budgetMs: MANIFEST_BODY_BUDGET_MS,
    });
    if (body.kind === 'complete') {
      return body.bytes;
    }
    releaseStream(body.body, 'blob worker manifest too large');
    logWarn('blob worker manifest too large', { path });
  } catch (error) {
    logWarn('blob worker body failed', { path, detail: errorDetail(error) });
  }
  return undefined;
}
