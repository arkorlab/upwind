import {
  bodyHeaders,
  bodyTypeAllowed,
  narrowCacheControl,
  noTransform,
} from '@stayingupwind/core/bundle';
import {
  type ConfiguredHeaders,
  isReserved,
  type RouteBodyEntry,
} from '@stayingupwind/core/manifest';
import {
  classifyRequest,
  EDGE_DEBUG_HEADER,
  hasRouteBodyControlHeader,
  manifestIdPrefix,
  removeSharedCacheOverrides,
  policyRefusesSharing,
} from '@stayingupwind/core/request';
import { runtimeCacheOf, type RuntimeCacheSettings } from '@stayingupwind/host/delivery';

import { condemnedIn } from '../cache/condemned.ts';
import { decideGeneration, type GenerationDecision } from '../cache/decision.ts';
import { type GenerationLoad, loadGeneration, readServedAgain } from '../cache/generation-hold.ts';
import { foregroundDocument, shouldAsk, triggerDetached } from '../cache/regenerate.ts';
import type { EdgeMetric } from '../observability/metrics.ts';
import { layStoredConfiguredOver, withJudgedRules } from './configured-headers.ts';
import { type HostedGateInput, serveAfterMiddleware, type TimedContinue } from './hosted-gate.ts';
import { offTheEdge } from './hosted-route.ts';
import { serveHostedFile } from './hosted-static-file.ts';
import { handedHeaders } from './middleware.ts';
import { observeMetric, observeServed } from './observer.ts';
import { PATTERN_BUDGET, type PassthroughWait } from './passthrough.ts';
import { carriesApplicationCredentials, mergeScopedMiddlewareHeaders } from './responses.ts';

/** Only the host's manifest and authority record permit sharing; a Function's answer never does. */
export interface RouteBodyInput extends HostedGateInput {
  readonly entry: RouteBodyEntry;
  readonly classifiedHeaders: Headers;
  readonly passthrough: (
    reason: string,
    middleware?: Parameters<HostedGateInput['passthrough']>[1],
    waited?: PassthroughWait,
  ) => Promise<Response>;
}

const HTTP_OK = 200;
const CONTENT_TYPE = 'content-type';
const CONTENT_ENCODING = 'content-encoding';
const CONTENT_RANGE = 'content-range';
const SET_COOKIE = 'set-cookie';
const BODY_UNSHAREABLE = 'route-body-unshareable';
const CACHE_DISABLED = 'route-body-cache-disabled';
const ENTITY_HEADERS: ReadonlySet<string> = new Set([
  'accept-ranges',
  'content-length',
  CONTENT_ENCODING,
  CONTENT_RANGE,
  'etag',
]);
/** Conditions and ranges are still the Function's to evaluate against its own full response. */
const CONDITIONAL_HEADERS = [
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
] as const;
function configuredRefusesSharing(configured: ConfiguredHeaders): boolean {
  const fields = new Map<string, string>();
  for (const [name, value] of Object.entries(configured.headers)) {
    fields.set(name.toLowerCase(), value);
  }
  return policyRefusesSharing({ get: (name) => fields.get(name) ?? null });
}

function applicationCredentials(input: RouteBodyInput, headers: Headers): boolean {
  return carriesApplicationCredentials(headers, input.edge.host.credentials);
}

/**
 * What makes a body one visitor's whatever the middleware decides: the project's, a validation's,
 * or the credentials the request was classified with — which the middleware taking them away does
 * not make the request anyone's (`visitorSpecific`).
 */
function visitorSpecificAhead(input: RouteBodyInput): boolean {
  return (
    input.edge.privateDelivery ||
    input.edge.validated ||
    applicationCredentials(input, input.classifiedHeaders)
  );
}

function visitorSpecific(input: RouteBodyInput, headers: Headers): boolean {
  return (
    visitorSpecificAhead(input) ||
    (headers !== input.classifiedHeaders && applicationCredentials(input, headers)) ||
    CONDITIONAL_HEADERS.some((name) => headers.has(name))
  );
}

/**
 * What the rules of `next.config` set that no shared body may carry: conditions, a refusal, or a
 * cookie. Judged on the request as it came, before the middleware, as Next.js's router judges them.
 */
function configuredRefuses(configured: ConfiguredHeaders): boolean {
  return (
    configured.conditioned ||
    configuredRefusesSharing(configured) ||
    Object.keys(configured.headers).some((name) => name.toLowerCase() === SET_COOKIE)
  );
}

function middlewareRefusesSharing(middleware: TimedContinue | undefined): boolean {
  return (
    middleware?.responseHeaders.has(SET_COOKIE) === true ||
    middleware?.setCookie !== undefined ||
    middleware?.routeBodyPrivate === true ||
    (middleware !== undefined && policyRefusesSharing(middleware.responseHeaders)) ||
    (middleware?.rewriteStatus !== undefined && middleware.rewriteStatus !== HTTP_OK)
  );
}

/** Middleware protocol inputs remain decisive before and after forwarding removes credentials. */
function controlledMiddleware(middleware: TimedContinue | undefined, headers: Headers): boolean {
  return (
    middleware !== undefined &&
    (hasRouteBodyControlHeader(middleware.requestHeaders) || hasRouteBodyControlHeader(headers))
  );
}

/** No record read for a response that belongs to one visitor or still needs HTTP conditions. */
function needsFunction(
  input: RouteBodyInput,
  headers: Headers,
  configured: ConfiguredHeaders,
  middleware: TimedContinue | undefined,
): boolean {
  return (
    visitorSpecific(input, headers) ||
    configuredRefuses(configured) ||
    middlewareRefusesSharing(middleware)
  );
}

/**
 * Why a body is the Function's whatever the middleware decides, known before it runs: one visitor's
 * (`visitorSpecificAhead`), or under rules no shared body may carry (`configuredRefuses`), or under
 * a policy that serves none from records. `undefined` where only the middleware's decision can say
 * — what it adds or takes away, the route it moves the request to (`serveBody`).
 */
function refusedAhead(input: RouteBodyInput, configured: ConfiguredHeaders): string | undefined {
  if (visitorSpecificAhead(input) || configuredRefuses(configured)) {
    return BODY_UNSHAREABLE;
  }
  const disabled =
    input.manifest.cache === undefined || runtimeCacheOf(input.edge.policy).generations !== 'on';
  return disabled ? CACHE_DISABLED : undefined;
}

/** A read of the record of the body the request was classified as, begun beside the middleware. */
interface EarlyRecordRead {
  readonly entryId: string;
  readonly load: Promise<GenerationLoad>;
}

/**
 * Begin reading the record of the body the request was classified as, so that the answer the
 * middleware lets through need not wait for its round trip and then for the read in series — as a
 * shipped file's read is begun (`routeHostedStaticFile`). Nothing for a body off the edge, nor for a
 * request that carries a condition, which the Function answers unless the middleware takes it away:
 * a read for those is wasted far more often than not.
 */
function startRecordRead(input: RouteBodyInput): EarlyRecordRead | undefined {
  const { edge, manifest, entry } = input;
  const settings = runtimeCacheOf(edge.policy);
  if (
    manifest.cache === undefined ||
    settings.generations !== 'on' ||
    offTheEdge(edge, entry) !== undefined ||
    CONDITIONAL_HEADERS.some((name) => input.classifiedHeaders.has(name))
  ) {
    return undefined;
  }
  const key = { scopeId: manifest.cache.scopeId, entryId: entry.entryId };
  return { entryId: entry.entryId, load: loadGeneration(edge, key, settings) };
}

/**
 * Let a read no answer takes finish, into the isolate's memory, for the next request that wants it.
 * Not counted among the answer's requests: a record's read is not, wherever the edge makes one.
 */
function letGo(input: RouteBodyInput, early: EarlyRecordRead | undefined): void {
  if (early !== undefined) {
    input.edge.ctx.waitUntil(early.load);
  }
}

function metric(
  input: RouteBodyInput,
  delivery: {
    readonly entry: RouteBodyEntry;
    readonly source: string;
    readonly validity: string;
    readonly lookupMs: number;
    readonly startedAt: number;
    readonly bytes: number;
    readonly dispatches: number;
    readonly middleware: TimedContinue | undefined;
  },
): EdgeMetric {
  const { edge } = input;
  const { entry, source, validity, lookupMs, startedAt, bytes, dispatches, middleware } = delivery;
  return {
    projectId: edge.projectId,
    kind: 'asset',
    pathname: entry.pathname,
    shellStrategy: '',
    shellSource: source,
    outcomeKind: `route-body-${validity}`,
    colo: edge.colo ?? '',
    originCacheHeader: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    encoding: '',
    ttfbInternalMs: edge.runtime.now() - startedAt,
    shellLookupMs: 0,
    recordLookupMs: lookupMs,
    originFirstByteMs: 0,
    originTotalMs: 0,
    shellBytes: 0,
    suffixBytes: bytes,
    recovery: 0,
    retry: 0,
    assetHit: 0,
    subrequests: dispatches,
    middlewareMs: middleware?.middlewareMs,
    pointerLookupMs: edge.timings.pointerMs,
    manifestLookupMs: edge.timings.manifestMs,
  };
}

/** What the middleware decided for a body, if it ran, and what was begun for it meanwhile. */
interface BodyDecided {
  readonly decided: TimedContinue | undefined;
  readonly dispatches: number;
  readonly configured: ConfiguredHeaders;
  /** The record read begun beside the middleware (`startRecordRead`): taken, or let go. */
  readonly early: EarlyRecordRead | undefined;
}

/** The body a request is served once routed past its middleware, or what answers in its place. */
type Routed =
  | { readonly entry: RouteBodyEntry; readonly scopeId: string }
  | { readonly answer: Promise<Response> };

/**
 * Route a request past what its middleware decided: the controls it set, a rewrite onto a rule or
 * a shipped file, the body the request then classifies as, and what makes that one the Function's.
 */
function routedBody(
  input: RouteBodyInput,
  middleware: TimedContinue | undefined,
  { dispatches, configured }: Pick<BodyDecided, 'dispatches' | 'configured'>,
): Routed {
  const { edge, manifest } = input;
  const url = middleware?.url ?? input.url;
  const headers =
    middleware === undefined
      ? input.classifiedHeaders
      : handedHeaders(edge, middleware.requestHeaders);
  // Judge middleware controls before forwarding can hide them, and before a rewrite reads a file.
  if (controlledMiddleware(middleware, headers)) {
    return { answer: input.passthrough(BODY_UNSHAREABLE, middleware) };
  }
  if (middleware?.rewritten === true) {
    if (isReserved(manifest, url, headers, true)) {
      return { answer: input.passthrough('reserved', middleware) };
    }
    const file = serveHostedFile({ ...input, configured }, url, middleware, dispatches);
    if (file !== undefined) return { answer: file };
  }
  const classification = classifyRequest({
    method: input.request.method,
    url,
    headers,
    manifest,
    deployment: manifest.deployment,
  });
  // Re-evaluate the request after middleware, including rewrites, pins and bypass conditions.
  if (
    classification.kind !== 'route-body' ||
    needsFunction(input, headers, configured, middleware)
  ) {
    return { answer: input.passthrough(BODY_UNSHAREABLE, middleware) };
  }
  const { entry } = classification;
  const withheld = offTheEdge(edge, entry);
  if (withheld !== undefined) {
    return { answer: input.passthrough(withheld, middleware) };
  }
  if (manifest.cache === undefined || runtimeCacheOf(edge.policy).generations !== 'on') {
    return { answer: input.passthrough(CACHE_DISABLED, middleware) };
  }
  return { entry, scopeId: manifest.cache.scopeId };
}

/** The body's record: read beside the middleware where that read is this body's, else read now. */
function recordOf(
  input: RouteBodyInput,
  routed: Extract<Routed, { readonly entry: RouteBodyEntry }>,
  early: EarlyRecordRead | undefined,
): Promise<GenerationLoad> {
  if (early?.entryId === routed.entry.entryId) {
    return early.load;
  }
  // The middleware moved the request onto another body: the read begun for the first fills memory.
  letGo(input, early);
  const key = { scopeId: routed.scopeId, entryId: routed.entry.entryId };
  return loadGeneration(input.edge, key, runtimeCacheOf(input.edge.policy));
}

async function serveBody(input: RouteBodyInput, body: BodyDecided): Promise<Response> {
  const { edge, manifest } = input;
  const { decided, dispatches, configured, early } = body;
  const middleware =
    decided === undefined ? undefined : withJudgedRules(decided, configured, manifest);
  const routed = routedBody(input, middleware, body);
  if ('answer' in routed) {
    letGo(input, early);
    return routed.answer;
  }
  const { entry } = routed;
  const settings = runtimeCacheOf(edge.policy);
  const startedAt = edge.runtime.now();
  const load = await recordOf(input, routed, early);
  const decision = decideGeneration(
    load,
    edge.runtime.now(),
    condemnedIn(edge.runtime.memory, edge.app?.deploymentId),
  );
  if (decision.kind === 'build' || decision.kind === 'passthrough') {
    return input.passthrough(`route-body-${decision.reason}`, middleware, {
      recordLookupMs: decision.lookupMs,
    });
  }
  const answered = bodyHeaders(decision.pack, entry);
  if (answered === undefined) {
    return input.passthrough('route-body-record-mismatch', middleware, {
      recordLookupMs: decision.lookupMs,
    });
  }
  const target = { pack: decision.pack, entryId: entry.entryId };
  if (decision.kind === 'regenerate') {
    readServedAgain(edge, decision.pack, settings);
    return foregroundDocument(
      edge,
      {
        request: input.request,
        middleware,
        target,
        function: entry.function,
      },
      { recordLookupMs: decision.lookupMs },
    );
  }
  return serveCurrentBody(input, {
    entry,
    decision,
    answered,
    configured,
    middleware,
    dispatches,
    settings,
    startedAt,
  });
}

/** Answer a current generation after all routing and validity decisions have completed. */
function serveCurrentBody(
  input: RouteBodyInput,
  current: {
    readonly entry: RouteBodyEntry;
    readonly decision: Extract<GenerationDecision, { kind: 'serve' }>;
    readonly answered: Headers;
    readonly configured: ConfiguredHeaders;
    readonly middleware: TimedContinue | undefined;
    readonly dispatches: number;
    readonly settings: RuntimeCacheSettings;
    readonly startedAt: number;
  },
): Promise<Response> | Response {
  const { edge } = input;
  const { entry, decision, answered, configured, middleware, dispatches, settings, startedAt } =
    current;
  const target = { pack: decision.pack, entryId: entry.entryId };
  // These are trusted generation bytes, not a public claim made on an application response.
  const recordNoTransform = noTransform(answered);
  layStoredConfiguredOver(answered, configured, edge.forwarding, ENTITY_HEADERS);
  const configuredNoTransform = noTransform(answered);
  if (middleware !== undefined) {
    mergeScopedMiddlewareHeaders(
      answered,
      middleware.responseHeaders,
      edge.forwarding,
      ENTITY_HEADERS,
    );
  }
  if (
    answered.has(SET_COOKIE) ||
    !bodyTypeAllowed(answered.get(CONTENT_TYPE) ?? '') ||
    policyRefusesSharing(answered)
  ) {
    return input.passthrough('route-body-response-unshareable', middleware, {
      recordLookupMs: decision.lookupMs,
    });
  }
  const untransformed =
    recordNoTransform ||
    configuredNoTransform ||
    noTransform(answered) ||
    (middleware !== undefined && noTransform(middleware.responseHeaders));
  removeSharedCacheOverrides(answered);
  narrowCacheControl(answered, middleware !== undefined, untransformed);
  answered.set(
    EDGE_DEBUG_HEADER,
    `route-body;src=${decision.source};cache=${decision.validity};m=${manifestIdPrefix(edge.manifestId)}`,
  );
  const response = new Response(decision.pack.html, {
    status: HTTP_OK,
    headers: answered,
  });
  if (decision.readBytes !== undefined) observeServed(edge.host, decision.readBytes);
  const point = metric(input, {
    entry,
    source: decision.source,
    validity: decision.validity,
    lookupMs: decision.lookupMs,
    startedAt,
    bytes: decision.pack.html.byteLength,
    dispatches,
    middleware,
  });
  const stale = decision.validity === 'stale';
  if (stale && shouldAsk(edge, entry.entryId, settings)) {
    triggerDetached(
      edge,
      {
        request: input.request,
        middleware,
        target,
        function: entry.function,
      },
      { attributeFunction: true },
    ).record(point);
  } else {
    observeMetric(edge.host, point);
  }
  if (stale) readServedAgain(edge, decision.pack, settings, { servedStale: true });
  return response;
}

/**
 * Non-document bytes use the existing gate and generation validity, with no HTML composition.
 *
 * The edge can serve a body after the middleware lets the request through, so a matcher covering it
 * is no reason to hand it on. What makes a body the Function's whatever the middleware decides is:
 * that is judged before the middleware runs, and such a request goes to the Function then, which
 * runs the middleware itself (`refusedAhead`). For the rest, the body's record is read beside the
 * middleware rather than behind it (`startRecordRead`).
 */
export function routeHostedBody(input: RouteBodyInput): Promise<Response> {
  // The build proves a GET body, not that an explicit HEAD handler has identical semantics.
  if (input.request.method === 'HEAD') return input.passthrough('route-body-head');
  // Classification may have removed host credentials; original control evidence still vetoes sharing.
  if (
    hasRouteBodyControlHeader(input.request.headers) ||
    hasRouteBodyControlHeader(input.classifiedHeaders)
  ) {
    return input.passthrough(BODY_UNSHAREABLE);
  }
  let early: EarlyRecordRead | undefined;
  const taken = (): EarlyRecordRead | undefined => {
    const read = early;
    early = undefined;
    return read;
  };
  const serve = (
    middleware: TimedContinue | undefined,
    dispatches: number,
    configured: ConfiguredHeaders,
  ): Promise<Response> =>
    serveBody(input, { decided: middleware, dispatches, configured, early: taken() });
  return serveAfterMiddleware(input, {
    handOn: (configured) => {
      const reason = refusedAhead(input, configured);
      return reason === undefined ? undefined : input.passthrough(reason);
    },
    start: () => {
      early = startRecordRead(input);
    },
    // What the middleware answered itself, or failed, or what a pattern's cost hands on, takes none.
    abandon: (): undefined => {
      letGo(input, taken());
    },
    overBudget: (middleware, _dispatches, configured) => {
      return input.passthrough(
        PATTERN_BUDGET,
        middleware === undefined
          ? undefined
          : withJudgedRules(middleware, configured, input.manifest),
      );
    },
    serve,
    rewritten: serve,
  });
}
