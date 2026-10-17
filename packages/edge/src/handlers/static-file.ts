import {
  type ConfiguredHeaders,
  staticFileStatus,
  type StaticFileEntry,
} from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import {
  EDGE_DEBUG_HEADER,
  EDGE_VALIDATED_HEADER,
  manifestIdPrefix,
  NO_STORE_CACHE_CONTROL,
  NULL_BODY_STATUSES,
  RSC_HEADER,
  RSC_VARY,
} from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import { logWarn } from '../observability/logger.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import { asksBlobWorker, type BlobRange, readShippedFile } from '../preview/blobs.ts';
import type { StaticFileContext } from '../strategies/context.ts';
import { setConfigured } from './configured-headers.ts';
import { applyCspReporting } from './csp-reporting-headers.ts';
import { observeMetric } from './observer.ts';
import {
  keptByNobody,
  mergeScopedMiddlewareHeaders,
  removeSharedCacheOverrides,
  serviceUnavailableResponse,
} from './responses.ts';
import { clientHolds, preconditionFails, requestedRange } from './static-file-conditions.ts';

/**
 * A file the build shipped, served from storage without asking anyone.
 *
 * The manifest names it by content, so what is served is settled before the request is looked at:
 * the same bytes to every visitor, for every deployment that ships the same file. That is what
 * lets the blob Worker's cache hold it under its hash alone (`preview/blobs.ts`), and what lets a
 * file the build marked immutable be cached for a year by everyone downstream. A file that is not
 * immutable — `robots.txt`, a `public/` asset that keeps its name across deployments — is served
 * with its hash as the entity tag and revalidated every time, so a redeploy that changes it is seen
 * at once.
 */

export interface StaticFileInput {
  readonly request: Request;
  readonly pathname: string;
  readonly file: StaticFileEntry;
  readonly edge: StaticFileContext;
  /**
   * What the application's middleware set, when the edge ran it for this file and it let the request
   * on — with the status it gave a rewrite, which an answer of 200 goes out under
   * (`underRewriteStatus`, in `hosted-static-file.ts`).
   */
  readonly middleware?:
    | (Extract<MiddlewareResult, { kind: 'continue' }> & {
        readonly rewriteStatus?: number | undefined;
      })
    | undefined;
  /** The dispatches the middleware took before the file was served, which its metric counts. */
  readonly middlewareDispatches?: number | undefined;
  /** How long the middleware took, where it ran, which its metric reports. */
  readonly middlewareMs?: number | undefined;
  /** What `next.config`'s header rules set on this request, as the application would have. */
  readonly configured?: ConfiguredHeaders | undefined;
}

/**
 * What `cf-cache-status` says of a body Workers Cache served from what it keeps: a hit, and the
 * last answer it kept, served while it fetches a newer one (`stale`, `updating`) or once the origin
 * said it still stands (`revalidated`). Anything else was read from the bucket on the way.
 */
const SERVED_FROM_CACHE: ReadonlySet<string> = new Set(['hit', 'revalidated', 'stale', 'updating']);
const HTTP_OK = 200;
const NOT_MODIFIED_STATUS = 304;
const CONTENT_LENGTH = 'content-length';
const PARTIAL_CONTENT_STATUS = 206;
const PRECONDITION_FAILED_STATUS = 412;
const RANGE_NOT_SATISFIABLE_STATUS = 416;
const ONE_YEAR_SECONDS = 31_536_000;
const IMMUTABLE_CACHE_CONTROL = `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
const REVALIDATE_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
const CONTENT_RANGE = 'content-range';
const ACCEPT_RANGES = 'accept-ranges';
/** What describes the bytes on the wire, which no rule may say otherwise about. */
const ENTITY_HEADERS: ReadonlySet<string> = new Set([
  ACCEPT_RANGES,
  CONTENT_LENGTH,
  CONTENT_RANGE,
  'etag',
]);
/**
 * A file the middleware had a say on is what one visitor was allowed; a shared cache must not hand
 * it to the next, however immutable the bytes. The visitor's own cache may keep it, revalidated.
 *
 * Unless the middleware wrote a `Cache-Control` itself: that is the author saying what this file's
 * answer may be held as, for this request, and it stands as it would in the application
 * (`no-duplicate-headers-middleware`). A cookie beside it takes the decision back — a response
 * carrying one is one visitor's whatever else it says.
 */
const GATED_CACHE_CONTROL = 'private, max-age=0, must-revalidate';

/**
 * What the middleware said itself about holding this answer, where it said anything and nothing
 * beside it makes the answer one visitor's. Read here rather than merged: a middleware's
 * `Cache-Control` is not merged into any response (`UNMERGEABLE_RESPONSE_HEADERS`), since for a
 * document it is the edge's to write — and for a file the edge writes it here, last, which is the
 * one place it can stand.
 */
function middlewareCacheControl(
  middleware: Extract<MiddlewareResult, { kind: 'continue' }>,
): string | undefined {
  return middleware.responseHeaders.get('cache-control') ?? undefined;
}

function blobKey(sha256: string): string {
  return `blobs/${sha256}`;
}

function etagOf(file: StaticFileEntry): string {
  return `"${file.sha256}"`;
}

/**
 * The entity tag the answer carries, as `fileHeaders` leaves it: the file's own, or one the
 * middleware set in its place — which is what Next.js serves the file under as well, since `send`
 * keeps an `ETag` already on the response. A validator is judged against this one; a client can
 * only hold the tag a response gave it.
 */
function entityTagOf(input: StaticFileInput): string {
  return input.middleware?.responseHeaders.get('etag') ?? etagOf(input.file);
}

/**
 * What the edge sets `cache-control` to over the file's own and a rule's: `unshared` where that is
 * the edge's word that no shared cache is to keep the answer, rather than the middleware's own.
 */
interface CacheControlOverride {
  readonly value: string;
  readonly unshared: boolean;
}

const UNSHARED_NO_STORE: CacheControlOverride = { value: NO_STORE_CACHE_CONTROL, unshared: true };
const UNSHARED_GATED: CacheControlOverride = { value: GATED_CACHE_CONTROL, unshared: true };

/**
 * Validation must never leave a response in a shared cache; live traffic gets the file's own. A
 * project whose delivery is private has nothing it serves kept by anybody (`privateDelivery`), a
 * file no more than a document (`documentCacheControl`): a browser or a cache between could hand a
 * year's immutable file back without the host being asked — to a visitor it no longer lets
 * through, or to one it never did.
 */
function cacheControlFor(
  input: StaticFileInput,
  answered: Headers,
): CacheControlOverride | undefined {
  if (input.edge.validated || input.edge.privateDelivery) {
    return UNSHARED_NO_STORE;
  }
  if (input.middleware !== undefined) {
    // What the middleware wrote stands only where nothing else made this answer one visitor's: a
    // rule the request itself selected may have added a `Set-Cookie` or a CORS allowance of its
    // own beside the file, and a cookie on the way out — from that rule, or from the middleware —
    // says the same thing whoever set it. Read off the assembled answer rather than off the
    // middleware alone, which is the only way to see what the two of them came to together.
    const shareable = input.configured?.conditioned !== true && !answered.has('set-cookie');
    const chosen = shareable ? middlewareCacheControl(input.middleware) : undefined;
    return chosen === undefined ? UNSHARED_GATED : { value: chosen, unshared: false };
  }
  // A rule the request itself selected makes this answer one visitor's, whatever the file's own
  // lifetime says. An immutable hashed file is still the same bytes to everyone — but the headers
  // beside it are not, and a shared cache holding them would hand one visitor's `Set-Cookie`,
  // CORS allowance or disposition to the next.
  if (input.configured?.conditioned === true) {
    return UNSHARED_GATED;
  }
  // A rule's own `cache-control` stands, as it does in the application: the file's is the default.
  return undefined;
}

function defaultCacheControl(file: StaticFileEntry): string {
  return file.immutable ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

/**
 * What the application set on the file's path, laid over `headers`: what `next.config` sets, as the
 * application's router would; then what the middleware set, part of what the application answers
 * with for a file as for a document. A cookie of either is scoped as a Function's is.
 */
function applicationHeaders(input: StaticFileInput, headers: Headers): void {
  const { forwarding } = input.edge;
  const configured = Object.entries(input.configured?.headers ?? {});
  for (const [name, value] of configured) {
    if (!ENTITY_HEADERS.has(name.toLowerCase())) {
      setConfigured(headers, name, value, forwarding);
    }
  }
  if (input.middleware !== undefined) {
    mergeScopedMiddlewareHeaders(headers, input.middleware.responseHeaders, forwarding);
  }
}

function fileHeaders(input: StaticFileInput, source: string): Headers {
  const { file, edge } = input;
  const middleware = input.middleware === undefined ? '' : ';mw=hit';
  const headers = new Headers({
    'content-type': file.contentType,
    [CONTENT_LENGTH]: String(file.byteLength),
    [ACCEPT_RANGES]: answersAsItself(input) ? 'bytes' : 'none',
    etag: etagOf(file),
    'cache-control': defaultCacheControl(file),
  });
  applicationHeaders(input, headers);
  // A client router asked for React Server Components and is answered with the file — a Pages
  // Router page's HTML, which it then loads as a document. Next.js marks such an answer as one that
  // varies on what the router sent (`setVaryHeader`), so no cache keyed on the URL alone hands it to
  // a request that did not send the same.
  if (input.request.headers.get(RSC_HEADER) === '1') {
    headers.append('vary', RSC_VARY);
  }
  // After everything the application had to say, so that neither a header rule nor a middleware can
  // write the edge's own account of the response: a deployment whose `next.config` set
  // `x-arkor-edge` would otherwise serve the right file and fail its own validation for it. `m=`
  // before anything a request adds, so the manifest that answered is named in one place whatever
  // else happened to the response.
  headers.set(
    EDGE_DEBUG_HEADER,
    `static;src=${source};project=${edge.projectId};policy=${edge.policy.id};m=${manifestIdPrefix(edge.manifestId)}${middleware}`,
  );
  // Only an accepted validation header produces this, and validation is the only thing that reads
  // it: a candidate's own files are then told apart from the active pointer's answer, as a
  // candidate's documents already are. Taken off first rather than written over, so that a rule
  // naming it on a request the edge did not validate cannot leave it standing — which is a claim
  // about the edge, not about the file, and never the application's to make.
  headers.delete(EDGE_VALIDATED_HEADER);
  if (edge.validated) {
    headers.set(EDGE_VALIDATED_HEADER, '1');
  }
  // Last, over anything a rule said: a validation must not be cached anywhere, and a file the
  // middleware gated must not be shared.
  const overriding = cacheControlFor(input, headers);
  if (overriding !== undefined) {
    headers.set('cache-control', overriding.value);
  }
  // Wherever the edge kept the answer from shared caches — where delivery is private, for a
  // validation, or because it is one visitor's — the lifetimes a rule or a middleware gave them go
  // too: `CDN-Cache-Control` and its kin outrank `cache-control` for exactly the caches this is
  // about, and one honouring them would hand a visitor's cookie on. A middleware's own
  // `cache-control` keeps what it said beside it.
  if (overriding?.unshared === true) {
    removeSharedCacheOverrides(headers);
  }
  applyCspReporting(headers, edge.cspReportingPath);
  return headers;
}

/**
 * Storage gave no file: the edge's own 503, under what the application set on the path — its router
 * answers every request there with it, an error included, and a cookie the middleware sets on each
 * is not lost to one — and kept by nobody, whatever either said of keeping it. Its type, coding and
 * account of itself are its own.
 */
function storageFailure(input: StaticFileInput, reason: string): Response {
  const own = serviceUnavailableResponse(reason);
  const headers = new Headers();
  applicationHeaders(input, headers);
  headers.delete('content-encoding');
  headers.delete(EDGE_VALIDATED_HEADER);
  for (const [name, value] of own.headers) {
    headers.set(name, value);
  }
  keptByNobody(headers);
  return new Response(own.body, { status: own.status, headers });
}

/**
 * The `Last-Modified` of the answer the file would be given: one a rule or the middleware gave it,
 * storage keeping no date of the file's own. Built only where a date is there to judge it by.
 */
function lastModifiedOf(input: StaticFileInput): string | null {
  return fileHeaders(input, 'manifest').get('last-modified');
}

/**
 * The range asked of the file (`requestedRange`), where it answers as itself; none otherwise. An
 * `If-Range` is judged against the answer the file would be given, as a precondition is
 * (`preconditionFailed`): the entity tag it carries, or its `Last-Modified`.
 */
function rangeAsked(input: StaticFileInput): BlobRange | null | undefined {
  return answersAsItself(input)
    ? requestedRange(
        input.request,
        entityTagOf(input),
        () => lastModifiedOf(input),
        input.file.byteLength,
      )
    : undefined;
}

function rangeNotSatisfiable(headers: Headers, file: StaticFileEntry): Response {
  headers.delete(CONTENT_LENGTH);
  headers.set(CONTENT_RANGE, `bytes */${file.byteLength}`);
  // The file's lifetime is the file's, not this refusal's: a cache keyed on the URL alone would hand
  // the 416 to every request for the file, ranged or not, for as long as it keeps the file.
  keptByNobody(headers);
  return new Response(null, { status: RANGE_NOT_SATISFIABLE_STATUS, headers });
}

/**
 * Whether the client already holds the entity (`clientHolds`), judged against the answer the file
 * would be given: weakly against the tag it carries (RFC 9110 §13.1.2) — the middleware's, when it
 * set one — or, asked by date, against the `Last-Modified` a rule or the middleware gave it, as a
 * precondition is (`preconditionFailed`).
 */
function unmodified(input: StaticFileInput): boolean {
  return (
    answersAsItself(input) &&
    clientHolds(input.request, entityTagOf(input), () => lastModifiedOf(input))
  );
}

/**
 * Whether the file fails a precondition the request holds it to (`preconditionFails`), judged
 * against the answer the file would be given: the entity tag it carries, and the `Last-Modified` a
 * rule or the middleware gave it — storage keeps no date of the file's own. Only a file answered as
 * itself is judged (`answersAsItself`).
 */
function preconditionFailed(input: StaticFileInput): boolean {
  return (
    answersAsItself(input) &&
    preconditionFails(input.request, entityTagOf(input), () => lastModifiedOf(input))
  );
}

/**
 * A precondition the file fails, answered 412 as Next.js's file server answers it, whatever
 * validator or range the request carries and to a `HEAD` as well. Under the file's headers and with
 * no body, as a 416 is — Next.js renders its error page there — and kept by nobody: a cache keyed on
 * the URL alone would hand the refusal to every request for the file.
 */
function preconditionFailure(input: StaticFileInput): Response {
  const headers = fileHeaders(input, 'manifest');
  headers.delete(CONTENT_LENGTH);
  keptByNobody(headers);
  return new Response(null, { status: PRECONDITION_FAILED_STATUS, headers });
}

/**
 * Whether the manifest is all the answer needs: a HEAD, a precondition the file fails, or an entity
 * the client already has.
 */
function answeredFromManifest(input: StaticFileInput): boolean {
  return input.request.method === 'HEAD' || preconditionFailed(input) || unmodified(input);
}

function metadataResponse(input: StaticFileInput): Response | undefined {
  if (preconditionFailed(input)) {
    return preconditionFailure(input);
  }
  const matched = unmodified(input);
  if (!matched && input.request.method !== 'HEAD') {
    return undefined;
  }
  const headers = fileHeaders(input, 'manifest');
  if (!matched) {
    return new Response(null, { status: statusOf(input), headers });
  }
  headers.delete(CONTENT_LENGTH);
  return new Response(null, { status: NOT_MODIFIED_STATUS, headers });
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface FileBody {
  readonly body: ReadableStream<Uint8Array>;
  /** `blob` through the blob Worker, `r2` from the bucket itself. */
  readonly source: 'blob' | 'r2';
  /** What the blob Worker's cache said of the read, when it was read there and the cache said. */
  readonly cache?: string | undefined;
}

/** What a read of storage came to: the file's bytes, if storage holds them, and what it took. */
interface FileRead {
  readonly file: FileBody | undefined;
  /** Requests it made: the blob Worker's, the bucket's, or both, one each that was asked. */
  readonly requests: number;
}

/** The part of a whole file a range asks for; the rest of the stream is let go. */
function sliceStream(
  body: ReadableStream<Uint8Array>,
  range: BlobRange,
): ReadableStream<Uint8Array> {
  let position = 0;
  // Terminated at the requested end rather than read to the end of the object: a one-byte range of
  // a megabyte otherwise pulls the whole of it through the isolate to throw it away.
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        const chunkStart = position;
        position += chunk.byteLength;
        const from = Math.max(range.start, chunkStart) - chunkStart;
        const to = Math.min(range.end + 1, position) - chunkStart;
        if (from < to) {
          controller.enqueue(chunk.subarray(from, to));
        }
        if (position > range.end) {
          controller.terminate();
        }
      },
    }),
  );
}

/** From the bucket itself: where there is no blob Worker, or it did not answer with the bytes. */
async function readBucket(
  bucket: R2Bucket,
  file: StaticFileEntry,
  range: BlobRange | undefined,
): Promise<FileBody | undefined> {
  // A partial read must not download the whole file before the requested bytes can leave.
  const object =
    range === undefined
      ? await bucket.get(blobKey(file.sha256))
      : await bucket.get(blobKey(file.sha256), {
          range: { offset: range.start, length: range.end - range.start + 1 },
        });
  if (object === null) {
    return undefined;
  }
  // The object is the file only at the size the manifest gives it, which the answer goes out under
  // with the file's tag and lifetime: one of another size — an upload cut short, a key written over
  // — is not served as it, as the blob Worker's answer of another length is not taken either.
  if (object.size !== file.byteLength) {
    releaseStream(object.body, 'static file of another size');
    logWarn('static file in storage is not the size the manifest gives it', {
      sha256: file.sha256,
      size: object.size,
      byteLength: file.byteLength,
    });
    return undefined;
  }
  return { body: object.body as ReadableStream<Uint8Array>, source: 'r2' };
}

/**
 * The file's bytes, or the one range of them asked for: through the blob Worker, whose tiered
 * cache is what a data center reads a file from once any data center has; from the bucket where
 * that Worker is not bound or does not answer with them. Both stream, and nothing is copied on the
 * way: the cache that keeps a file is the blob Worker's.
 */
async function readFile(
  edge: StaticFileContext,
  file: StaticFileEntry,
  range: BlobRange | undefined,
): Promise<FileRead> {
  const read = await readShippedFile(edge.runtime.blobWorker, file, range);
  if (read.kind !== 'bytes') {
    const asked = read.kind === 'unanswered' ? 1 : 0;
    return { file: await readBucket(edge.env.ARTIFACTS, file, range), requests: asked + 1 };
  }
  // The whole file, to a request for a range: the Worker was reached without its cache in front.
  const body = range === undefined || read.partial ? read.body : sliceStream(read.body, range);
  return { file: { body, source: 'blob', cache: read.cache }, requests: 1 };
}

/** A shipped file's bytes as a stream, and the requests storage took to answer. */
export interface StoredStream {
  /** `undefined` when storage does not hold the file. */
  readonly body: ReadableStream<Uint8Array> | undefined;
  readonly requests: number;
}

/** A shipped file's bytes, for something the edge derives from the file rather than serves as it is. */
export async function readStaticFileStream(
  edge: StaticFileContext,
  file: StaticFileEntry,
): Promise<StoredStream> {
  const read = await readFile(edge, file, undefined);
  return { body: read.file?.body, requests: read.requests };
}

/** A read that has begun: what it came to, or what failed — never a rejection. */
type SettledRead =
  | { readonly kind: 'read'; readonly read: FileRead }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * Observe a read from the moment it starts: the answer that takes it may not come for a while,
 * or at all, and a rejection meanwhile must not go unhandled.
 */
async function settle(read: Promise<FileRead>): Promise<SettledRead> {
  try {
    return { kind: 'read', read: await read };
  } catch (error) {
    return { kind: 'failed', error };
  }
}

/**
 * A read of the file a request asks for, started while the application's middleware decides
 * whether it may be answered at all (`hosted-gate.ts`): taken by the answer when the middleware
 * lets the request through to the same bytes, and let go otherwise.
 */
export interface EarlyFileRead {
  /** What was asked of storage: the one range, or the whole file. */
  readonly range: BlobRange | undefined;
  readonly read: Promise<SettledRead>;
  /** The request's context, which a read let go of is finished under. */
  readonly ctx: ExecutionContext;
  /** Whether the blob Worker was asked before the bucket, which a read that failed does not say. */
  readonly askedBlobWorker: boolean;
}

/**
 * Start reading the file as the request stands, before the middleware has run; `undefined` for a
 * request the manifest answers alone, or that no byte of the file satisfies.
 */
export function startFileRead(input: StaticFileInput): EarlyFileRead | undefined {
  if (answeredFromManifest(input)) {
    return undefined;
  }
  const range = rangeAsked(input);
  if (range === null) {
    return undefined;
  }
  return {
    range,
    read: settle(readFile(input.edge, input.file, range)),
    ctx: input.edge.ctx,
    askedBlobWorker: asksBlobWorker(input.edge.runtime.blobWorker, input.file),
  };
}

async function release(early: EarlyFileRead): Promise<void> {
  const settled = await early.read;
  if (settled.kind === 'read') {
    releaseStream(settled.read.file?.body, 'static file read abandoned');
  }
}

/**
 * Let a read go that no answer is taking: its bytes are released as soon as they arrive, which may
 * be after the answer that let it go has gone out.
 */
export function abandonFileRead(early: EarlyFileRead | undefined): void {
  if (early !== undefined) {
    early.ctx.waitUntil(release(early));
  }
}

function sameRange(a: BlobRange | undefined, b: BlobRange | undefined): boolean {
  return a === undefined || b === undefined ? a === b : a.start === b.start && a.end === b.end;
}

/**
 * The read this answer needs: the one started early when it asked for the same bytes — the
 * middleware may have taken a `Range` away, or set a tag an `If-Range` no longer names — or a new
 * one, with the early one let go, and returned as such for its requests to be counted.
 */
function readFor(
  input: StaticFileInput,
  range: BlobRange | undefined,
  early: EarlyFileRead | undefined,
): { readonly read: Promise<SettledRead>; readonly abandoned: EarlyFileRead | undefined } {
  if (early !== undefined && sameRange(early.range, range)) {
    return { read: early.read, abandoned: undefined };
  }
  abandonFileRead(early);
  return { read: settle(readFile(input.edge, input.file, range)), abandoned: early };
}

/**
 * The requests a read made, once it has come to something. One that failed failed at the bucket,
 * which is read last, after the blob Worker if the Worker was asked.
 */
async function requestsOf(early: EarlyFileRead): Promise<number> {
  const settled = await early.read;
  if (settled.kind === 'read') {
    return settled.read.requests;
  }
  return (early.askedBlobWorker ? 1 : 0) + 1;
}

/** What `x-arkor-edge` says the bytes came from: `src=blob;cache=hit`, `src=r2`. */
function sourceOf(read: FileBody): string {
  return read.cache === undefined ? read.source : `${read.source};cache=${read.cache}`;
}

export async function handleStaticFile(
  input: StaticFileInput,
  early?: EarlyFileRead,
  /** The read of the file a middleware rewrite moved the request from, let go and counted here. */
  replaced?: EarlyFileRead,
): Promise<Response> {
  const { edge } = input;
  const startedAt = edge.runtime.now();
  // The immutable manifest already names the entity and its length. A response with no body
  // needs no read of storage, after the caller has applied the middleware gate.
  const metadata = metadataResponse(input);
  if (metadata !== undefined) {
    abandonFileRead(early);
    recordManifestAnswer(input, startedAt, [early, replaced]);
    return metadata;
  }
  const range = rangeAsked(input);
  if (range === null) {
    abandonFileRead(early);
    recordManifestAnswer(input, startedAt, [early, replaced]);
    return rangeNotSatisfiable(fileHeaders(input, 'none'), input.file);
  }
  const { read: reading, abandoned } = readFor(input, range, early);
  const settled = await reading;
  if (settled.kind === 'failed') {
    logWarn('static file read failed', {
      pathname: input.pathname,
      detail: errorDetail(settled.error),
    });
    // Counted as a delivery is, outage and all: the bucket's read failed, after the blob Worker's
    // where that was asked first.
    const requests = (asksBlobWorker(edge.runtime.blobWorker, input.file) ? 1 : 0) + 1;
    const failed = deliveryMetric(input, { source: 'unavailable', requests }, startedAt, 0);
    recordDelivery(input, failed, [abandoned, replaced]);
    return storageFailure(input, 'static-file-unavailable');
  }
  const read = settled.read.file;
  if (read === undefined) {
    // The manifest names a blob storage does not hold: the deployment is broken, not the request.
    logWarn('static file missing from storage', { pathname: input.pathname });
    const missing = { source: 'missing', requests: settled.read.requests } as const;
    recordDelivery(input, deliveryMetric(input, missing, startedAt, 0), [abandoned, replaced]);
    return storageFailure(input, 'static-file-missing');
  }
  const headers = fileHeaders(input, sourceOf(read));
  const sentBytes = range === undefined ? wholeFileSent(input) : range.end - range.start + 1;
  recordDelivery(
    input,
    deliveryMetric(input, { ...read, requests: settled.read.requests }, startedAt, sentBytes),
    [abandoned, replaced],
  );
  if (range !== undefined) {
    headers.set(CONTENT_RANGE, `bytes ${range.start}-${range.end}/${input.file.byteLength}`);
    headers.set(CONTENT_LENGTH, String(range.end - range.start + 1));
    return new Response(read.body, { status: PARTIAL_CONTENT_STATUS, headers });
  }
  return new Response(read.body, { status: statusOf(input), headers });
}

/**
 * What the answer with the whole file sends of it: nothing where it goes out under a status the
 * middleware gave its rewrite that carries no body, its body let go of (`underRewriteStatus`, in
 * `hosted-static-file.ts`, which puts the status on an answer of 200 only).
 */
function wholeFileSent(input: StaticFileInput): number {
  const status = input.middleware?.rewriteStatus;
  return status !== undefined && NULL_BODY_STATUSES.has(status) && answersAsItself(input)
    ? 0
    : input.file.byteLength;
}

/**
 * The point of an answer the manifest gave with no read of storage — no body, or a range the file
 * cannot satisfy — counting the reads it let go of: one started beside the middleware, or the read
 * of the file a rewrite moved the request from.
 */
function recordManifestAnswer(
  input: StaticFileInput,
  startedAt: number,
  letGo: readonly (EarlyFileRead | undefined)[],
): void {
  recordDelivery(
    input,
    deliveryMetric(input, { source: 'manifest', requests: 0 }, startedAt, 0),
    letGo,
  );
}

/** Write the delivery's point, once the reads it let go of, if any, have said what they took. */
function recordDelivery(
  input: StaticFileInput,
  metric: EdgeMetric,
  abandoned: readonly (EarlyFileRead | undefined)[],
): void {
  const { edge } = input;
  const reads = abandoned.filter((read) => read !== undefined);
  if (reads.length === 0) {
    observeMetric(edge.host, metric);
    return;
  }
  // A read let go of made requests of its own, which it can say only once it has come to
  // something, and that may be after the answer has gone.
  edge.ctx.waitUntil(recordWithAbandoned(input, metric, reads));
}

async function recordWithAbandoned(
  input: StaticFileInput,
  metric: EdgeMetric,
  abandoned: readonly EarlyFileRead[],
): Promise<void> {
  const requests = await Promise.all(abandoned.map(async (read) => requestsOf(read)));
  const spent = requests.reduce((sum, count) => sum + count, 0);
  observeMetric(input.edge.host, { ...metric, subrequests: metric.subrequests + spent });
}

function deliveryMetric(
  input: StaticFileInput,
  delivered: Pick<FileBody, 'cache'> &
    Pick<FileRead, 'requests'> & {
      /** Where the bytes came from, or why storage gave none: it failed, or holds none. */
      readonly source: FileBody['source'] | 'manifest' | 'unavailable' | 'missing';
    },
  startedAt: number,
  sentBytes: number,
): EdgeMetric {
  const { edge } = input;
  return {
    projectId: edge.projectId,
    kind: 'asset',
    pathname: input.pathname,
    shellStrategy: '',
    shellSource: delivered.source,
    outcomeKind: 'static-file',
    colo: edge.colo ?? '',
    originCacheHeader: '',
    encoding: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    ttfbInternalMs: edge.runtime.now() - startedAt,
    shellLookupMs: 0,
    originFirstByteMs: 0,
    originTotalMs: 0,
    shellBytes: 0,
    suffixBytes: sentBytes,
    recovery: 0,
    retry: 0,
    // A body the blob Worker's cache served from what it keeps, in whichever of its tiers.
    assetHit: delivered.cache !== undefined && SERVED_FROM_CACHE.has(delivered.cache) ? 1 : 0,
    // Storage's, and the middleware's before them: every service call the answer made.
    subrequests: delivered.requests + (input.middlewareDispatches ?? 0),
    middlewareMs: input.middlewareMs,
  };
}

/**
 * The status the file is answered with: the one the manifest recorded for an error document,
 * or, for a manifest from before it recorded any, the one the bare name says.
 */
function statusOf(input: Pick<StaticFileInput, 'file' | 'pathname'>): number {
  return input.file.status ?? staticFileStatus(input.pathname);
}

/**
 * Whether the file is the thing the request asked for, which is the only answer a validator or a
 * range can be judged against. An error document answers a request for something else: RFC 9110
 * evaluates preconditions only when the response without them would be a 2xx (§13.2.1), and a
 * range only when it would be a 200 (§14.2). `/404` asked with `If-None-Match` or `Range` is still
 * a 404 with the whole page — not a 304 that tells a cache to keep whatever it holds for the URL,
 * nor a 206 slice of an error page a media element would take for the file it wanted.
 */
function answersAsItself(input: Pick<StaticFileInput, 'file' | 'pathname'>): boolean {
  return statusOf(input) === HTTP_OK;
}
