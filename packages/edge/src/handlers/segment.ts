import type { ArtifactLocator } from '@stayingupwind/core/artifact';
import type { ConfiguredHeaders, RouteSegment } from '@stayingupwind/core/manifest';
import type { MiddlewareResult } from '@stayingupwind/core/paas';
import {
  EDGE_DEBUG_HEADER,
  EDGE_VALIDATED_HEADER,
  manifestIdPrefix,
  negotiateContentEncoding,
  NEXT_DID_POSTPONE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NO_STORE_CACHE_CONTROL,
  RSC_HEADER,
} from '@stayingupwind/core/request';
import type { ShellDeliveryStrategy } from '@stayingupwind/host/delivery';
import { brotliWire, gzipWire } from '@stayingupwind/host/splice';

import type { DetachedRegeneration } from '../cache/regenerate.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { loadShell, storageReadsOf } from '../strategies/shell-loader.ts';
import { layStoredConfiguredOver, setConfigured } from './configured-headers.ts';
import { ACCEPT_ENCODING_HEADER, IDENTITY_ENCODING, varyOn } from './document-headers.ts';
import { observeMetric } from './observer.ts';
import {
  keptByNobody,
  mergeScopedMiddlewareHeaders,
  removeSharedCacheOverrides,
  safeDiagnosticField,
  serviceUnavailableResponse,
} from './responses.ts';

/**
 * A prefetch of part of a page, answered from what the build wrote for that part — or a router's
 * request for the whole payload of a page the build finished, answered from what it wrote for that.
 *
 * The router asks for a part with `rsc: 1` and a `next-router-segment-prefetch` naming which one,
 * and for the page's whole payload with `rsc: 1` alone; `next build` wrote the bytes of each beside
 * the page's document, and the manifest names them on the route (`routeEntry.segments`,
 * `routeEntry.payload`). So the whole answer is a lookup: nothing is composed, nothing is resumed,
 * and the deployment's Function is not woken — which is the point, since it would have rendered
 * nothing for the request that the build had not already written.
 *
 * The bytes are read the way a shell is (`loadShell`), because they are stored the way a shell is:
 * content-addressed, through the isolate's memory, the data centre's Cache API and the policy's
 * backend, each keyed by the digest and none of them by the request. Which is also why this path has
 * no cache-poisoning surface for `_rsc` to guard: the segment path selects a manifest entry, and the
 * entry selects bytes by their hash. `vary` still goes out, for the caches after this one.
 */
export interface SegmentInput {
  readonly request: Request<unknown, IncomingRequestCfProperties>;
  readonly edge: EdgeContext;
  /** The route the prefetch belongs to, by the pathname its entry is keyed with. */
  readonly pathname: string;
  /** What the router asked for: a part of the page, or its whole payload. */
  readonly kind: RouterPart;
  /** The bytes that answer it. */
  readonly segment: RouteSegment;
  /** The document headers recorded in the manifest or its held runtime generation. */
  readonly routeHeaders: Readonly<Record<string, string>>;
  /**
   * What the rules of `next.config` add for this request, judged on the request as it reached the
   * edge — the router runs them before the middleware, so that is what selected them. A rule with
   * conditions makes the answer this visitor's, which `cacheControlFor` reads off `conditioned`.
   */
  readonly configured: ConfiguredHeaders;
  readonly strategy: ShellDeliveryStrategy<EdgeContext>;
  /** What the application's middleware set, when the edge ran it and it let the request on. */
  readonly middleware: Extract<MiddlewareResult, { kind: 'continue' }> | undefined;
  /** The dispatches the middleware took before the part was answered, which its metric counts. */
  readonly middlewareDispatches?: number | undefined;
  /**
   * When the answer began, which is before the caller read the runtime cache to decide whether the
   * page is still the build's. On a cache-backed route that read is most of what the request costs,
   * and a clock started here would leave it out of the time the metric reports.
   */
  readonly startedAt: number;
  /** Runtime parts belong to the held HTML generation, including its partial Flight state. */
  readonly generation?:
    | { readonly partial: boolean; readonly cacheState: 'HIT' | 'STALE' }
    | undefined;
  /** Its Function can answer an unavailable runtime artifact, counting the reads already made. */
  readonly onUnavailable?: ((storageReads: number) => Promise<Response>) | undefined;
  /**
   * The regeneration a stale record asked for as a request of its own (`triggerDetached`), whose
   * dispatches the part's point counts.
   */
  readonly detached?: DetachedRegeneration | undefined;
}

/**
 * What a router's request answered here asks for: part of a page, the page's whole payload, or —
 * of a Pages Router page — its props.
 */
export type RouterPart = 'segment' | 'payload' | 'data';

/** Where an answer complete from the cache came from, as Next.js says it. */
const NEXT_CACHE_HEADER = 'x-nextjs-cache';

const CONTENT_TYPE = 'content-type';
const CONTENT_LENGTH = 'content-length';
const CONTENT_ENCODING = 'content-encoding';

/** What an answer says of its own bytes, whatever a rule says: their length, coding and tag. */
const ANSWER_ENTITY_HEADERS: ReadonlySet<string> = new Set([
  CONTENT_ENCODING,
  CONTENT_LENGTH,
  'etag',
]);

/** Entity headers of the page, which say nothing true about a part of it. */
const PAGE_ENTITY_HEADERS: ReadonlySet<string> = new Set([
  ...ANSWER_ENTITY_HEADERS,
  CONTENT_TYPE,
  'last-modified',
]);

/** The codings a segment may go out under, where the run compressed it into one. */
const SEGMENT_ENCODINGS: readonly ('br' | 'gzip')[] = ['br', 'gzip'];

const EMPTY = new Uint8Array();

/** What a prefetch answer differs by: what the router asked, and what the client accepts. */
const SEGMENT_VARY: readonly string[] = [
  RSC_HEADER,
  NEXT_ROUTER_STATE_TREE_HEADER,
  NEXT_ROUTER_PREFETCH_HEADER,
  NEXT_ROUTER_SEGMENT_PREFETCH_HEADER,
  ACCEPT_ENCODING_HEADER,
];
/** What a Pages Router page's props differ by: what the client accepts. */
const DATA_VARY: readonly string[] = [ACCEPT_ENCODING_HEADER];
const CACHE_CONTROL = 'cache-control';

/** The bytes to send, the coding to name them under, and what closes the stream where one is open. */
interface Rendering {
  readonly ref: ArtifactLocator;
  readonly encoding: string;
  readonly close: Uint8Array | undefined;
}

/** A response this visitor's alone: never held in a cache another visitor reads. */
const GATED_CACHE_CONTROL = 'private, max-age=0, must-revalidate';

/**
 * What the client accepts, as the client said it — Cloudflare's front line rewrites
 * `accept-encoding` on the way in and keeps the original in `cf`, and the body goes out as it is
 * stored, so negotiating on the rewritten header would send brotli to a client that never offered
 * it (`document.ts` reads it the same way, for the same reason).
 */
function clientAcceptEncoding(request: SegmentInput['request']): string | null {
  return request.cf?.clientAcceptEncoding ?? request.headers.get(ACCEPT_ENCODING_HEADER);
}

/**
 * What goes on the wire and under which coding: a pre-compressed rendering where both agree.
 *
 * A rendering is **the unfinished head of a stream**, not a stream. Both encoders are asked to
 * flush rather than finish, because a shell's is spliced: the edge frames the continuation into it
 * and closes the stream itself (`splice/wire.ts`). A segment has no continuation, so what closes it
 * is an empty one — `finish()` and nothing before it, which is the round trip a rendering's encoder
 * should verify its own output with. Served without that the client is handed a truncated stream
 * and decodes nothing at all.
 */
function chosenRendering(input: SegmentInput): Rendering {
  const { artifact, encodings } = input.segment;
  const identity = { ref: artifact, encoding: IDENTITY_ENCODING, close: undefined } as const;
  const offered = new Set(SEGMENT_ENCODINGS.filter((coding) => encodings?.[coding] !== undefined));
  const encoding = negotiateContentEncoding(clientAcceptEncoding(input.request), offered);
  if (encoding === IDENTITY_ENCODING) {
    return identity;
  }
  if (encoding === 'br') {
    const rendering = encodings?.br;
    return rendering === undefined
      ? identity
      : { ref: rendering, encoding, close: brotliWire(EMPTY).finish() };
  }
  const rendering = encodings?.gzip;
  if (rendering === undefined) {
    return identity;
  }
  // The trailer a gzip stream ends on is the CRC and length of what it decodes to, which is the
  // segment's own bytes: the manifest carries the one and the identity artifact the other.
  const digest = { crc32: rendering.crc32, byteLength: artifact.byteLength };
  return { ref: rendering, encoding, close: gzipWire(EMPTY, digest).finish() };
}

/**
 * Whether the answer may be held in a cache another visitor reads.
 *
 * A validation never may. A rule the request itself selected, or a middleware that set a cookie
 * beside the segment, makes the answer this visitor's — the bytes are the same to everyone, but the
 * headers beside them are not, and a shared cache holding those would hand one visitor's
 * `Set-Cookie` or CORS allowance to the next. A middleware that ran at all is read the same way a
 * shipped file reads it: the merge drops the middleware's own `cache-control`, so nothing it says
 * could narrow this by itself.
 */
function cacheControlFor(input: SegmentInput, answered: Headers): string | undefined {
  if (input.generation !== undefined) return NO_STORE_CACHE_CONTROL;
  // Nor ever where delivery is private: a part of a private page is the page
  // (`documentCacheControl`).
  if (input.edge.validated || input.edge.privateDelivery) {
    return NO_STORE_CACHE_CONTROL;
  }
  if (input.configured.conditioned || answered.has('set-cookie')) {
    return GATED_CACHE_CONTROL;
  }
  return input.middleware === undefined ? undefined : GATED_CACHE_CONTROL;
}

/**
 * What the application answers the page with, which is what its Function answers a prefetch of the
 * page with too: the route's recorded headers, and what a rule of `next.config` the request itself
 * selected adds over them. The page's own entity headers and resource links are left behind —
 * these are different bytes, and an RSC response does not use the document's preloads. A page's
 * props carry none of the page's, and the rules were judged against their own URL: those describe
 * these bytes, and a type or a date one names stands, as Next.js lets it (`sendRenderResult` keeps
 * a type already set).
 */
function applicationHeaders(input: SegmentInput, headers: Headers): void {
  const leftBehind = input.kind === 'data' ? ANSWER_ENTITY_HEADERS : PAGE_ENTITY_HEADERS;
  for (const [name, value] of Object.entries(input.routeHeaders)) {
    const normalized = name.toLowerCase();
    if ((normalized !== 'link' || input.kind === 'data') && !leftBehind.has(normalized)) {
      const set = setConfigured(headers, name, value, input.edge.forwarding);
      if (!set && input.generation !== undefined) {
        throw new TypeError('a recorded router-part header cannot be replayed');
      }
    }
  }
  // Explicit rules describe this request, including any Link the application intentionally sets.
  layStoredConfiguredOver(headers, input.configured, input.edge.forwarding, leftBehind);
}

function generationHeaders(input: SegmentInput, headers: Headers): void {
  if (input.kind === 'segment') {
    // Next.js marks a segment as the part of a document that a resume would have finished.
    headers.set(NEXT_DID_POSTPONE_HEADER, '2');
  } else {
    // A page's whole payload, or a Pages Router page's props, complete from what the build wrote, as
    // the Function says of either it answers from the build. Nothing in either is a resume's to
    // finish, so nothing marks it postponed.
    headers.set(NEXT_CACHE_HEADER, input.generation?.cacheState ?? 'HIT');
  }
  if (input.generation !== undefined && input.kind !== 'data') {
    headers.set('x-nextjs-prerender', '1');
    if (input.kind === 'payload') {
      if (input.generation.partial) headers.set(NEXT_DID_POSTPONE_HEADER, '1');
      else headers.delete(NEXT_DID_POSTPONE_HEADER);
    }
  }
}

function segmentHeaders(input: SegmentInput, rendering: Rendering, source: string): Headers {
  const { edge } = input;
  const headers = new Headers();
  applicationHeaders(input, headers);
  if (input.middleware !== undefined) {
    mergeScopedMiddlewareHeaders(headers, input.middleware.responseHeaders, edge.forwarding);
  }
  if (input.kind !== 'data' || !headers.has(CONTENT_TYPE)) {
    headers.set(CONTENT_TYPE, input.segment.artifact.contentType);
  }
  headers.set(
    CONTENT_LENGTH,
    String(rendering.ref.byteLength + (rendering.close?.byteLength ?? 0)),
  );
  if (rendering.encoding !== IDENTITY_ENCODING) {
    headers.set(CONTENT_ENCODING, rendering.encoding);
  }
  generationHeaders(input, headers);
  // Two prefetches of the same page differ only in a request header, so a cache keyed on the URL
  // alone would hand one of them the other's bytes; and two clients asking for the same part differ
  // only in what they accept. Added after the middleware's headers rather than before: the merge
  // *sets* what it carries, so a middleware naming a `vary` of its own would replace these and take
  // away the only thing standing between two parts of a page and a shared cache in front of them.
  //
  // One name at a time, through the helper the document path uses: it says nothing twice, and it
  // leaves a `Vary: *` alone — which is an alternative to a list of names rather than one of them,
  // and a value a shared cache may misparse once something is appended to it.
  // A page's props are asked for by their own URL, and differ only in what the client accepts.
  const varied = input.kind === 'data' ? DATA_VARY : SEGMENT_VARY;
  for (const name of varied) {
    varyOn(headers, name);
  }
  // After everything the application had to say, so that neither a header rule nor a middleware can
  // write the edge's own account of the response.
  const middleware = input.middleware === undefined ? '' : ';mw=hit';
  headers.set(
    EDGE_DEBUG_HEADER,
    `${input.kind};src=${source};enc=${rendering.encoding};strategy=${input.strategy.id};project=${safeDiagnosticField(edge.projectId)};policy=${edge.policy.id};m=${manifestIdPrefix(edge.manifestId)}${middleware}`,
  );
  headers.delete(EDGE_VALIDATED_HEADER);
  if (edge.validated) {
    headers.set(EDGE_VALIDATED_HEADER, '1');
  }
  // Last, over anything a rule said, as a shipped file's is.
  const overriding = cacheControlFor(input, headers);
  if (overriding !== undefined) {
    // `CDN-Cache-Control` and its kin take precedence over ordinary `cache-control` for the caches
    // this decision is about, so narrowing one while leaving the others standing narrows nothing: a
    // rule or a middleware naming a public lifetime there would have this visitor's `Set-Cookie`
    // held in a shared cache anyway. They go first, as they do for a proxied response.
    removeSharedCacheOverrides(headers);
    headers.set(CACHE_CONTROL, overriding);
  }
  // A pre-compressed body must reach the client as it left, so nothing in between may re-encode it.
  if (rendering.encoding !== IDENTITY_ENCODING) {
    const existing = headers.get(CACHE_CONTROL);
    headers.set(CACHE_CONTROL, existing === null ? 'no-transform' : `${existing}, no-transform`);
  }
  return headers;
}

/** The edge's 503 under the application's headers, with its own body and cache policy. */
function storageFailure(input: SegmentInput, reason: string): Response {
  const own = serviceUnavailableResponse(reason);
  const headers = new Headers();
  try {
    applicationHeaders(input, headers);
  } catch {
    return own;
  }
  if (input.middleware !== undefined) {
    mergeScopedMiddlewareHeaders(headers, input.middleware.responseHeaders, input.edge.forwarding);
  }
  headers.delete(CONTENT_ENCODING);
  headers.delete(CONTENT_LENGTH);
  headers.delete(EDGE_VALIDATED_HEADER);
  for (const [name, value] of own.headers) {
    headers.set(name, value);
  }
  keptByNobody(headers);
  return new Response(own.body, { status: own.status, headers });
}

/** What one answer cost and what it was, for the metric its host is told (`EdgeObserver`). */
interface SegmentDelivery {
  readonly source: string;
  readonly rendering: Rendering;
  /** What reading the bytes cost, apart from what deciding to read them cost. */
  readonly lookupMs: number;
  readonly bytes: number;
  /** The reads of storage the bytes took (`storageReadsOf`). */
  readonly reads: number;
}

function recordDelivery(input: SegmentInput, delivered: SegmentDelivery): void {
  const { source, rendering, lookupMs, bytes, reads } = delivered;
  const { edge } = input;
  const point: EdgeMetric = {
    projectId: edge.projectId,
    kind: input.kind,
    pathname: input.pathname,
    shellStrategy: input.strategy.id,
    shellSource: source,
    outcomeKind: input.kind,
    colo: edge.colo ?? '',
    originCacheHeader: '',
    encoding: rendering.encoding,
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    middlewareMs: edge.timings.middlewareMs,
    ttfbInternalMs: edge.runtime.now() - input.startedAt,
    shellLookupMs: lookupMs,
    originFirstByteMs: 0,
    originTotalMs: 0,
    shellBytes: bytes,
    suffixBytes: 0,
    recovery: 0,
    retry: 0,
    assetHit: 0,
    // Storage's, and the middleware's before them: every service call the answer made.
    subrequests: reads + (input.middlewareDispatches ?? 0),
  };
  // And the regeneration asked beside it, once that has made its dispatches.
  if (input.detached === undefined) {
    observeMetric(edge.host, point);
  } else {
    input.detached.record(point);
  }
}

/** The stored rendering, then the bytes that close its stream: two chunks, no second buffer. */
function closedStream(
  bytes: Uint8Array,
  close: Uint8Array | undefined,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (close !== undefined) {
        controller.enqueue(close);
      }
      controller.close();
    },
  });
}

/**
 * Answer the prefetch, or say the deployment cannot.
 *
 * A manifest naming bytes storage does not hold is a broken deployment, not a bad request — the same
 * reading a shipped file gets. It is not passed through to the Function: the manifest is published
 * only once every artifact it names is placed, so a miss here is a fault to see rather than one to
 * paper over with a render.
 */
export async function handleSegment(input: SegmentInput): Promise<Response> {
  const { edge } = input;
  const lookupStartedAt = edge.runtime.now();
  const negotiated = chosenRendering(input);
  const first = await loadShell(negotiated.ref, input.strategy, edge);
  // A rendering is an optimization, and the bytes it was made from are the answer. One missing,
  // corrupt or briefly unreadable is a slower response, not a failed prefetch — the document path
  // reads an unusable rendering the same way and sends the identity shell.
  const identity = { ref: input.segment.artifact, encoding: IDENTITY_ENCODING, close: undefined };
  const fallback =
    first.kind === 'ok' || negotiated.encoding === IDENTITY_ENCODING
      ? undefined
      : await loadShell(identity.ref, input.strategy, edge);
  const rendering = fallback === undefined ? negotiated : identity;
  const loaded = fallback ?? first;
  const reads = storageReadsOf(first) + (fallback === undefined ? 0 : storageReadsOf(fallback));
  if (loaded.kind !== 'ok') {
    if (input.onUnavailable !== undefined) return input.onUnavailable(reads);
    recordDelivery(input, {
      source: loaded.kind,
      rendering,
      lookupMs: edge.runtime.now() - lookupStartedAt,
      bytes: 0,
      reads,
    });
    return storageFailure(input, `${input.kind}-${loaded.kind}`);
  }
  let headers: Headers;
  try {
    headers = segmentHeaders(input, rendering, loaded.read.source);
  } catch {
    if (input.onUnavailable !== undefined) return input.onUnavailable(reads);
    recordDelivery(input, {
      source: 'corrupt',
      rendering,
      lookupMs: edge.runtime.now() - lookupStartedAt,
      bytes: 0,
      reads,
    });
    return storageFailure(input, `${input.kind}-metadata`);
  }
  const { bytes } = loaded.read;
  recordDelivery(input, {
    source: loaded.read.source,
    rendering,
    lookupMs: edge.runtime.now() - lookupStartedAt,
    bytes: bytes.byteLength + (rendering.close?.byteLength ?? 0),
    reads,
  });
  if (rendering.encoding === IDENTITY_ENCODING) {
    // Left to the runtime, which compresses it on the way out for a client that accepts one — the
    // renderings are what a build produced, not everything a client may take.
    return new Response(bytes as BodyInit, { status: 200, headers });
  }
  // The stored rendering and the bytes that close it go out as two chunks rather than one buffer: a
  // segment may be as large as any blob the edge holds, the LRU is already keeping it, and copying
  // the whole of it to append a terminator would double that for every prefetch in flight.
  return new Response(closedStream(bytes, rendering.close), {
    status: 200,
    headers,
    // The body is already in its declared encoding. Left to itself the runtime would encode it
    // again, under the one `content-encoding` it was already sent with, and the client would fail
    // to decode what came back. `no-transform` beside it says the same to the caches in between.
    encodeBody: 'manual',
  });
}
