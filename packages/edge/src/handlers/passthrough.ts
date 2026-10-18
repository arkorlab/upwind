import type { AppRuntime, ConfiguredHeaders, ProjectManifest } from '@stayingupwind/core/manifest';
import {
  HEADER_RULES_JUDGED_HEADER,
  HEADER_RULES_LEFT_HEADER,
  INVALIDATED_REVISION_HEADER,
  INVALIDATED_TAGS_HEADER,
  MIDDLEWARE_DONE_HEADER,
  MIDDLEWARE_REWRITE_STATUS_HEADER,
  MIDDLEWARE_SET_COOKIE_HEADER,
  type MiddlewareResult,
  ORIGINAL_URL_HEADER,
} from '@stayingupwind/core/paas';
import {
  EDGE_DEBUG_HEADER,
  EDGE_VALIDATED_HEADER,
  type ForwardingContext,
  NEXT_ROUTER_PREFETCH_HEADER,
  type RequestClass,
} from '@stayingupwind/core/request';

import { takeInvalidation } from '../cache/condemned.ts';
import type { DetachedRegeneration } from '../cache/regenerate.ts';
import type { EdgeHost } from '../edge-host.ts';
import type { EdgeRuntime } from '../edge-runtime.ts';
import { buildPassthroughRequest } from '../forwarding.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import { stripEdgeHeaders } from '../request-context.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { layConfiguredOver } from './configured-headers.ts';
import { applyCspReporting } from './csp-reporting-headers.ts';
import { observeMetric } from './observer.ts';
import {
  badGatewayResponse,
  forwardedResponse,
  keptByNobody,
  mergeScopedMiddlewareHeaders,
  nominatedBy,
  privateCacheControl,
} from './responses.ts';
import {
  dispatchedOf,
  dispatchedSoFar,
  dispatchesMade,
  fetchUpstream,
  functionOfRequest,
  MisroutedError,
} from './upstream.ts';

const ASSET_CLASS = 'immutable-asset-candidate';
const STATIC_FILE_CLASS = 'static-file';

/** What `x-arkor-edge` says a request was proxied for: the class that sent it, or its own reason. */
export function passthroughReason(classification: RequestClass): string {
  switch (classification.kind) {
    case 'passthrough': {
      return classification.reason;
    }
    case 'rsc':
    case 'rsc-payload':
    case 'pages-data':
    case 'segment-prefetch':
    case 'action':
    case ASSET_CLASS:
    case STATIC_FILE_CLASS:
    case 'document': {
      return classification.kind;
    }
    default: {
      return 'unknown';
    }
  }
}

/** A middleware answer the edge already has, so the runtime must not run the middleware again. */
export type MiddlewareContinue = Extract<MiddlewareResult, { kind: 'continue' }>;

/**
 * What a passthrough writes down, from wherever the request was given up on.
 *
 * This is the slowest thing the edge does — the whole document is asked of the origin, or of the
 * deployment's own Worker, which renders it from nothing — and it is the one path that was
 * recorded nowhere. A cost nothing counts is one nobody finds.
 */
export interface PassthroughMetrics {
  /**
   * How long the middleware took before this gave up on it, where that is what it gave up on.
   *
   * The reason a `middleware-failed;cause=timeout` is worth a number: with it, the budget that
   * refused it can be set against what the middleware actually takes rather than against a guess.
   */
  readonly middlewareMs?: number | undefined;
  /**
   * How long a read of a record the request was then not served from took, before this: one that
   * turned out to be none, for a member of a class with no shell (`serveMemberWithoutShell`), or to
   * be one the edge does not serve — a status other than 200, or expired, which the Worker renders
   * again.
   */
  readonly recordLookupMs?: number | undefined;
  /** The reads of storage before this, for a document it could not serve (`PassthroughWait`). */
  readonly storageReads?: number | undefined;
  /** The dispatches of a resume let go before this (`PassthroughWait`). */
  readonly resumeDispatches?: number | undefined;
  /** The dispatches of an asset's answer the client was not handed (`PassthroughWait`). */
  readonly assetDispatches?: number | undefined;
  /** A regeneration asked beside this as a request of its own (`PassthroughWait`). */
  readonly regeneration?: DetachedRegeneration | undefined;
  readonly projectId: string;
  readonly manifestId: string;
  readonly policyId: string;
  readonly pathname: string;
  readonly colo: string;
}

/**
 * Why a request went to the application's Function: one of its routing patterns would cost more
 * against this request than the edge runs (`budgetPatterns`), so the Function routes it instead.
 */
export const PATTERN_BUDGET = 'pattern-budget';
/** What the edge waited on before it handed the request on, where it waited on more than routing. */
export interface PassthroughWait {
  readonly recordLookupMs?: number | undefined;
  /**
   * The reads of storage made for a document the edge then could not serve: its shell's, which
   * failed, and its rendering's beside it, each counted as a served document's are
   * (`storageReadsOf`).
   */
  readonly storageReads?: number | undefined;
  /**
   * The dispatches of the resume such a document had sent before its shell failed, which the edge
   * then let go (`fallbackToApp`): requests made all the same, none where none went out.
   */
  readonly resumeDispatches?: number | undefined;
  /**
   * The dispatches the asset strategy sent for an answer the client could not be handed, before its
   * own request was sent instead (`answerAsset`): requests made all the same, none where none went
   * out.
   */
  readonly assetDispatches?: number | undefined;
  /**
   * The regeneration of a stale record asked as a request of its own before the request was handed
   * on (`triggerDetached`), whose dispatches the point counts: it is written once they are made.
   */
  readonly regeneration?: DetachedRegeneration | undefined;
}

/** What the upstream could not be reached at all is reported as, with the reason kept. */
const UNREACHABLE_PREFIX = 'unreachable;';
/** What a split deployment's Workers disagreeing about a route is reported as (`MisroutedError`). */
const MISROUTED_PREFIX = 'misrouted;';
/** What was sent to Workers already removed, and answered by those that replaced them. */
const GONE_PREFIX = 'gone;';

/** What a request the edge gave up on is attributed to, taken from the context that gave up. */
export function passthroughMetrics(
  edge: EdgeContext,
  pathname: string,
  middlewareMs?: number,
): PassthroughMetrics {
  return {
    projectId: edge.projectId,
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    pathname,
    colo: edge.colo ?? '',
    ...(middlewareMs !== undefined && { middlewareMs }),
  };
}

export interface PassthroughInput {
  readonly request: Request;
  /**
   * The branch of the body the edge forwards, where the host's observer asked for a copy of it
   * (`CopyRequestBody`): the request's own body is the other branch's source, and read no more.
   */
  readonly observedBody?: ReadableStream<Uint8Array> | undefined;
  readonly forwarding: ForwardingContext;
  readonly runtime: EdgeRuntime;
  /** Its credentials, taken off what is forwarded; what it is told; what says a Function is gone. */
  readonly host: EdgeHost;
  /** The hosted application to dispatch to; `undefined` proxies to the network origin. */
  readonly app: AppRuntime | undefined;
  readonly cspReportingPath?: string | undefined;
  /**
   * The app Worker to send it to, for a deployment split across several, where the caller knows — a
   * shell's route names its own. Otherwise read off the request with `manifest`'s tables
   * (`functionOfRequest`), or the first.
   */
  readonly function?: string | undefined;
  readonly manifest?: ProjectManifest | undefined;
  /** Take a mutation's invalidations when its routing manifest is still being read. */
  readonly observeInvalidation?:
    | ((invalidated: { readonly value: string; readonly bound: string | null }) => void)
    | undefined;
  readonly reason: string;
  /** The request carried a validation header the edge accepted, so the candidate answered it. */
  readonly validated?: boolean | undefined;
  /**
   * Nothing the project serves is to be kept, by a browser or a cache between (`privateDelivery`):
   * the answer is `no-store`, whatever the Worker said, as every answer the edge composes for such a
   * project is.
   */
  readonly privateDelivery?: boolean | undefined;
  /**
   * What the application's middleware decided, when the edge ran it and then found nothing to
   * serve itself: the request goes on as the middleware left it, and the runtime is told so — and
   * that the edge lays the header rules it judged before it (`judgedRules`), where it did.
   */
  readonly middleware?:
    | (MiddlewareContinue & {
        readonly rewriteStatus?: number | undefined;
        readonly judgedRules?: ConfiguredHeaders | undefined;
      })
    | undefined;
  /** What the edge tells the runtime beside the request, set after the forwarding headers. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /**
   * The request answered again from the pointer KV holds now, for when the Workers this one was
   * sent to are gone; `undefined` where that is not a different deployment. Live traffic only, and
   * only once: the request it routes carries none of its own.
   */
  readonly whenGone?: (() => Promise<Response | undefined>) | undefined;
  /** Absent where the request never reached a project, and there is nothing to attribute. */
  readonly metrics?: PassthroughMetrics | undefined;
  /**
   * Told, as the request goes out, how to read what it has asked of the application's Workers so
   * far, as a point counts it (`dispatchesMade`), where it writes none of its own: a regeneration
   * asked behind another request's answer, whose point counts it however far it has got when that
   * point is written — answered, or not yet (`triggerDetached`).
   */
  readonly onAsked?: ((soFar: () => number) => void) | undefined;
}

/** The router prefetches Next.js's client sends (`next-router-prefetch`), by the number it uses. */
const PREFETCH_KINDS: ReadonlySet<string> = new Set(['1', '2', '3']);

/**
 * Which router prefetch the request was (`EdgeMetric.prefetch`): the client's own number, empty for
 * none, and `other` for a value Next.js never sends — the header is the client's to write, and
 * what is recorded stays one of five.
 */
function prefetchKindOf(request: Request): string {
  const value = request.headers.get(NEXT_ROUTER_PREFETCH_HEADER);
  if (value === null) {
    return '';
  }
  return PREFETCH_KINDS.has(value) ? value : 'other';
}

/**
 * Counted from the upstream request, not from the request the client made: what was spent before
 * this — a middleware that ran out its deadline, a shell that was looked for — belongs to the
 * decision to proxy, and the reason says which decision that was.
 */
function reportPassthrough(
  input: PassthroughInput,
  outcome: string,
  startedAt: number,
  pending: Promise<Response>,
): void {
  const { metrics } = input;
  if (metrics === undefined) {
    return;
  }
  const dispatched = dispatchedSoFar(pending);
  const elapsed = input.runtime.now() - startedAt;
  const point: EdgeMetric = {
    projectId: metrics.projectId,
    kind: 'passthrough',
    pathname: metrics.pathname,
    shellStrategy: '',
    shellSource: '',
    outcomeKind: outcome,
    colo: metrics.colo,
    originCacheHeader: '',
    manifestId: metrics.manifestId,
    policyId: metrics.policyId,
    encoding: '',
    middlewareMs: metrics.middlewareMs,
    recordLookupMs: metrics.recordLookupMs,
    fn: dispatched?.fn,
    redispatch: dispatched?.redispatched === true ? 1 : 0,
    prefetch: prefetchKindOf(input.request),
    ttfbInternalMs: 0,
    shellLookupMs: 0,
    originFirstByteMs: elapsed,
    originTotalMs: 0,
    shellBytes: 0,
    suffixBytes: 0,
    recovery: 0,
    retry: 0,
    assetHit: 0,
    // The Workers asked, and what came before them — reads of storage, a resume let go, an asset's
    // answer the client was not handed — as a served document's point counts each.
    subrequests:
      dispatchesMade(pending) +
      (metrics.storageReads ?? 0) +
      (metrics.resumeDispatches ?? 0) +
      (metrics.assetDispatches ?? 0),
  };
  // And a regeneration asked beside it, once it has made its dispatches.
  if (metrics.regeneration === undefined) {
    observeMetric(input.host, point);
  } else {
    metrics.regeneration.record(point);
  }
}

/** The request as the middleware left it: its URL and its headers. */
function afterMiddleware(client: Request, middleware: MiddlewareContinue): Request {
  return new Request(middleware.url.href, {
    ...requestInit(client),
    headers: middleware.requestHeaders,
  });
}

/**
 * Tell the runtime the middleware already ran, and hand the render the cookies it set. After the
 * forwarding headers are built: a client cannot carry platform headers, or `x-middleware-*` ones,
 * past the edge, and that is enforced by stripping the prefixes there.
 */
function markMiddlewareDone(
  request: Request,
  client: Request,
  middleware: NonNullable<PassthroughInput['middleware']>,
): void {
  request.headers.set(MIDDLEWARE_DONE_HEADER, '1');
  // The header rules of `next.config`, judged on the request as the client sent it, which the edge
  // lays on the answer itself where the runtime says it left them off (`HEADER_RULES_LEFT_HEADER`).
  if (middleware.judgedRules !== undefined) {
    request.headers.set(HEADER_RULES_JUDGED_HEADER, '1');
  }
  // The status the middleware gave its rewrite, which the runtime answers the route under as one it
  // ran the middleware for itself.
  if (middleware.rewriteStatus !== undefined) {
    request.headers.set(MIDDLEWARE_REWRITE_STATUS_HEADER, String(middleware.rewriteStatus));
  }
  if (middleware.rewritten) {
    request.headers.set(ORIGINAL_URL_HEADER, client.url);
  }
  if (middleware.setCookie !== undefined) {
    request.headers.set(MIDDLEWARE_SET_COOKIE_HEADER, middleware.setCookie);
  }
}

function requestInit(request: Request): RequestInit & { duplex?: 'half' } {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return {
    method: request.method,
    redirect: 'manual',
    // Cancelled with the client's, as the request the middleware did not change is.
    signal: request.signal,
    ...(hasBody && { body: request.body, duplex: 'half' }),
  };
}

/**
 * What `x-arkor-edge` says of a passthrough: why. And for a validated request to a deployment split
 * across app Workers, which one it asked first — what a probe of each is judged by, and what an
 * edge that does not know the probe's claim never says.
 */
function passthroughDebug(input: PassthroughInput, answer: Response): string {
  // Foreground regeneration must identify the already selected deployment and its loaded policy.
  // This only extends the existing header; dispatch and the original response stream are unchanged.
  const identity =
    input.reason === 'regenerate' && input.metrics !== undefined && input.app !== undefined
      ? `;m=${input.metrics.manifestId};policy=${input.metrics.policyId};scope=${input.app.deploymentId}`
      : '';
  const debug = `passthrough;reason=${input.reason}${identity}`;
  const dispatched = input.validated === true ? dispatchedOf(answer) : undefined;
  return dispatched === undefined ? debug : `${debug};fn=${dispatched.asked}`;
}

/**
 * A request sent to Workers that are gone, answered by the deployment that replaced them.
 *
 * Gone because this isolate served a pointer past its TTL: it does that however old the pointer is,
 * and a host may remove a deployment's Workers soon after another replaces it, while an idle
 * isolate can still hold the pointer that named them — such a request would otherwise be answered
 * 502. Nothing is in front of any other request: this runs only after the dispatch has failed, and
 * only for a request with no body, since one with a body handed it to the dispatch that failed.
 */
async function answeredAgain(
  input: PassthroughInput,
  error: unknown,
): Promise<Response | undefined> {
  if (
    input.whenGone === undefined ||
    input.request.body !== null ||
    !input.host.functionGone(error)
  ) {
    return undefined;
  }
  try {
    return await input.whenGone();
  } catch (retryError) {
    logWarn('a request to removed Workers could not be routed again', {
      detail: retryError instanceof Error ? retryError.message : String(retryError),
    });
    return undefined;
  }
}

/** Keep a mutation's next navigation from seeing a generation older than its invalidation. */
function takeResponseInvalidation(input: PassthroughInput, response: Response): void {
  const value = response.headers.get(INVALIDATED_TAGS_HEADER);
  if (value === null) {
    return;
  }
  // A deployment's cache scope is its deployment id, as `fetchUpstream` already tells the
  // Function (`withScopeRevision`). A cold manifest must not let an Action's next navigation
  // serve an older generation while its lookup is still out. Prefer the manifest's scope where
  // it is known, and let the deferred observer take it there too once that lookup lands.
  const scopeId = input.manifest?.cache?.scopeId ?? input.app?.deploymentId;
  const invalidated = { value, bound: response.headers.get(INVALIDATED_REVISION_HEADER) };
  if (scopeId !== undefined) {
    takeInvalidation(input.runtime.memory, scopeId, invalidated);
  }
  if (input.manifest === undefined) {
    input.observeInvalidation?.(invalidated);
  }
}

/**
 * What the edge lays on the Worker's answer to a request it ran the middleware for, over the
 * Worker's own: the header rules the runtime left to the edge (`HEADER_RULES_LEFT_HEADER`), read off
 * the answer as it came, before the edge's protocol is taken off it — a runtime from before it lays
 * the rules itself and says nothing, and none is laid twice — and the middleware's headers over
 * them, as Next.js's router collects the two ahead of the route.
 */
function layAfterMiddleware(
  headers: Headers,
  answer: Response,
  middleware: NonNullable<PassthroughInput['middleware']>,
  scope: ForwardingContext,
): void {
  const { judgedRules } = middleware;
  if (judgedRules !== undefined && answer.headers.get(HEADER_RULES_LEFT_HEADER) === '1') {
    layConfiguredOver(headers, judgedRules, scope, nominatedBy(answer.headers));
  }
  // After the Worker's own, which may repeat the middleware's cookies as Next.js writes them back
  // (`splice/cookies.ts`): a browser keeps the last of a cookie set twice, and the middleware's is
  // the one it meant — a `Max-Age=0` that the copy before it lost, say.
  mergeScopedMiddlewareHeaders(headers, middleware.responseHeaders, scope);
}

/** Transparent proxy to the deployment's Worker: any method, streamed body, rewritten cookies. */

export async function handlePassthrough(input: PassthroughInput): Promise<Response> {
  const client = new Request(input.request, {
    headers: stripEdgeHeaders(input.request.headers),
    // A stream in place of the request's own body, which Fetch takes in half-duplex mode alone: a
    // runtime that keeps to the standard refuses the request without it.
    ...(input.observedBody !== undefined && { body: input.observedBody, duplex: 'half' }),
  });
  const forwarded =
    input.middleware === undefined ? client : afterMiddleware(client, input.middleware);
  const originRequest = buildPassthroughRequest(
    forwarded,
    input.forwarding,
    input.host.credentials,
  );
  if (input.middleware !== undefined) {
    markMiddlewareDone(originRequest, client, input.middleware);
  }
  if (input.headers !== undefined) {
    const told = Object.entries(input.headers);
    for (const [name, value] of told) {
      originRequest.headers.set(name, value);
    }
  }
  // Read off the request as the Worker is handed it: the middleware's URL and headers, where the
  // edge ran it, and the forwarding headers.
  const fn = input.function ?? functionOfRequest(input.app, input.manifest, originRequest);
  const startedAt = input.runtime.now();
  const pending = fetchUpstream(input.runtime, input.app, originRequest, fn);
  input.onAsked?.(() => dispatchesMade(pending));
  let originResponse: Response;
  try {
    originResponse = await pending;
  } catch (error) {
    if (error instanceof MisroutedError) {
      reportPassthrough(input, `${MISROUTED_PREFIX}${input.reason}`, startedAt, pending);
      return badGatewayResponse('function-misrouted');
    }
    const again = await answeredAgain(input, error);
    if (again !== undefined) {
      reportPassthrough(input, `${GONE_PREFIX}${input.reason}`, startedAt, pending);
      return again;
    }
    // Both hops, where the Worker the first named was the one that could not be reached.
    reportPassthrough(input, `${UNREACHABLE_PREFIX}${input.reason}`, startedAt, pending);
    return badGatewayResponse('app-unreachable');
  }
  // Read before the header goes with every other the edge's protocol reserves, below.
  takeResponseInvalidation(input, originResponse);
  const response = forwardedResponse(originResponse, input.forwarding, input.request.method);
  const headers = response.headers;
  if (input.middleware !== undefined) {
    layAfterMiddleware(headers, originResponse, input.middleware, input.forwarding);
  }
  privateCacheControl(headers);
  if (input.privateDelivery === true) {
    keptByNobody(headers);
  }
  headers.set(EDGE_DEBUG_HEADER, passthroughDebug(input, originResponse));
  // Ordinary passthroughs do not name a manifest; foreground regeneration names its selected
  // deployment above. Whether the validation header was accepted is only the edge's to say. Taken
  // off first: an upstream's own is stripped with every other platform header above, and a
  // middleware's is merged in after that. A validation that reaches a Worker this way is then known
  // to have reached the candidate's, which is what a check of a static export's not-found needs to
  // know.
  headers.delete(EDGE_VALIDATED_HEADER);
  if (input.validated === true) {
    headers.set(EDGE_VALIDATED_HEADER, '1');
  }
  applyCspReporting(headers, input.app === undefined ? undefined : input.cspReportingPath);
  // After the response exists, so nothing the client waits for is behind it.
  reportPassthrough(input, input.reason, startedAt, pending);
  return response;
}
