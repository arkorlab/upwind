import { canonicalJson, sha256Hex, sha256HexOfText } from '@stayingupwind/core/artifact';
import {
  BYPASS_IMAGE_TYPES,
  detectImageType,
  IMAGE_SIGNATURE_BYTES,
  type ImageRequestParams,
  imageResponseHeaders,
  type ImagesConfig,
  outputImageType,
  SVG,
  upstreamMaxAge,
} from '@stayingupwind/core/images';
import type { ConfiguredHeaders, ProjectManifest } from '@stayingupwind/core/manifest';
import {
  EDGE_DEBUG_HEADER,
  NO_STORE_CACHE_CONTROL,
  NULL_BODY_STATUSES,
} from '@stayingupwind/core/request';
import {
  type BoundedBody,
  isBodyLimitError,
  peekBody,
  readBoundedBody,
  releaseStream,
  withDeadline,
} from '@stayingupwind/core/util';

import type { TransformImage } from '../edge-runtime.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import { validatorMatches } from '../strategies/asset-upstream.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { IMAGE_OPTIMIZER_HEADERS, layImageConfiguredUnder } from './configured-headers.ts';
import {
  fetchImageSource,
  type ImageSource,
  imageSourceId,
  isContentAddressed,
  resolveImageSource,
  type SourceBody,
  type SourceError,
  sourceLimit,
} from './image-source.ts';
import { cuttable, releaseLateImage } from './image-stream.ts';
import { imageHrefForLog, transformWithin, withinBudget } from './image-transform.ts';
import type { MiddlewareContinued } from './middleware.ts';
import { observeMetric, observeTransformed } from './observer.ts';
import {
  keptByNobody,
  mergeScopedMiddlewareHeaders,
  notModifiedResponse,
  removeSharedCacheOverrides,
  safeDiagnosticField,
} from './responses.ts';

/**
 * `/_next/image` for a hosted application: the source resized and re-encoded by the Images
 * service, under the headers Next.js's own optimizer would have given it, and kept in the Cache
 * API so one transformation serves every visitor who asks for the same thing.
 *
 * A source that is transformed is never held in this isolate. It streams from wherever it lives
 * into the service, and only the optimized result — bounded, and small by construction — is read
 * whole, to be hashed for its entity tag and written to the cache. A source the service cannot
 * handle, or a deployment with no Images binding at all, is served as it is: a page must never
 * show a broken image because the optimizer was unavailable. Such a source is read whole, up to
 * the size the configuration allows one, before anything is sent: a size it did not declare is
 * judged then, as a refusal, rather than met halfway through an answer already committed.
 */

/** What an answer on the optimizer's path goes out under and is counted by, whatever it is. */
export interface ImageAnswerInput {
  /** The request as the middleware left it, when it ran: what the format and a validator are. */
  readonly request: Request;
  readonly edge: EdgeContext;
  readonly config: ImagesConfig;
  /**
   * What `next.config`'s header rules set on the path, selected on the request as it reached the
   * edge: the router runs them before the middleware, so neither a header it took away nor one it
   * added is what chose them.
   */
  readonly configured: ConfiguredHeaders;
  /** What the application's middleware set, when the edge ran it and it let the request on. */
  readonly middleware: MiddlewareContinued | undefined;
  /** The dispatches the middleware took before the image was served, which its metric counts. */
  readonly middlewareDispatches?: number | undefined;
  /** How long the middleware took, where it ran, which its metric reports. */
  readonly middlewareMs?: number | undefined;
}

export interface ImageInput extends ImageAnswerInput {
  readonly manifest: ProjectManifest;
  readonly params: ImageRequestParams;
  /**
   * The deployment the request names (`dpl`), where it names one: a build of a source kept from the
   * deployment before for its own requests alone is the source of no other (`resolveImageSource`).
   */
  readonly dpl: string | undefined;
}

/** Longest a request waits on the Cache API before optimizing instead. */
const CACHE_READ_BUDGET_MS = 100;
/** How long a source may take to yield its first bytes, and the service its result. */
const IMAGE_BUDGET_MS = 20_000;
const KIB = 1024;
const MIB = KIB * KIB;
/** Results up to this go into the cache; a larger transformation streams past it, uncached. */
const CACHEABLE_RESULT_MIB = 8;
const CACHEABLE_RESULT_BYTES = CACHEABLE_RESULT_MIB * MIB;
const ONE_YEAR_SECONDS = 31_536_000;
const HTTP_BAD_REQUEST = 400;
const HTTP_BAD_GATEWAY = 502;
const HTTP_PAYLOAD_TOO_LARGE = 413;
/**
 * Seconds the client may keep the image, kept on the cache entry: a hit says `cache-control`
 * again from it and from its own request, since a shipped file's entry serves every path the
 * file is at, and whether a path is a build-hashed one is the request's to say.
 */
const MAX_AGE_HEADER = 'x-arkor-image-max-age';
/**
 * Kept on the entry of a source served in place of a transformation the service failed to make
 * (`Optimized.serviceFailed`), so that a hit, as the answer that stored it, is not one a browser
 * keeps for as long as a build-hashed file's own.
 */
const SERVICE_FAILED_HEADER = 'x-arkor-image-service-failed';
/**
 * A result the middleware had a say on is what one visitor was allowed; a shared cache must not
 * hand it to the next. The visitor's own cache may keep it, revalidated.
 */
const GATED_CACHE_CONTROL = 'private, max-age=0, must-revalidate';
const UPSTREAM_INVALID = '"url" parameter is valid but upstream response is invalid';
const INTERNAL_INVALID = '"url" parameter is valid but internal response is invalid';
const CACHE_CONTROL_HEADER = 'cache-control';
const CONTENT_LENGTH_HEADER = 'content-length';

interface Optimized {
  readonly contentType: string;
  readonly body: ReadableStream<Uint8Array>;
  /** How it came about, for `x-arkor-edge` and the metric. */
  readonly via: 'images' | 'source';
  /** Seconds the client may keep it. */
  readonly maxAge: number;
  /** The source's own validator, when it is served as it is. */
  readonly etag: string | undefined;
  /** Subrequests it took: the source's, and one for the service when it was asked. */
  readonly requests: number;
  /**
   * The source standing in for a transformation the service did not make — it failed, or there is
   * none to ask — rather than what the optimizer serves as it is by type: kept for its own
   * lifetime alone, however content-addressed, so a request after it asks the service again.
   */
  readonly fallback: boolean;
  /**
   * The service was asked and failed: the source stands in for a transformation a later request
   * may be given, so even a build-hashed file's is not kept by the browser for that file's own ten
   * years (`isStatic`), but for the source's own lifetime. Not so where there is no service to ask,
   * whose answer the source always is.
   */
  readonly serviceFailed?: boolean | undefined;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Hex characters of the configuration's hash that tell one configuration from another. */
const CONFIG_FINGERPRINT_LENGTH = 16;
const fingerprints = new WeakMap<ImagesConfig, Promise<string>>();

/**
 * What of the configuration decides an entry: whether an SVG is served, how long a result may be
 * kept, which formats are offered. The cache is one for every hosted application, and one
 * application's answer must not be another's, nor a deployment's its own successor's once the
 * configuration changed — so the whole configuration goes into the key, by its hash.
 */
async function fingerprintOf(config: ImagesConfig): Promise<string> {
  const hex = await sha256HexOfText(canonicalJson(config));
  return hex.slice(0, CONFIG_FINGERPRINT_LENGTH);
}

function configFingerprint(config: ImagesConfig): Promise<string> {
  let fingerprint = fingerprints.get(config);
  if (fingerprint === undefined) {
    fingerprint = fingerprintOf(config);
    fingerprints.set(config, fingerprint);
  }
  return fingerprint;
}

/**
 * The key an image is kept under: the host's origin for them (`EdgeNames.imageKeyOrigin`), a name
 * nothing resolves, since the Cache API wants a URL and the key is the whole identity.
 */
async function cacheKey(
  origin: string,
  config: ImagesConfig,
  sourceId: string,
  params: ImageRequestParams,
): Promise<Request> {
  const format = params.mimeType === '' ? 'source' : params.mimeType;
  const fingerprint = await configFingerprint(config);
  return new Request(
    `${origin}/${fingerprint}/${sourceId}/${params.width}/${params.quality}/${format}`,
  );
}

async function lookupCache(cacheName: string, key: Request): Promise<Response | undefined> {
  let lookup: Promise<Response | undefined> | undefined;
  try {
    const cache = await caches.open(cacheName);
    lookup = cache.match(key);
    return await withDeadline(lookup, CACHE_READ_BUDGET_MS, 'image cache');
  } catch (error) {
    // The deadline ends this wait, not the cache read. No response owns a hit that arrives later.
    void releaseLateImage(lookup).catch(() => {
      // A failed lookup has no body to release; its failure was logged below.
    });
    logWarn('image cache read failed', { detail: errorDetail(error) });
    return undefined;
  }
}

async function storeCache(cacheName: string, key: Request, response: Response): Promise<void> {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(key, response);
  } catch (error) {
    logWarn('image cache write failed', { detail: errorDetail(error) });
  }
}

function invalidImage(message: string, requests: number): SourceError {
  return { status: HTTP_BAD_REQUEST, message, requests };
}

function badGateway(message: string, requests: number): SourceError {
  return { status: HTTP_BAD_GATEWAY, message, requests };
}

/** A source that ran past the limit while it was read, in the optimizer's words for its kind. */
function tooLarge(imageSource: ImageSource, requests: number): SourceError {
  return {
    status: HTTP_PAYLOAD_TOO_LARGE,
    message: imageSource.kind === 'remote' ? UPSTREAM_INVALID : INTERNAL_INVALID,
    requests,
  };
}

/** What the source was and what to do with it, from its first bytes. */
type Verdict =
  | { readonly kind: 'transform'; readonly upstreamType: string }
  | { readonly kind: 'bypass'; readonly contentType: string }
  | { readonly kind: 'refuse'; readonly error: SourceError };

function judge(prefix: Uint8Array, config: ImagesConfig, requests: number): Verdict {
  const upstreamType = detectImageType(prefix);
  if (upstreamType === undefined) {
    return {
      kind: 'refuse',
      error: invalidImage("The requested resource isn't a valid image.", requests),
    };
  }
  if (upstreamType === SVG && !config.dangerouslyAllowSVG) {
    return {
      kind: 'refuse',
      error: invalidImage('"url" parameter is valid but image type is not allowed', requests),
    };
  }
  if (BYPASS_IMAGE_TYPES.has(upstreamType)) {
    return { kind: 'bypass', contentType: upstreamType };
  }
  return { kind: 'transform', upstreamType };
}

function maxAgeFor(config: ImagesConfig, source: SourceBody): number {
  return Math.max(config.minimumCacheTTL, upstreamMaxAge(source.cacheControl));
}

type OptimizeResult =
  | { readonly kind: 'ok'; readonly image: Optimized }
  | { readonly kind: 'error'; readonly error: SourceError };

/** A source fetched and looked at: what it is, and what to do with it. */
type Judged =
  | {
      readonly kind: 'ok';
      readonly source: SourceBody;
      readonly body: ReadableStream<Uint8Array>;
      readonly verdict: Extract<Verdict, { kind: 'bypass' | 'transform' }>;
    }
  | { readonly kind: 'error'; readonly error: SourceError };

/**
 * Fetch the source and judge its first bytes. Done the same way each time the source is asked
 * for: what is served as it is has to have been looked at, whether it came from the first fetch
 * or from the one that follows a failed transformation.
 */
async function fetchJudged(input: ImageInput, imageSource: ImageSource): Promise<Judged> {
  const { edge, config } = input;
  const fetched = await fetchImageSource(edge, config, imageSource, {
    manifest: input.manifest,
    signal: input.request.signal,
  });
  if (fetched.kind === 'error') {
    return fetched;
  }
  const { source } = fetched;
  let peeked;
  try {
    peeked = await peekBody(
      cuttable(source.body, input.request.signal).stream,
      IMAGE_SIGNATURE_BYTES,
      IMAGE_BUDGET_MS,
    );
  } catch (error) {
    // A source can run past its limit within the bytes its type is read from: too large still,
    // as it is when that happens later, whatever chunks it came in.
    return {
      kind: 'error',
      error: isBodyLimitError(error)
        ? tooLarge(imageSource, source.requests)
        : badGateway(`image source unreadable: ${errorDetail(error)}`, source.requests),
    };
  }
  const verdict = judge(peeked.prefix, config, source.requests);
  if (verdict.kind === 'refuse') {
    releaseStream(peeked.body, 'image refused');
    return { kind: 'error', error: verdict.error };
  }
  return { kind: 'ok', source, body: peeked.body, verdict };
}

function asItIs(judged: Extract<Judged, { kind: 'ok' }>, maxAge: number): Optimized {
  const { verdict } = judged;
  return {
    contentType: verdict.kind === 'bypass' ? verdict.contentType : verdict.upstreamType,
    body: judged.body,
    via: 'source',
    maxAge,
    etag: judged.source.etag ?? undefined,
    requests: judged.source.requests,
    fallback: verdict.kind !== 'bypass',
  };
}

async function optimize(input: ImageInput, imageSource: ImageSource): Promise<OptimizeResult> {
  const { edge, config, params } = input;
  const judged = await fetchJudged(input, imageSource);
  if (judged.kind === 'error') {
    return judged;
  }
  const maxAge = maxAgeFor(config, judged.source);
  const transform = edge.runtime.transformImage;
  if (transform === undefined || judged.verdict.kind === 'bypass') {
    return { kind: 'ok', image: asItIs(judged, maxAge) };
  }
  let result: Awaited<ReturnType<TransformImage>>;
  try {
    const request = {
      width: params.width,
      format: outputImageType(params.mimeType, judged.verdict.upstreamType),
      quality: params.quality,
    };
    result = await transformWithin(transform, judged.body, request, {
      budgetMs: IMAGE_BUDGET_MS,
      signal: input.request.signal,
    });
  } catch (error) {
    const spent = judged.source.requests + 1;
    if (input.request.signal.aborted) {
      return { kind: 'error', error: badGateway('image request abandoned', spent) };
    }
    logWarn('image transformation failed', {
      href: imageHrefForLog(params.href),
      detail: errorDetail(error),
    });
    if (isBodyLimitError(error)) {
      return { kind: 'error', error: tooLarge(imageSource, spent) };
    }
    // As Next.js falls back when its encoder fails: the source itself, for its minimum lifetime.
    // The stream went to the service, so the source is asked for once more — and looked at once
    // more, since what it answers now need not be what it answered before.
    const again = await fetchJudged(input, imageSource);
    if (again.kind === 'error') {
      return { kind: 'error', error: { ...again.error, requests: spent + again.error.requests } };
    }
    const standIn = { ...asItIs(again, config.minimumCacheTTL), serviceFailed: true };
    return { kind: 'ok', image: { ...standIn, requests: spent + again.source.requests } };
  }
  // The service answered: the transformation is the host's to know of (`EdgeObserver`). Told past
  // the `try` that judges the service, so an observer that throws is never taken for it failing.
  observeTransformed(edge.host);
  return {
    kind: 'ok',
    image: {
      contentType: result.contentType,
      body: result.body,
      via: 'images',
      maxAge,
      etag: undefined,
      requests: judged.source.requests + 1,
      fallback: false,
    },
  };
}

function debugHeader(input: ImageAnswerInput, src: string): string {
  const middleware = input.middleware === undefined ? '' : ';mw=hit';
  return `image;src=${src};project=${safeDiagnosticField(input.edge.projectId)};policy=${input.edge.policy.id}${middleware}`;
}

/**
 * The headers as the client sees them: what `next.config` sets on the path, under what the
 * optimizer sets itself, as the application's router layers them; then validation and a
 * middleware's say each narrow the caching.
 */
function clientHeaders(input: ImageAnswerInput, headers: Headers, src: string): Headers {
  const out = new Headers(headers);
  const gated = input.configured.conditioned || input.middleware !== undefined;
  layImageConfiguredUnder(out, input.configured, input.edge.forwarding);
  // The middleware's headers, then the caching they must not widen: a result the middleware
  // admitted for one visitor stays private whatever it said, as a gated file does.
  if (input.middleware !== undefined) {
    mergeScopedMiddlewareHeaders(
      out,
      input.middleware.responseHeaders,
      input.edge.forwarding,
      src === 'error' ? undefined : IMAGE_OPTIMIZER_HEADERS,
    );
  }
  // A rule or middleware selected this visitor's answer, whatever the optimizer's lifetime is.
  if (gated) {
    out.set(CACHE_CONTROL_HEADER, GATED_CACHE_CONTROL);
  }
  // Where delivery is private nothing is kept, by the browser or a cache between: either could
  // hand the image back without the host being asked (`privateDelivery`).
  if (input.edge.validated || input.edge.privateDelivery) {
    out.set(CACHE_CONTROL_HEADER, NO_STORE_CACHE_CONTROL);
  }
  // Wherever one of those kept the image from shared caches, the lifetimes a rule or a middleware
  // gave them go too, as they outrank `cache-control` for exactly those caches — and one honouring
  // them would hand one visitor's image, cookie and all, to the next.
  if (gated || input.edge.validated || input.edge.privateDelivery) {
    removeSharedCacheOverrides(out);
  }
  out.set(EDGE_DEBUG_HEADER, debugHeader(input, src));
  return out;
}

/**
 * A refusal in the optimizer's own words, plain text, under what the path's rules and the
 * middleware set: the application's router answers every request on the path with them, an error
 * included, and a cookie the middleware sets on each is not lost to one. Kept by nobody, whatever
 * either of them said of keeping it.
 */
function refusal(input: ImageAnswerInput, error: SourceError, reason: string): Response {
  const own = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
  const headers = clientHeaders(input, own, 'error');
  keptByNobody(headers);
  headers.set(EDGE_DEBUG_HEADER, `error;reason=${reason}`);
  // A `HEAD` is answered with the headers alone, a refusal as an image is (`respond`).
  const body = input.request.method === 'HEAD' ? null : error.message;
  return new Response(body, { status: error.status, headers });
}

const HTTP_OK = 200;

/**
 * The image as the request asks for it: whole, or without a body — a 304 to a client that holds it
 * already, the headers alone to a `HEAD` — which its point then counts as nothing sent.
 * A successful image keeps its rewrite status; a matching validator still answers 304, as the
 * optimizer does. A rewrite with no body releases the image before its metric counts it.
 */
function respond(input: ImageAnswerInput, headers: Headers, body: BodyInit | null): Response {
  if (validatorMatches(input.request, headers.get('etag'))) {
    releaseStream(body instanceof ReadableStream ? body : undefined, 'not modified');
    return notModifiedResponse(headers);
  }
  const status = input.middleware?.rewriteStatus ?? HTTP_OK;
  const bodyless = NULL_BODY_STATUSES.has(status);
  if (bodyless) headers.delete(CONTENT_LENGTH_HEADER);
  if (bodyless || input.request.method === 'HEAD') {
    releaseStream(body instanceof ReadableStream ? body : undefined, 'head or bodyless rewrite');
    return new Response(null, { status, headers });
  }
  return new Response(body, { status, headers });
}

interface Outcome {
  readonly src: string;
  readonly startedAt: number;
  readonly bytes: number;
  readonly subrequests: number;
}

function record(input: ImageAnswerInput, outcome: Outcome): void {
  observeMetric(input.edge.host, pointOf(input, outcome));
}

/** The answer's point, timed as it is made: written at once, or once a streamed one has ended. */
function pointOf(
  input: ImageAnswerInput,
  { src, startedAt, bytes, subrequests }: Outcome,
): EdgeMetric {
  const { edge } = input;
  return {
    projectId: edge.projectId,
    kind: 'asset',
    pathname: input.config.path,
    shellStrategy: '',
    shellSource: src,
    outcomeKind: 'image',
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
    suffixBytes: bytes,
    recovery: 0,
    retry: 0,
    assetHit: src === 'cache' ? 1 : 0,
    // The image's own, and the middleware's before them: every service call the answer made.
    subrequests: subrequests + (input.middlewareDispatches ?? 0),
    middlewareMs: input.middlewareMs,
  };
}

function fromCache(input: ImageInput, cached: Response, startedAt: number): Response {
  const headers = imageResponseHeaders({
    href: input.params.href,
    contentType: cached.headers.get('content-type') ?? 'application/octet-stream',
    isStatic: input.params.isStatic && !cached.headers.has(SERVICE_FAILED_HEADER),
    maxAge: Number(cached.headers.get(MAX_AGE_HEADER) ?? input.config.minimumCacheTTL),
    etag: cached.headers.get('etag') ?? undefined,
    config: input.config,
    cache: 'HIT',
  });
  const length = cached.headers.get(CONTENT_LENGTH_HEADER);
  if (length !== null) {
    headers.set(CONTENT_LENGTH_HEADER, length);
  }
  const response = respond(input, clientHeaders(input, headers, 'cache'), cached.body);
  // Counted as the answer went: none of the image where it carries no body, a `HEAD`'s or a 304's.
  const sent = response.body === null ? 0 : Number(length ?? 0);
  record(input, { src: 'cache', startedAt, bytes: sent, subrequests: 0 });
  return response;
}

/**
 * Refuse a request before any source is asked for — parameters the optimizer does not take, a
 * pattern of the application's too costly to judge — as one is refused after: under the path's
 * headers, and counted.
 */
export function refuseImage(input: ImageAnswerInput, error: SourceError, reason: string): Response {
  const startedAt = input.edge.runtime.now();
  record(input, { src: 'error', startedAt, bytes: 0, subrequests: error.requests });
  return refusal(input, error, reason);
}

function transformMode(transform: TransformImage | undefined): string {
  return transform === undefined ? 'original' : 'transform';
}

export async function handleImage(input: ImageInput): Promise<Response> {
  const { edge, params } = input;
  const startedAt = edge.runtime.now();
  const source = resolveImageSource(edge, input.manifest, params, input.dpl);
  const availability = transformMode(edge.runtime.transformImage);
  const key = await cacheKey(
    edge.host.names.imageKeyOrigin,
    input.config,
    `${availability}:${await imageSourceId(source, edge)}`,
    params,
  );
  // Validation reads nothing live traffic cached, as it writes nothing (below): the key names no
  // policy, so an entry would answer for the candidate without its source or its transformer being
  // asked, and a candidate whose image path is broken would pass.
  const cached = edge.validated ? undefined : await lookupCache(edge.host.names.imageCache, key);
  if (cached !== undefined) {
    return fromCache(input, cached, startedAt);
  }
  const optimized = await optimize(input, source);
  if (optimized.kind === 'error') {
    record(input, { src: 'error', startedAt, bytes: 0, subrequests: optimized.error.requests });
    return refusal(input, optimized.error, 'image-source');
  }
  const { image } = optimized;
  const subrequests = image.requests;
  let bounded: BoundedBody;
  const readFrom = edge.runtime.now();
  try {
    // A source served as it is is read to the limit put on a source, so that running past it is
    // a refusal here; a transformation is the service's, and one too large to hold streams.
    bounded = await readBoundedBody(cuttable(image.body, input.request.signal).stream, {
      limit: image.via === 'source' ? sourceLimit(input.config) : CACHEABLE_RESULT_BYTES,
      // One budget in two places: the client is waiting on this read, so silence and slowness cost
      // it the same thing and neither may outlast what the whole answer is allowed.
      stallMs: IMAGE_BUDGET_MS,
      budgetMs: IMAGE_BUDGET_MS,
    });
  } catch (error) {
    // A source can run past the limit, or stop, while it is being read.
    record(input, { src: 'error', startedAt, bytes: 0, subrequests });
    return refusal(
      input,
      isBodyLimitError(error)
        ? tooLarge(source, subrequests)
        : badGateway(`image unreadable: ${errorDetail(error)}`, subrequests),
      'image-source',
    );
  }
  const headersFor = (etag: string | undefined): Headers => {
    return imageResponseHeaders({
      href: params.href,
      contentType: image.contentType,
      isStatic: params.isStatic && image.serviceFailed !== true,
      maxAge: image.maxAge,
      etag,
      config: input.config,
      cache: 'MISS',
    });
  };
  if (bounded.kind === 'over-limit') {
    // Too large to hold: streamed, unhashed and uncached — and still within the budget. Its point
    // is timed now and written as the stream ends, with what went out of it: none of it for an
    // answer that carries no body, which lets the stream go unread (`respond`).
    const point = pointOf(input, { src: image.via, startedAt, bytes: 0, subrequests });
    const headers = clientHeaders(input, headersFor(image.etag), image.via);
    const streamed = withinBudget(bounded.body, {
      runtime: edge.runtime,
      budgetMs: IMAGE_BUDGET_MS,
      spentOnFirstPart: edge.runtime.now() - readFrom,
      href: params.href,
      ended: (sent) => {
        observeMetric(edge.host, { ...point, suffixBytes: sent });
      },
    });
    return respond(input, headers, streamed);
  }
  const { bytes } = bounded;
  const etag = image.etag ?? `"${await sha256Hex(bytes)}"`;
  const headers = headersFor(etag);
  headers.set(CONTENT_LENGTH_HEADER, String(bytes.byteLength));
  // Validation must not populate a cache live traffic reads, what the middleware admitted for one
  // visitor is not for the next, and an entry is at most what the cache is for.
  if (
    !edge.validated &&
    input.middleware === undefined &&
    bytes.byteLength <= CACHEABLE_RESULT_BYTES
  ) {
    const entry = new Headers({
      'content-type': image.contentType,
      [CONTENT_LENGTH_HEADER]: String(bytes.byteLength),
      etag,
      [MAX_AGE_HEADER]: String(image.maxAge),
      ...(image.serviceFailed === true && { [SERVICE_FAILED_HEADER]: '1' }),
      // A shipped file's result is content-addressed, so the entry outlives its client lifetime —
      // unless the source stood in for a transformation, which would then outlive it too.
      [CACHE_CONTROL_HEADER]: `public, max-age=${isContentAddressed(source) && !image.fallback ? ONE_YEAR_SECONDS : image.maxAge}`,
    });
    edge.ctx.waitUntil(
      storeCache(edge.host.names.imageCache, key, new Response(bytes, { headers: entry })),
    );
  }
  const response = respond(input, clientHeaders(input, headers, image.via), bytes);
  const sent = response.body === null ? 0 : bytes.byteLength;
  record(input, { src: image.via, startedAt, bytes: sent, subrequests });
  return response;
}
