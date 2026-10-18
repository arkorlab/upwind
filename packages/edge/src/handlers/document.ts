import type { EncodedShellRef, ShellEncoding } from '@stayingupwind/core/artifact';
import type { DecodedGenerationPack } from '@stayingupwind/core/cache';
import {
  type ConfiguredHeaders,
  documentHeaderRulesFor,
  headerRulesFor,
  type ProjectManifest,
  type RequestHeaderRules,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import { MIDDLEWARE_SET_COOKIE_HEADER, type MiddlewareResult } from '@stayingupwind/core/paas';
import { negotiateContentEncoding } from '@stayingupwind/core/request';
import type { ContinuationResume, ResolvedPolicy } from '@stayingupwind/host/delivery';
import {
  buildRecoveryBytes,
  createSplice,
  type MiddlewareCookies,
  type SpliceOutcome,
  type WireEncoding,
} from '@stayingupwind/host/splice';

import type { ServedValidity } from '../cache/decision.ts';
import type { DetachedRegeneration } from '../cache/regenerate.ts';
import { logWarn } from '../observability/logger.ts';
import { serverTiming, type ServerTimingEntry } from '../observability/server-timing.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { resumeContinuation } from '../strategies/continuation-resume.ts';
import { loadShell, type ShellLoadResult, storageReadsOf } from '../strategies/shell-loader.ts';
import { mintCspNonce, rewriteDocumentNonces } from './csp-nonce.ts';
import { deliveryFor, type Layering } from './document-delivery.ts';
import { delegateSandboxedDocument, headToApplication } from './document-handoffs.ts';
import {
  ACCEPT_ENCODING_HEADER,
  documentCacheControl,
  documentHeaders,
  foldedAsSet,
  foldedHeadersOf,
  IDENTITY_ENCODING,
  type RecordTiming,
  replayedDocumentHeaders,
  type ShellDelivery,
  USER_AGENT_HEADER,
} from './document-headers.ts';
import { reportOutcome } from './document-report.ts';
import {
  continuationRequest,
  fallbackToApp,
  followResume,
  releaseUpstream,
  settle,
  shellFailure,
  unsettle,
  type Upstream,
} from './document-upstream.ts';
import { decodesLayeredBrotli } from './layered-clients.ts';
import { onTheWayOut } from './live-compression.ts';
import {
  type MiddlewareOutcome,
  type MiddlewareSkipped,
  type MiddlewareTiming,
  routedHeaders,
} from './middleware.ts';
import { observeServed } from './observer.ts';
import type { PassthroughWait } from './passthrough.ts';
import { dispatchedSoFar } from './upstream.ts';

/** What a hosted application's middleware decided for this request, when the edge ran it. */
type MiddlewareContinue = Extract<MiddlewareResult, { kind: 'continue' }>;

/**
 * The generation a hosted application's document is served from, when the deployment's runtime
 * cache holds one: its record is the shell, its state is what the resume completes, and what it
 * says of its own freshness is on the wire for whoever reads the markers.
 */
interface ServedGeneration {
  readonly pack: DecodedGenerationPack;
  readonly validity: ServedValidity;
  /** Where the record came from: this isolate's memory, this data center's copy, or KV. */
  readonly source: string;
  /**
   * The record's size as this request read it from KV; none for a record the isolate held, or one
   * the data center's copy answered with.
   */
  readonly readBytes: number | undefined;
  readonly lookupMs: number;
  /** The record is a member's own, read beside the class shell's (`concreteUpgrade`). */
  readonly member: boolean;
  /** What the resume is told beside the request when the entry is to be regenerated behind it. */
  readonly regeneration: Readonly<Record<string, string>> | undefined;
  /** Give its ask back when the visitor takes the resume away before it answers. */
  readonly onAbandoned?: (() => void) | undefined;
  /**
   * The regeneration asked behind a document complete in itself as a request of its own, there being
   * no resume to ask beside (`triggerDetached`): the document's point counts its dispatches.
   */
  readonly detached?: DetachedRegeneration | undefined;
  /**
   * What serving the record sets off behind the response (`readServedAgain`), called once the
   * document is certain to go out from it, whole or resumed: not for one handed to the application
   * whole instead (`delegateSandboxedDocument`), which serves nothing of the record and dispatches no
   * resume for its regeneration to ride.
   */
  readonly onServed: (() => void) | undefined;
}

export interface DocumentInput {
  /** Header rules selected before middleware ran; absent where no ahead evaluation was needed. */
  readonly headerRules?: RequestHeaderRules | undefined;
  /** The request as it reached the Worker, `cf` metadata included. */
  readonly request: Request<unknown, IncomingRequestCfProperties>;
  readonly entry: RouteEntry;
  readonly manifest: ProjectManifest;
  readonly resolved: ResolvedPolicy<EdgeContext>;
  readonly edge: EdgeContext;
  /**
   * The middleware's answer, for a hosted application whose middleware the edge ran: the request
   * goes on as it left it, and its response headers join the document's. Skipped when the edge
   * had no reason to run it; `undefined` when the project fronts an origin.
   * A host composing this handler uses `runMiddleware` or `readMiddlewareAnswer` to decode it,
   * with Connection-nominated fields removed before response decisions and cookie accounting.
   */
  readonly middleware:
    | ((MiddlewareContinue | MiddlewareSkipped) & Partial<MiddlewareTiming>)
    | undefined;
  /** A read of `entry.shell` the caller started earlier, to be awaited instead of a new one. */
  readonly shellRead: Promise<ShellLoadResult> | undefined;
  /** The generation to serve instead of the build's shell; `undefined` serves the build's. */
  readonly generation: ServedGeneration | undefined;
  /** A built partial fallback asks for its completed shell beside the resume it already needs. */
  readonly buildRegeneration?: Readonly<Record<string, string>> | undefined;
  /**
   * Proxy the request to the application's Worker, as every passthrough of the request goes: routed
   * again from the pointer when the Workers it names turned out to be gone
   * (`RoutingInput.servedAgain`), and counted under the route it was classified as (`route`) — the
   * class of a dynamic route's member, not a pathname of its own — with the read of the records,
   * where they were read (`serveCachedDocument`), and the reads of a shell that could not be served
   * (`fallbackToApp`).
   */
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome,
    route?: string,
    waited?: PassthroughWait,
  ) => Promise<Response>;
  /**
   * The delivery record read for the route when the build's shell answers in its place — there was
   * none, or none that could be served — so that what the read cost is reported as a served
   * record's is. A served generation reports its own.
   */
  readonly recordRead?: RecordTiming | undefined;
}

const OK_STATUS = 200;
/** Every document can go out in either; what differs is whether the shell was compressed ahead. */
const CONTENT_ENCODINGS: ReadonlySet<ShellEncoding> = new Set<ShellEncoding>(['br', 'gzip']);
const RECOVERY_HTML = buildRecoveryBytes();
/** The source a generation's bytes are reported under, so a reader can tell them from a shell's. */
const GENERATION_SOURCE_PREFIX = 'gen-';

function middlewareMarker(middleware: DocumentInput['middleware']): string {
  if (middleware?.kind === 'continue') {
    return 'hit';
  }
  return middleware?.reason === 'validated' ? 'skip' : 'miss';
}

/** `cache`, `seq` and, for a member's own record, `member` on `x-arkor-edge`. */
function generationMarker(generation: ServedGeneration | undefined): string {
  if (generation === undefined) {
    return '';
  }
  const member = generation.member ? ';member=1' : '';
  return `;cache=${generation.validity};seq=${generation.pack.header.seq}${member}`;
}

/**
 * `cont`, `mw`, `route` and, for a generation, `cache`, `seq` and `member` on `x-arkor-edge`:
 * whether the document was completed by a resume, whether the middleware had a say in it, which
 * route the document is — its manifest key, the template of a class shell — so validation can
 * tell that the member it asked for landed on the route it was validating, which generation of
 * the route it was, in what state, and whether it was the member's own record rather than the
 * class shell's.
 */
function documentMarker(input: DocumentInput, complete: boolean): string {
  const continuation = complete ? 'none' : 'resume';
  const middleware = middlewareMarker(input.middleware);
  const cache = generationMarker(input.generation);
  return `;cont=${continuation};mw=${middleware};route=${input.entry.pathname}${cache}`;
}

/**
 * What the client accepts, as the client said it.
 *
 * Cloudflare's front line rewrites `accept-encoding` on the way in to what it can transcode
 * between, and keeps the client's own value in `cf`. Negotiating on the rewritten header would
 * pick brotli for a client that never offered it, and the body goes out as it is encoded — so the
 * original is what counts, and the header only stands in for a request nothing rewrote.
 */
function clientAcceptEncoding(request: DocumentInput['request']): string | null {
  return request.cf?.clientAcceptEncoding ?? request.headers.get(ACCEPT_ENCODING_HEADER);
}

/**
 * The pre-compressed rendering to send, if there is one to use.
 *
 * None for a project that handed CSP nonces to the edge, whatever the manifest names. Its documents
 * are rewritten on the way out and the shell then differs per response; a rendering is the shell
 * compressed once, and cannot carry what changes every time. The opt-in is the whole criterion: it
 * is the project's own statement that its documents are rewritten, it is known before any byte is
 * chosen, and nothing a request carries can say otherwise.
 *
 * None either for a generation whose bytes are not the build's: a rendering is of the shell the
 * manifest names, and only a record that still holds those bytes can go out under it.
 */
function usableRendering(
  input: DocumentInput,
  encoding: ShellEncoding | typeof IDENTITY_ENCODING,
): EncodedShellRef | undefined {
  if (encoding === IDENTITY_ENCODING || input.edge.cspNonce) {
    return undefined;
  }
  const { generation } = input;
  if (generation !== undefined && generation.pack.header.htmlSha256 !== input.entry.shell.sha256) {
    return undefined;
  }
  return input.entry.shellEncodings?.[encoding];
}

/**
 * A rendering read, and whether it has finished yet.
 *
 * Asking a promise how far along it is otherwise means awaiting it, which is the wait this exists
 * to avoid; the read's own continuation sets the answer down instead.
 */
interface TrackedRendering {
  /** The result once the read has finished, and `undefined` while it is still in flight. */
  ready(): ShellLoadResult | undefined;
  /** Never rejects: somewhere to hand the read when the response went out without it. */
  readonly pending: Promise<void>;
}

function trackRendering(read: Promise<ShellLoadResult>): TrackedRendering {
  let done: ShellLoadResult | undefined;
  const pending = (async (): Promise<void> => {
    try {
      done = await read;
    } catch {
      // Nothing to serve from, and nothing to fix here: the identity shell is already in hand and
      // the document is compressed on the way out, as it is for a rendering that read as missing.
      logWarn('shell rendering read failed, compressing on the way out');
    }
  })();
  return { ready: () => done, pending };
}

/**
 * The rendering to send, or `undefined` when the document goes out compressed on the way instead.
 * A ready shell never waits on another backend read, regardless of where that shell came from.
 * A rendering still in flight is left running, so the next request finds it in isolate memory.
 */
async function readyRendering(
  edge: EdgeContext,
  tracked: TrackedRendering | undefined,
): Promise<ShellLoadResult | undefined> {
  if (tracked === undefined) {
    return undefined;
  }
  // Let a rendering that settled in the shell's own turn record its result; no I/O or timer wait.
  await Promise.resolve();
  const ready = tracked.ready();
  if (ready === undefined) {
    edge.ctx.waitUntil(tracked.pending);
  }
  return ready;
}

/**
 * The reads of storage a rendering asked for took: none where none was asked for, and one for a
 * rendering still out once the shell's turn had passed, which the isolate's memory would have
 * answered within it (`readyRendering`).
 */
function renderingReads(
  tracked: TrackedRendering | undefined,
  ready: ShellLoadResult | undefined,
): number {
  if (tracked === undefined) {
    return 0;
  }
  return ready === undefined ? 1 : storageReadsOf(ready);
}

/**
 * What reading a document's bytes took, for its metric, served or handed on: the build's shell's
 * read, and the rendering's beside it (`renderingReads`). A record's own read is not the shell's.
 */
function storageReadsFor(
  input: DocumentInput,
  shell: ShellLoadResult,
  tracked: TrackedRendering | undefined,
  ready: ShellLoadResult | undefined,
): number {
  return (
    (input.generation === undefined ? storageReadsOf(shell) : 0) + renderingReads(tracked, ready)
  );
}

/**
 * Whether the deployment lets a brotli rendering's suffix go under the second layer: unless
 * `LAYERED_BROTLI` says `off` (`EdgeBindings`), which sends every rendering as one layer again.
 * Read leniently, since it is typed by hand at the moment something has gone wrong.
 */
function layersBrotli(input: DocumentInput): boolean {
  return input.edge.env.LAYERED_BROTLI?.trim().toLowerCase() !== 'off';
}

/**
 * Whether this document's brotli rendering goes under the second layer, if there is one to send.
 *
 * Decided while the shell is still being read: it is a look at two strings, and nothing between
 * the shell arriving and its first byte going out waits on it. It is the client's own user agent
 * that decides, not the one a middleware may have written for the continuation, since the client
 * is what has to undo both layers.
 */
function layeringFor(
  input: DocumentInput,
  complete: boolean,
  encoding: ShellEncoding | typeof IDENTITY_ENCODING,
): Layering {
  if (complete || encoding !== 'br' || !layersBrotli(input)) {
    return 'off';
  }
  return decodesLayeredBrotli(input.request.headers.get(USER_AGENT_HEADER)) ? 'on' : 'declined';
}

/**
 * What the resume is told beside its request: the regeneration asked for behind it, and the cookies
 * the middleware set, which the part rendered now reads as the request's own. Set after the
 * forwarding headers are built, which drop a client's `x-middleware-*`.
 */
function toldBesideResume(
  input: DocumentInput,
  generation: ServedGeneration | undefined,
): Readonly<Record<string, string>> | undefined {
  const { middleware } = input;
  const regeneration = generation?.regeneration ?? input.buildRegeneration;
  const setCookie = middleware?.kind === 'continue' ? middleware.setCookie : undefined;
  if (setCookie === undefined) {
    return regeneration;
  }
  return { ...regeneration, [MIDDLEWARE_SET_COOKIE_HEADER]: setCookie };
}

/**
 * What the middleware set, as the splice weighs a resume's cookies against it (`createSplice`): the
 * `Set-Cookie` values the shell goes out with, which the resume may answer with again, and the
 * `x-middleware-set-cookie` it was handed, whose cookies it may also answer with as Next.js writes
 * them back — where that stores them where the client keeps them, which for one naming no path is
 * under the path the client asked for, not the one the middleware rewrote it to. Read only where
 * the middleware set one, as only then is the resume handed any.
 */
function middlewareCookiesOf(input: DocumentInput): MiddlewareCookies {
  const { middleware } = input;
  return middleware?.kind === 'continue' && middleware.setCookie !== undefined
    ? {
        sentCookies: middleware.responseHeaders.getSetCookie(),
        handedCookies: middleware.setCookie,
        requestPathname: new URL(input.request.url).pathname,
      }
    : {};
}

/** The record's bytes as a shell read: no lookup beyond the one that read the record. */
function generationShell(generation: ServedGeneration): Promise<ShellLoadResult> {
  return Promise.resolve({
    kind: 'ok',
    read: {
      bytes: generation.pack.html,
      source: `${GENERATION_SOURCE_PREFIX}${generation.source}`,
      latencyMs: generation.lookupMs,
    },
  });
}

/**
 * What the resume completes: the build's own state for the build's generation, which the Worker
 * holds under the prerender's id; a regenerated one's state travels with the request.
 */
function resumeOf(generation: ServedGeneration | undefined): ContinuationResume | undefined {
  if (generation === undefined || generation.pack.header.source === 'build') {
    return undefined;
  }
  const { postponed } = generation.pack;
  return postponed === undefined
    ? undefined
    : { kind: 'runtime', state: postponed, route: generation.pack.header.route };
}

interface Composition {
  /** Selected shell/rendering is ready: response preparation begins without awaiting its body. */
  readonly startedAt: number;
  readonly headers: Headers;
  /**
   * The headers recorded with what is served, and those the rules of `next.config` that matched
   * the request set before the ones a document does not carry were taken out: any may say it must
   * not be kept.
   */
  readonly recorded: readonly Readonly<Record<string, string>>[];
  readonly delivery: ShellDelivery;
  readonly complete: boolean;
  /** `null` for a `HEAD`, answered with the headers the `GET` would carry and nothing else. */
  readonly body: ReadableStream<Uint8Array> | null;
}

/**
 * Whether this response is one the edge may stamp a nonce into; see `mintNonce` below.
 *
 * Only a route the runtime cache has an entry for — for a hosted build, nearly every prerender —
 * and so the build's own shell of such a route as well, validation included: a validation
 * compares a document of a project that opted in with the nonces taken out. A route without an
 * entry goes out as its build wrote it, opt-in or no.
 */
function mintsNonce(input: DocumentInput): boolean {
  return input.edge.cspNonce && input.entry.cache !== undefined;
}

/**
 * What `x-nextjs-cache` says of a hosted application's document: a page complete from the cache,
 * fresh or regenerated behind the visitor. Nothing of a page a resume completes, nor of a fronted
 * origin's, whose cache is not Next.js's to report on.
 */
function nextCacheOf(input: DocumentInput, complete: boolean): 'HIT' | 'STALE' | undefined {
  if (!complete || input.middleware === undefined) {
    return undefined;
  }
  return input.generation?.validity === 'stale' ? 'STALE' : 'HIT';
}

/** The delivery record read for the route: the served generation's lookup, or the one that found none. */
function recordTimingOf(input: DocumentInput): RecordTiming | undefined {
  const { generation } = input;
  if (generation === undefined) {
    return input.recordRead;
  }
  return { lookupMs: generation.lookupMs, description: generation.source };
}

/** The response as it goes out: its headers, the nonce, and the encoding the client negotiated. */
function composedResponse(input: DocumentInput, composition: Composition): Response {
  const { entry, resolved, edge } = input;
  const { delivery } = composition;
  const { headers, nonce } = documentHeaders({
    entry,
    headers: composition.headers,
    edge,
    strategyId: resolved.shell.id,
    shell: delivery,
    // Minted inside, once the rules of `next.config` and the middleware have had their say over
    // the build's policy: what the nonce has to match is the policy this response carries.
    mintNonce: mintsNonce(input) ? mintCspNonce : undefined,
    hosted: documentMarker(input, composition.complete),
    middleware: input.middleware?.kind === 'continue' ? input.middleware : undefined,
    nextCache: nextCacheOf(input, composition.complete),
    cacheControl: documentCacheControl(
      {
        complete: composition.complete,
        privateDelivery: edge.privateDelivery,
        middleware:
          input.middleware?.kind === 'continue' ? input.middleware.responseHeaders : undefined,
      },
      composition.recorded,
    ),
    record: recordTimingOf(input),
  });
  if (composition.body === null) {
    return new Response(null, { status: OK_STATUS, headers });
  }
  const composed = new Response(composition.body, { status: OK_STATUS, headers });
  // The nonce goes into the markup, so it goes in before any compression on the way out; the
  // rewriter sees the whole document from byte zero either way.
  const document = nonce === undefined ? composed : rewriteDocumentNonces(composed, nonce);
  const body: ReadableStream<Uint8Array> | null = document.body;
  if (body === null) {
    return document;
  }
  return new Response(onTheWayOut(body, delivery), {
    status: OK_STATUS,
    headers,
    // The body is already in its declared encoding; left to itself the runtime would encode it
    // again, and buffer the shell while doing so.
    encodeBody: 'manual',
  });
}

/**
 * The response is ready, without awaiting the continuation or reading its body. `compose` starts
 * after the selected bytes/rendering were ready; `edge` starts at the host's native handler entry.
 * Both use the existing I/O clock: synchronous CPU can read as zero, and isolate startup before
 * handler entry is outside `edge`. These overlap other entries and are not additive phase costs.
 */
function composeDocument(input: DocumentInput, composition: Composition): Response {
  const response = composedResponse(input, composition);
  const now = input.edge.runtime.now();
  const entries: ServerTimingEntry[] = [
    { name: 'compose', durationMs: now - composition.startedAt },
  ];
  const { requestStartedAt } = input.edge.timings;
  if (requestStartedAt !== undefined) {
    entries.push({ name: 'edge', durationMs: now - requestStartedAt });
  }
  response.headers.append('server-timing', serverTiming(entries));
  return response;
}

/** What stands for the continuation of a document that has none, should the shell fail it. */
function noContinuation(): Promise<Upstream> {
  return settle(Promise.reject(new Error('the document has no continuation')));
}

/** A document complete as it is: the wire's shell as the body, ended, nothing spliced behind it. */
function wireBody(wire: WireEncoding): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(wire.shell);
      const end = wire.finish();
      if (end.byteLength > 0) {
        controller.enqueue(end);
      }
      controller.close();
    },
  });
}

/**
 * Whether a manifest from before the folded rules travelled apart (`foldedHeaderRules`) has them
 * only in its routes' headers: a build whose routing the edge does not reproduce — one with `i18n`,
 * or one with a `basePath` from before the edge routed it — publishes no dynamic routes
 * (`dynamicRouting`); any other publishes them, an empty list included. Not its header rules: such
 * a build publishes the ones `next build` writes itself (`headerRulesOf`), and its others are still
 * only in its routes' headers.
 */
function foldsHeaderRules(manifest: ProjectManifest): boolean {
  return manifest.dynamicRoutes === undefined;
}

/**
 * The headers recorded with what is served: the generation's own when the runtime cache answers,
 * since a regeneration may answer with headers the build's did not, and the route's as the
 * manifest recorded them otherwise. Both were read with the bytes they go out with; neither is
 * read again. A generation a resume completes has its policy permit the recovery script as the
 * route's does, from the read that brought the record in (`generation-loader.ts`); one complete in
 * itself keeps the policy its render set.
 *
 * A generation's record holds only what its render set; the rules of `next.config` are added over
 * it. The edge judges them on each request when the manifest carries them. A build whose routing
 * the edge does not reproduce publishes its unconditional ones apart instead, judged here against
 * the route's own pathname as the deployment judged them, and laid over the generation's — the
 * rule wins, as everywhere else. On a manifest from before they travelled apart they are only in
 * the route's headers (`foldsHeaderRules`), and the generation's go over those: a regenerated
 * page keeps the policy its build went out with, though a header its build's render set and a
 * regeneration's did not stays with it, and a render's header wins over a rule's. Over a
 * generation complete in itself they go as the application set them (`foldedAsSet`), as the rules
 * judged on each request do (`documentRules`).
 */
function recordedHeaders(input: DocumentInput): Readonly<Record<string, string>> {
  const { generation, entry, manifest } = input;
  if (generation === undefined) {
    return entry.headers;
  }
  const own = generation.pack.header.headers;
  const judged = isCompleteDocument(input) ? foldedAsSet(manifest) : manifest;
  const folded = foldedHeadersOf(judged, entry.pathname);
  if (folded !== undefined) {
    return { ...own, ...folded };
  }
  return foldsHeaderRules(manifest) ? { ...entry.headers, ...own } : own;
}

/**
 * The rules of `next.config` a document is laid with, judged on the original request as Next.js's
 * router judges them — without the host's credentials, which never reach it (`routedHeaders`) — or
 * as they were judged before the middleware ran. A document a resume completes takes each rule's
 * document form, whose policy permits the recovery script the edge appends where the resume fails
 * (`documentHeaderRulesFor`). One complete in itself has no such script behind it, and takes the
 * rules as the application set them, as Next.js sends them.
 */
function documentRules(input: DocumentInput): ConfiguredHeaders {
  const { headerRules, manifest } = input;
  const complete = isCompleteDocument(input);
  if (headerRules !== undefined) {
    return complete ? headerRules.response : headerRules.document;
  }
  return (complete ? headerRulesFor : documentHeaderRulesFor)(
    manifest,
    new URL(input.request.url),
    routedHeaders(input.edge, manifest.headerRules, input.request.headers),
  );
}

/** A generation without resume state is complete, even when the build's shell was not. */
function isCompleteDocument(input: DocumentInput): boolean {
  return input.generation === undefined
    ? input.entry.cache?.delivery === 'complete'
    : input.generation.pack.postponed === undefined;
}

/**
 * The record is served from here on, whole or resumed — once it is certain to go out, and behind the
 * resume's dispatch: a read from KV is reported to the host's observer as one served
 * (`EdgeObserver.recordServed`), which a host may meter, and what serving it sets off goes too
 * (`onServed`). Nothing for the build's shell.
 */
function servedFromRecord(edge: EdgeContext, generation: ServedGeneration | undefined): void {
  if (generation?.readBytes !== undefined) {
    observeServed(edge.host, generation.readBytes);
  }
  generation?.onServed?.();
}

/**
 * TTFB-first document delivery: the shell lookup starts before the resume request is built, the
 * bytes are flushed before the application's Worker has produced one, then the suffix it renders
 * is spliced behind them. A generation the runtime cache holds is served the same way, from its
 * record; one complete in itself goes out whole.
 *
 * A `HEAD` of a document complete in itself is answered with the headers the `GET` would carry and
 * no body (RFC 9110 §9.3.2), and nothing is dispatched for it. One a resume completes is the
 * application's (`headToApplication`).
 */
export async function handleDocument(input: DocumentInput): Promise<Response> {
  const complete = isCompleteDocument(input);
  if (!complete && input.request.method === 'HEAD') {
    if (input.shellRead !== undefined) {
      input.edge.ctx.waitUntil(input.shellRead);
    }
    return headToApplication(input);
  }
  return deliverDocument(input, complete);
}

/** The document the edge answers itself: its shell, and what a resume renders behind it. */
async function deliverDocument(input: DocumentInput, complete: boolean): Promise<Response> {
  const { entry, manifest, resolved, generation } = input;
  // Shell first: its read starts before anything else, and the rendering's beside it rather than
  // after it — neither read may wait on the other. The resume is then built and dispatched before
  // the shell is awaited, and deliberately so: nothing goes out until this function returns its
  // response, so dispatching after the shell would bring the first byte no earlier, only start the
  // suffix later, where dispatching now lets the application's Worker render while the shell is
  // read. What that puts in front of a shell already in memory is the resume's construction, which
  // is synchronous — a request and its headers — and waits on nothing.
  const lookupStart = input.edge.runtime.now();
  const shellLookup =
    generation === undefined
      ? (input.shellRead ?? loadShell(entry.shell, resolved.shell, input.edge))
      : generationShell(generation);
  // Judge rules on the original request (`documentRules`), and reuse the prepared headers at
  // composition. Middleware replaces this policy when it supplies one; no later decoration changes
  // sandbox flags. Decide before dispatching a resume, which cannot serve a whole document.
  const recorded = recordedHeaders(input);
  const rules = documentRules(input);
  const headers = replayedDocumentHeaders(recorded, rules);
  const delegated = delegateSandboxedDocument(input, complete, headers);
  if (delegated !== undefined) {
    input.edge.ctx.waitUntil(shellLookup);
    return delegated;
  }
  const encoding = negotiateContentEncoding(clientAcceptEncoding(input.request), CONTENT_ENCODINGS);
  const layering = layeringFor(input, complete, encoding);
  const rendering = usableRendering(input, encoding);
  const head = input.request.method === 'HEAD';
  // A `HEAD` is answered with no body, so the rendering is not read for it: its headers are the
  // same whichever bytes would have gone out under them (`deliveryFor`).
  const encodedRead =
    rendering === undefined || head
      ? undefined
      : trackRendering(loadShell(rendering, resolved.shell, input.edge));
  const { client, edge } = continuationRequest(input);
  const handle =
    complete || head
      ? undefined
      : resumeContinuation.start({
          request: client,
          entry,
          manifest,
          ctx: edge,
          resume: resumeOf(generation),
          headers: toldBesideResume(input, generation),
        });
  // The resume goes with a client that leaves before a splice holds it (`followClient`).
  const { upstream, clientLeft, cancelled } = followResume(input, handle);
  servedFromRecord(edge, generation);
  const shell = await shellLookup;
  if (shell.kind !== 'ok') {
    // The dispatch is still in flight and nothing is going to read it; hand it to the runtime so it
    // is allowed to finish rather than being torn down mid-subrequest. The same for the rendering.
    if (encodedRead !== undefined) {
      edge.ctx.waitUntil(encodedRead.pending);
    }
    // Counted with the passthrough, as a served document counts them: the rendering as it stands,
    // since nothing waits on it any longer.
    const storageReads = storageReadsFor(input, shell, encodedRead, encodedRead?.ready());
    const failure = { ...shellFailure(shell), storageReads };
    return fallbackToApp(input, upstream ?? noContinuation(), failure, handle);
  }
  // Read here: the rendering's turn below is not shell lookup and may not be reported as it. A
  // generation the cache answered with reports its own lookup.
  const lookupMs = generation?.lookupMs ?? edge.runtime.now() - lookupStart;
  const encoded = await readyRendering(edge, encodedRead);
  const compositionStarted = edge.runtime.now();
  const delivery = deliveryFor({
    entry,
    shell,
    lookupMs,
    encoding,
    rendering,
    read: encoded,
    layering,
    bodiless: head,
  });
  const totalTimeoutMs = Math.min(
    manifest.continuation.totalTimeoutMs,
    edge.policy.continuation.timeoutMs,
  );
  const read = {
    shell: delivery,
    storageReads: storageReadsFor(input, shell, encodedRead, encoded),
  };
  if (handle === undefined || upstream === undefined) {
    const outcome: SpliceOutcome = { kind: 'ok', suffixBytes: 0, originFirstByteMs: 0, totalMs: 0 };
    edge.ctx.waitUntil(reportOutcome({ input, outcome, ...read, subrequests: 0, head }));
    // What the `GET` would say of itself, a resume included: the headers are the `GET`'s.
    return composeDocument(input, {
      startedAt: compositionStarted,
      headers,
      recorded: [recorded, rules.headers],
      delivery,
      complete,
      body: head ? null : wireBody(delivery.wire),
    });
  }
  if (clientLeft()) {
    // The resume went with the client: nothing is spliced for nobody, and what became of the
    // document is the client's cancel, not a resume that failed, which the route's reports count.
    edge.ctx.waitUntil(releaseUpstream(upstream));
    const outcome: SpliceOutcome = { kind: 'client-cancelled', forwarded: 0 };
    const dispatched = dispatchedSoFar(handle.response);
    edge.ctx.waitUntil(reportOutcome({ input, outcome, ...read, subrequests: 1, dispatched }));
    return composeDocument(input, {
      startedAt: compositionStarted,
      headers,
      recorded: [recorded, rules.headers],
      delivery,
      complete: false,
      body: null,
    });
  }
  const splice = createSplice({
    shell: shell.read.bytes,
    wire: delivery.wire,
    upstream: unsettle(upstream),
    ...middlewareCookiesOf(input),
    recoveryHtml: RECOVERY_HTML,
    now: edge.runtime.now,
    // Never past the total. The two come from different documents — the manifest and the policy —
    // and a first-byte budget larger than the whole budget would be the only deadline that applied.
    firstByteTimeoutMs: Math.min(manifest.continuation.firstByteTimeoutMs, totalTimeoutMs),
    totalTimeoutMs,
    abortUpstream: (reason) => {
      handle.abort(reason);
    },
  });
  edge.ctx.waitUntil(
    (async (): Promise<void> => {
      const outcome = await splice.outcome;
      cancelled(outcome);
      // Where the resume went, as far as it got: the Worker that answered or failed, or the one it
      // was still out to when the first-byte timeout ended it — the report waits for none of them.
      const dispatched = dispatchedSoFar(handle.response);
      await reportOutcome({ input, outcome, ...read, subrequests: 1, dispatched });
    })(),
  );
  return composeDocument(input, {
    startedAt: compositionStarted,
    headers,
    recorded: [recorded, rules.headers],
    delivery,
    complete: false,
    body: splice.readable,
  });
}
