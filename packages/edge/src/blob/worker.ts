import { logError } from './logger.ts';

/**
 * The blob Worker: what the edge reads out of the artifacts bucket by content, answered through
 * this Worker's own Workers Cache.
 *
 * Two kinds of object, each stored under a hash of its own bytes:
 *
 * - `GET /<sha256>`: a file a build shipped (`blobs/<sha256>`) — a `_next/static` chunk, a
 *   stylesheet, a `public/` file, an image's source. Kept for a year and `immutable`, as the edge
 *   itself serves a hashed file.
 * - `GET /manifests/<id>`: a manifest's durable copy (`manifests/<id>.json`), which the edge reads
 *   when its data center's KV has not got the manifest yet or cannot be read. The id is the
 *   SHA-256 of the manifest's bytes. Kept for a day: a manifest is a project's route table, and a
 *   host that deletes a project's copies should do so no sooner than a day after it took the
 *   project's pointer down, so that no copy held here outlives the ones it was read from.
 *
 * Nothing but the path decides an answer, which is what makes the cache's key — the path, and not
 * the host — all the key there needs to be. A query string is refused rather than ignored, so one
 * object is never cached under two names.
 *
 * A range is the cache's to cut: Workers Cache takes `Range` off a request before this Worker sees
 * it, keeps the whole object, and answers the caller 206 with the part. Where nothing stands in
 * front of this Worker — `wrangler dev`, the tests — it answers one range itself, so the edge is
 * given the same answer either way.
 */

interface BlobEnv {
  readonly ARTIFACTS: R2Bucket;
}

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_NOT_MODIFIED = 304;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_RANGE_NOT_SATISFIABLE = 416;
const HTTP_SERVICE_UNAVAILABLE = 503;

const BLOB_PATH = /^\/(?<hash>[\da-f]{64})$/u;
const MANIFEST_PATH = /^\/manifests\/(?<hash>[\da-f]{64})$/u;
/** One range of bytes; several, or another unit, are answered with the whole object, as allowed. */
const SINGLE_BYTE_RANGE = /^bytes=(?<start>\d*)-(?<end>\d*)$/u;

const ONE_YEAR_SECONDS = 31_536_000;
const ONE_DAY_SECONDS = 86_400;
const BLOB_CACHE_CONTROL = `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
const MANIFEST_CACHE_CONTROL = `public, max-age=${ONE_DAY_SECONDS}`;
/** Anything that is not the object: never kept, so an object stored afterwards is found at once. */
const NO_STORE = 'no-store';
const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/** What a path names in the bucket, and how long an answer for it may be kept. */
interface Stored {
  readonly key: string;
  /** The hash the object is stored under, which is its entity tag as well. */
  readonly hash: string;
  readonly cacheControl: string;
}

type RangeAnswer =
  | { readonly kind: 'whole' }
  | { readonly kind: 'part'; readonly offset: number; readonly length: number }
  | { readonly kind: 'unsatisfiable' };

const WHOLE: RangeAnswer = { kind: 'whole' };
const UNSATISFIABLE: RangeAnswer = { kind: 'unsatisfiable' };

function storedAt(url: URL): Stored | undefined {
  if (url.search !== '') {
    return undefined;
  }
  const blob = BLOB_PATH.exec(url.pathname)?.groups?.['hash'];
  if (blob !== undefined) {
    return { key: `blobs/${blob}`, hash: blob, cacheControl: BLOB_CACHE_CONTROL };
  }
  const manifest = MANIFEST_PATH.exec(url.pathname)?.groups?.['hash'];
  if (manifest !== undefined) {
    return {
      key: `manifests/${manifest}.json`,
      hash: manifest,
      cacheControl: MANIFEST_CACHE_CONTROL,
    };
  }
  return undefined;
}

function refusal(status: number, headers: Readonly<Record<string, string>> = {}): Response {
  return new Response(null, { status, headers: { 'cache-control': NO_STORE, ...headers } });
}

function entityHeaders(stored: Stored, object: R2Object): Headers {
  return new Headers({
    'content-type': object.httpMetadata?.contentType ?? DEFAULT_CONTENT_TYPE,
    'cache-control': stored.cacheControl,
    etag: `"${stored.hash}"`,
    'accept-ranges': 'bytes',
  });
}

/**
 * An answer with bytes, which says how many. The cache cuts a range out of an entry only when the
 * entry says how long it is: kept without a length, a range asked of it comes back as the whole
 * object, and the edge would read a large file from its first byte to reach the part it wants. The
 * runtime sends the length a body has, not one set on its headers by hand, so the bytes go through
 * a `FixedLengthStream` of the size they are; a body that ends short of it, or runs past it, errors
 * rather than being kept. The header says the same to whoever reads the answer in-process.
 */
function withBytes(
  body: ReadableStream,
  length: number,
  init: { readonly status: number; readonly headers: Headers },
): Response {
  const fixed = new FixedLengthStream(length);
  void body.pipeTo(fixed.writable).catch(carriedByTheBody);
  init.headers.set('content-length', String(length));
  return new Response(fixed.readable, init);
}

/** A pipe's rejection, which the stream it fed carries to whoever reads the answer. */
function carriedByTheBody(): void {
  // Nothing more to do: a source that failed errored the stream the answer is read from, and a
  // reader that cancelled has stopped reading.
}

/** Weakly (RFC 9110 §13.1.2): the tag is the hash, so any spelling of it names these bytes. */
function validatorMatches(request: Request, tag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (header === null) {
    return false;
  }
  const answering = new Set(['*', `W/${tag}`, tag]);
  return header.split(',').some((value) => answering.has(value.trim()));
}

/** The one range a `Range` header asks for, against an object of `size` bytes (RFC 9110 §14.1). */
function rangeOf(header: string, size: number): RangeAnswer {
  const groups = SINGLE_BYTE_RANGE.exec(header.trim())?.groups;
  const start = groups?.['start'] ?? '';
  const end = groups?.['end'] ?? '';
  if (start === '' && end === '') {
    return WHOLE;
  }
  if (start === '') {
    // The last N bytes; an empty object has no last byte, whatever N is.
    const suffix = Number(end);
    return suffix === 0 || size === 0
      ? UNSATISFIABLE
      : { kind: 'part', offset: Math.max(0, size - suffix), length: Math.min(suffix, size) };
  }
  const first = Number(start);
  const last = end === '' ? size - 1 : Math.min(Number(end), size - 1);
  return first >= size || first > last
    ? UNSATISFIABLE
    : { kind: 'part', offset: first, length: last - first + 1 };
}

/**
 * An answer that has to know the object before it reads a byte of it: a validator it may still
 * answer to — which is how the cache revalidates what it holds — or a range, which is taken
 * against the object's size.
 */
async function answerAfterHead(
  request: Request,
  bucket: R2Bucket,
  stored: Stored,
  range: string | null,
): Promise<Response> {
  const head = await bucket.head(stored.key);
  if (head === null) {
    return refusal(HTTP_NOT_FOUND);
  }
  const headers = entityHeaders(stored, head);
  if (validatorMatches(request, headers.get('etag') ?? '')) {
    return new Response(null, { status: HTTP_NOT_MODIFIED, headers });
  }
  const part = range === null ? WHOLE : rangeOf(range, head.size);
  if (part.kind === 'unsatisfiable') {
    return refusal(HTTP_RANGE_NOT_SATISFIABLE, { 'content-range': `bytes */${head.size}` });
  }
  const object =
    part.kind === 'whole'
      ? await bucket.get(stored.key)
      : await bucket.get(stored.key, { range: { offset: part.offset, length: part.length } });
  // Gone between the two reads: nothing a content-addressed bucket does, but not a 500 either.
  if (object === null) {
    return refusal(HTTP_NOT_FOUND);
  }
  if (part.kind === 'whole') {
    return withBytes(object.body, head.size, { status: HTTP_OK, headers });
  }
  const last = part.offset + part.length - 1;
  headers.set('content-range', `bytes ${part.offset}-${last}/${head.size}`);
  return withBytes(object.body, part.length, { status: HTTP_PARTIAL_CONTENT, headers });
}

/**
 * `HEAD` is answered as `GET` is, body and all. The cache keeps one entry for the two methods, and
 * an answer without the bytes must never be the one it keeps; the body of an answer to `HEAD` is
 * dropped on the way out whoever asked.
 */
async function answer(request: Request, bucket: R2Bucket, stored: Stored): Promise<Response> {
  const range = request.headers.get('range');
  if (range !== null || request.headers.has('if-none-match')) {
    return answerAfterHead(request, bucket, stored, range);
  }
  const object = await bucket.get(stored.key);
  if (object === null) {
    return refusal(HTTP_NOT_FOUND);
  }
  return withBytes(object.body, object.size, {
    status: HTTP_OK,
    headers: entityHeaders(stored, object),
  });
}

async function fetchBlob(request: Request, env: BlobEnv): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refusal(HTTP_METHOD_NOT_ALLOWED, { allow: 'GET, HEAD' });
  }
  const stored = storedAt(new URL(request.url));
  if (stored === undefined) {
    return refusal(HTTP_NOT_FOUND);
  }
  try {
    return await answer(request, env.ARTIFACTS, stored);
  } catch (error) {
    // Not kept: the next request asks the bucket again, and the edge reads it directly meanwhile.
    logError('artifacts read failed', {
      key: stored.key,
      detail: error instanceof Error ? error.message : String(error),
    });
    return refusal(HTTP_SERVICE_UNAVAILABLE);
  }
}

const worker = { fetch: fetchBlob } satisfies ExportedHandler<BlobEnv>;

export default worker;
