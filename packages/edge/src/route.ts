import type { AppRuntime, ProjectManifest } from '@stayingupwind/core/manifest';
import { MIDDLEWARE_DONE_HEADER } from '@stayingupwind/core/paas';
import {
  classifyRequest,
  EDGE_BYPASS_COOKIE,
  type ForwardingContext,
  getCookieValue,
  parseCookieHeader,
  PatternBudgetExceededError,
  type RequestClass,
  serializeCookieHeader,
} from '@stayingupwind/core/request';
import { type HostCredentials, withoutHostCredentials } from '@stayingupwind/host/credentials';
import { resolvePolicy } from '@stayingupwind/host/delivery';

import type { EdgeBindings } from './bindings.ts';
import { transferInvalidations } from './cache/condemned.ts';
import { lookAtScopeBehind } from './cache/scope-signal.ts';
import {
  classificationReadsCredentials,
  CLASSIFIED_HEADER_PREFIXES,
  CLASSIFIED_HEADERS,
  STATIC_CLASSIFIED_HEADERS,
} from './classification-credentials.ts';
import { manifestForClassification, servedAtEdge } from './classification.ts';
import type { EdgeHost } from './edge-host.ts';
import type { EdgeRuntime } from './edge-runtime.ts';
import { passthroughHeaders } from './forwarding.ts';
import { answerAsset } from './handlers/asset-answer.ts';
import { routeHostedFallbackPage } from './handlers/fallback-page.ts';
import { routeHostedDocument } from './handlers/hosted-document.ts';
import {
  dispatchedFor,
  type MiddlewareOutcome,
  type MiddlewareTiming,
} from './handlers/middleware.ts';
import { observeMetric } from './handlers/observer.ts';
import {
  finishObserved,
  type ObservePassthrough,
  observationOf,
} from './handlers/passthrough-observer.ts';
import {
  handlePassthrough,
  type PassthroughInput,
  type PassthroughWait,
  PATTERN_BUDGET,
  passthroughReason,
} from './handlers/passthrough.ts';
import { safeDiagnosticField, serviceUnavailableResponse } from './handlers/responses.ts';
import { routeHostedBody } from './handlers/route-body.ts';
import { routingReadsFor } from './handlers/routing-headers.ts';
import { routeHostedStaticPage } from './handlers/static-page.ts';
import { hostedFirst } from './hosted-first.ts';
import { withPatternBudget } from './pattern-budget.ts';
import {
  type DeferredRoutingInput,
  type ManifestRoutingInput,
  type PointerReads,
  type PointerRequest,
  servePointerRequest,
} from './preview/pointer-request.ts';
import { EDGE_MODE } from './preview/pointer.ts';
import { notDeployed, type PreviewState } from './preview/state.ts';
import { coloOf, forwardingFor, type IncomingRequest } from './request-context.ts';
import type { EdgeContext, RequestTimings, StaticFileContext } from './strategies/context.ts';
import { edgeStrategyRegistry } from './strategies/registry.ts';

export { type PointerReads, type PointerRequest, startReads } from './preview/pointer-request.ts';

/**
 * A request whose project is known, from the reads its pointer names to the answer: what is left to
 * do once the host has said whether, and as what, the request is served. The host reads the pointer
 * and decides what it alone decides first; everything here is the edge's.
 */

const ASSET_CLASS = 'immutable-asset-candidate';
const ROUTE_BODY_CLASS = 'route-body';
const STATIC_PAGE_CLASS = 'static-page';
const FALLBACK_PRIVACY = 3;
/** A probe of one app Worker of a split deployment (`fn`, signed): that Worker's to answer. */
const FUNCTION_PROBE = 'function-probe';
const NOT_DEPLOYED = 'not-deployed';
/** Next.js's own paths, the build's files chief among them: nothing under them is judged by a tag. */
const NEXT_OWN_PATHS = '/_next/';

/** A request routed by the edge, with what it knows of the project and what it waited on for it. */
export interface RoutingInput {
  readonly request: IncomingRequest;
  readonly url: URL;
  readonly env: EdgeBindings;
  readonly ctx: ExecutionContext;
  readonly runtime: EdgeRuntime;
  readonly host: EdgeHost;
  readonly state: PreviewState;
  readonly timings: RequestTimings;
  /**
   * The request routed again from the pointer KV holds now, past this isolate's copy: a live
   * request's way back when the Workers it was served by (`served`) are gone (`answeredAgain`, in
   * `passthrough.ts`); `undefined` where the pointer still names them, which a second try would only
   * find gone too. Absent where there is no second try: for a request the host serves by something
   * other than a pointer, and for a request already routed again.
   */
  readonly servedAgain?:
    | ((served: AppRuntime | undefined) => Promise<Response | undefined>)
    | undefined;
  /**
   * What the host observes of a request the edge hands on, where it observes it: a copy of the
   * body (`copyBody`), and a word once the answer is in (`PassthroughObservation`). Asked of every
   * passthrough, so it answers `undefined` at once for one it leaves alone; absent, none is
   * observed. The request's own body is the one forwarded, and is never the observer's to read: it
   * is shown the request without it (`ObservedRequest`), and the answer to read (`ObservedResponse`).
   */
  readonly observePassthrough?: ObservePassthrough | undefined;
}

export type {
  CopyRequestBody,
  ObservedRequest,
  ObservedResponse,
  ObservePassthrough,
  PassthroughObservation,
} from './handlers/passthrough-observer.ts';

/** Keep hosts that already supply a full state on their synchronous routing path. */
function afterPolicy<T>(
  input: ManifestRoutingInput,
  serve: (ready: RoutingInput) => Promise<T>,
): Promise<T> {
  return 'policyReady' in input ? afterDeferredPolicy(input, serve) : serve(input);
}

async function afterDeferredPolicy<T>(
  input: DeferredRoutingInput,
  serve: (ready: RoutingInput) => Promise<T>,
): Promise<T> {
  return serve(await input.policyReady());
}

/**
 * What a passthrough is counted under: the route a document was classified as, where it was, and
 * what it waited on before it was handed on.
 */
interface Counted {
  readonly route?: string | undefined;
  readonly waited?: PassthroughWait | undefined;
}

function passthroughFor(
  input: ManifestRoutingInput,
  reason: string,
  middleware?: MiddlewareOutcome & Partial<MiddlewareTiming>,
  { route, waited }: Counted = {},
): Promise<Response> {
  const { servedAgain } = input;
  const manifestReady = 'manifestReady' in input ? input.manifestReady : undefined;
  const passthrough: PassthroughInput = {
    request: input.request,
    waitUntil: (work) => {
      input.ctx.waitUntil(work);
    },
    forwarding: forwardingFor(input.request, input.host.sharedDomain, input.url.hostname),
    runtime: input.runtime,
    host: input.host,
    app: input.state.app,
    cspReportingPath: input.state.cspReportingPath,
    // For the tables that say which app Worker the route is in, where the build split them; a
    // validation probe names its own.
    manifest: input.state.manifest,
    ...(manifestReady !== undefined && {
      observeInvalidation: (): void => {
        input.ctx.waitUntil(
          (async () => {
            const manifest = await manifestReady;
            if (
              manifest?.cache !== undefined &&
              manifest.cache.scopeId !== input.state.app?.deploymentId
            ) {
              transferInvalidations(
                input.runtime.memory,
                input.state.app?.deploymentId,
                manifest.cache.scopeId,
              );
            }
          })(),
        );
      },
    }),
    function: input.state.function,
    reason,
    validated: input.state.validated,
    privateDelivery: input.state.privateDelivery,
    ...(middleware?.kind === 'continue' && { middleware }),
    // A probe proves the Worker it names answers, and nothing of what the middleware would make of
    // the path — as validation proves a shell and not the middleware's redirect or cookie
    // (`routeHostedDocument`) — so the Worker is told the middleware ran, and routes the path
    // itself rather than running it once for every Worker probed.
    ...(input.state.function !== undefined && { headers: { [MIDDLEWARE_DONE_HEADER]: '1' } }),
    ...(servedAgain !== undefined && { whenGone: () => servedAgain(input.state.app) }),
    metrics: {
      projectId: input.state.projectId,
      manifestId: input.state.manifestId,
      policyId: input.state.policy.id,
      // The route a document was classified as, where it was: a member of a dynamic route counts
      // under its class, as the document path counts it, not under a pathname of its own.
      pathname: route ?? input.url.pathname,
      colo: coloOf(input.request) ?? '',
      // What the middleware took before this gave up on it, where it is what was given up on.
      ...(middleware?.middlewareMs !== undefined && { middlewareMs: middleware.middlewareMs }),
      ...(middleware !== undefined && {
        middlewareDispatches: middleware.middlewareDispatches ?? dispatchedFor(middleware),
      }),
      // And what came before it was handed on (`PassthroughWait`): a record read for the request
      // that served nothing; what a document it could not serve took, reads of storage and a resume
      // let go; and a regeneration a stale record asked for on its own.
      ...waited,
    },
  };
  // Only a request the host observes pays for the observer; any other keeps the forwarding's own
  // promise.
  const observed = observationOf(input);
  if (observed === undefined) {
    return handlePassthrough(passthrough);
  }
  const forwarding = handlePassthrough({ ...passthrough, observedBody: observed.forwarded });
  return observed.finish === undefined ? forwarding : finishObserved(forwarding, observed.finish);
}

/**
 * A copy of `headers` with the host's credentials taken off, keeping the edge's own cookie
 * (`EDGE_BYPASS_COOKIE`) where the visitor sent it. The edge's recovery sets it for the edge, which
 * turns the visitor's next request away from the shell for it, and forwarding takes it off what
 * any application is handed (`sanitizePassthroughHeaders`). Taken off here with the `cookie`
 * header whole, or by its name, it would leave a visitor whose page broke on the same shell again.
 */
function withoutCredentials(headers: Headers, credentials: HostCredentials): Headers {
  const copy = withoutHostCredentials(new Headers(headers), credentials);
  const own = getCookieValue(headers.get('cookie'), EDGE_BYPASS_COOKIE);
  const left = copy.get('cookie');
  if (own !== undefined && getCookieValue(left, EDGE_BYPASS_COOKIE) === undefined) {
    const pairs = [...parseCookieHeader(left), { name: EDGE_BYPASS_COOKIE, value: own }];
    copy.set('cookie', serializeCookieHeader(pairs));
  }
  return copy;
}

/** The classifier reads these before routing; removing one would admit a request it must pass on. */
function keptForClassification(name: string, headers: Headers): boolean {
  if (name === 'cookie') {
    return getCookieValue(headers.get('cookie'), EDGE_BYPASS_COOKIE) !== undefined;
  }
  return (
    (name !== 'host' &&
      name !== 'x-real-ip' &&
      (CLASSIFIED_HEADERS.has(name) || STATIC_CLASSIFIED_HEADERS.has(name))) ||
    CLASSIFIED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * The headers a request is classified on (`classifyRequest`), and its route's conditions are judged
 * on where no middleware runs (`requestAsLeft`): the class of a member served from its record, what
 * a route is not served a prerender under. The application's conditions among them are judged
 * without the host's own credentials (`withoutHostCredentials`), as the middleware's matchers are
 * (`routedHeaders`): the application's routing is never handed them, so a `missing` that names one
 * holds for every request, and a `has` that names one for none. Removing credentials copies only
 * where a condition can read one (`routingReadsFor`), not for any condition at all: Next.js writes
 * one on `rsc` into every build with a deployment id.
 *
 * What the classification reads by name besides — a router's headers, a navigation's, draft mode's
 * cookies — is read on the same headers, and a host that keeps one of those as its own has them
 * copied for that alone (`classificationReadsCredentials`): Next.js is never handed it either.
 * Every forwarding field read by the manifest (`routingReadsFor`) takes its forwarded value,
 * including the public country header the forwarder supplies. The client markers used by
 * classification, including the recovery cookie, stay as they came (`keptForClassification`).
 */
function headersToClassify(
  manifest: ProjectManifest | undefined,
  headers: Headers,
  credentials: HostCredentials,
  forwarding: ForwardingContext,
): Headers {
  const kept = credentials.cookies.length > 0 || credentials.headers.length > 0;
  const routing = manifest === undefined ? undefined : routingReadsFor(manifest, credentials);
  const staticPages = manifest?.staticPages !== undefined || manifest?.pagesFallbacks !== undefined;
  const copied =
    kept && (classificationReadsCredentials(credentials, staticPages) || routing?.reads === true);
  const classified = copied ? withoutCredentials(headers, credentials) : headers;
  const fields = routing?.forwardedFields ?? [];
  if (fields.length === 0) return classified;
  let forwarded: Headers | undefined;
  let routed = classified;
  for (const name of fields) {
    if (keptForClassification(name, headers)) continue;
    forwarded ??= passthroughHeaders(headers, forwarding, credentials);
    if (routed === headers) routed = new Headers(classified);
    const value = forwarded.get(name);
    if (value === null) routed.delete(name);
    else routed.set(name, value);
  }
  return routed;
}

/** Serve the pointer's manifest as soon as the answer's required reads have arrived. */
export function serveFromPointer(input: PointerRequest, reads?: PointerReads): Promise<Response> {
  return servePointerRequest(input, routeRequest, reads);
}

/** Everything a handler may touch, once the manifest is known. */
function edgeContextFor(
  input: RoutingInput,
  manifest: ProjectManifest,
  forwarding: ForwardingContext,
): EdgeContext;
function edgeContextFor(
  input: ManifestRoutingInput,
  manifest: ProjectManifest,
  forwarding: ForwardingContext,
): StaticFileContext;
function edgeContextFor(
  input: ManifestRoutingInput,
  manifest: ProjectManifest,
  forwarding: ForwardingContext,
): StaticFileContext {
  const { request, env, ctx, runtime, host, state, servedAgain } = input;
  return {
    env,
    ctx,
    runtime,
    host,
    forwarding,
    app: state.app,
    originalUrl: undefined,
    policy: state.policy,
    cspNonce: state.cspNonce,
    cspNonceMode: state.cspNonceMode,
    cspStrictDynamic: state.cspStrictDynamic,
    cspReportingPath: state.cspReportingPath,
    cacheApi: state.cacheApi,
    privateDelivery: state.privateDelivery,
    assetMaxBytes: manifest.assetPolicy.maxBytes,
    projectId: state.projectId,
    manifestId: state.manifestId,
    colo: coloOf(request),
    validated: state.validated,
    demotedRoutes: state.demotedRoutes,
    timings: input.timings,
    // As a passthrough's (`passthroughFor`).
    ...(servedAgain !== undefined && { whenGone: () => servedAgain(state.app) }),
  };
}

/**
 * A request whose project is known, routed: answered at the edge where the manifest says it can be,
 * and handed to the deployment's Workers where it cannot — or, where one of the application's
 * routing patterns would cost more against it than a test is allowed (`budgetPatterns`), handed to
 * the application's Function, which routes it as Next.js does at no other application's expense.
 * Before its middleware ran: a part of the routing the edge does after it hands the request on with
 * what the middleware decided itself (`routeHostedDocument`, `serveAfterMiddleware`).
 */
export function routeRequest(input: ManifestRoutingInput): Promise<Response> {
  return withPatternBudget(() => routeWithBudget(input));
}

async function routeWithBudget(input: ManifestRoutingInput): Promise<Response> {
  try {
    return await routeWithinBudget(input);
  } catch (error) {
    if (error instanceof PatternBudgetExceededError) {
      return passthroughFor(input, PATTERN_BUDGET);
    }
    throw error;
  }
}

function routeWithinBudget(input: ManifestRoutingInput): Promise<Response> {
  const { request, url, state } = input;
  const forwarding = forwardingFor(request, input.host.sharedDomain, url.hostname);
  const passthrough = (
    reason: string,
    middleware?: MiddlewareOutcome,
    waited?: PassthroughWait,
  ): Promise<Response> => passthroughFor(input, reason, middleware, { waited });
  // A probe names the Worker it is for, and is that Worker's to answer whatever the path would be
  // served from otherwise — a catch-all's shell, say, answered here and resumed in a Worker the
  // probe did not name. Only a signed validation sets this.
  if (state.function !== undefined) {
    return passthrough(FUNCTION_PROBE);
  }
  const hosted = hostedFirst({
    request,
    url,
    app: state.app,
    manifest: state.manifest,
    edge: (manifest) => edgeContextFor(input, manifest, forwarding),
    policyReady: (manifest) => {
      return 'policyReady' in input
        ? afterDeferredPolicy(input, (ready) =>
            Promise.resolve(edgeContextFor(ready, manifest, forwarding)),
          )
        : edgeContextFor(input, manifest, forwarding);
    },
    passthrough,
  });
  if (hosted !== undefined) {
    return hosted;
  }
  // With no Workers named yet — the first deployment still running, or failed — there is nowhere
  // to send the request: the only host the edge knows for the project is this very route, and
  // sending it there would arrive straight back here and go round again. The same whichever
  // hostname it came in on.
  if (notDeployed(state)) {
    observeMetric(input.host, {
      projectId: state.projectId,
      kind: 'passthrough',
      pathname: url.pathname,
      shellStrategy: '',
      shellSource: '',
      outcomeKind: NOT_DEPLOYED,
      colo: coloOf(request) ?? '',
      originCacheHeader: '',
      manifestId: state.manifestId,
      policyId: state.policy.id,
      encoding: '',
      ttfbInternalMs: 0,
      shellLookupMs: 0,
      originFirstByteMs: 0,
      originTotalMs: 0,
      shellBytes: 0,
      suffixBytes: 0,
      recovery: 0,
      retry: 0,
      assetHit: 0,
      subrequests: 0,
      pointerLookupMs: input.timings.pointerMs,
      manifestLookupMs: input.timings.manifestMs,
    });
    return Promise.resolve(serviceUnavailableResponse(NOT_DEPLOYED));
  }
  // The core classifier decides which non-read requests are Actions and which are other methods;
  // neither can use a manifest's files or pages. A single Function may reach here before its
  // manifest, and a split deployment has already read its tables to choose the right Function.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const classification = classifyRequest({
      method: request.method,
      url,
      headers: headersToClassify(undefined, request.headers, input.host.credentials, forwarding),
      manifest: undefined,
      deployment: undefined,
    });
    return passthrough(passthroughReason(classification));
  }
  return routeWithManifest(input, forwarding);
}

/**
 * Begin the request's look at where its scope stands (`lookAtScopeBehind`), beside what it reads and
 * waited for by none of it. What the edge serves from a record is judged by what this isolate knows
 * of the scope, and so is what it hands to the scope's Functions, which are told where the scope
 * stands as this isolate knows it (`withScopeRevision`): a page Next.js routes there itself — behind
 * a rewrite the edge stays out of — or a route handler reads no record here, and is no less one an
 * invalidation reaches. Not for a path of Next.js's own, nor for a validation, which proves the
 * build and reads nothing of the cache; a file the build shipped and an optimized image are answered
 * before this (`hostedFirst`), and a request of another method is handed on before its manifest is
 * in (`routeWithinBudget`).
 */
function lookAtScopeOf(input: ManifestRoutingInput, scopeId: string): void {
  if (input.state.validated || input.url.pathname.startsWith(NEXT_OWN_PATHS)) {
    return;
  }
  lookAtScopeBehind(
    { app: input.state.app, ctx: input.ctx, host: input.host, runtime: input.runtime },
    scopeId,
  );
}

/** Read the policy only once the request is known to need an edge strategy. */
function routeWithManifest(
  input: ManifestRoutingInput,
  forwarding: ForwardingContext,
): Promise<Response> {
  const { request, url, state } = input;
  const passthrough = (reason: string): Promise<Response> => passthroughFor(input, reason);
  if (state.manifest?.cache !== undefined) {
    transferInvalidations(
      input.runtime.memory,
      state.app?.deploymentId,
      state.manifest.cache.scopeId,
    );
    lookAtScopeOf(input, state.manifest.cache.scopeId);
  }
  if (state.mode !== EDGE_MODE || state.manifest === undefined) {
    // This pointer field is opaque; internal middleware reasons retain their structured fields.
    return passthrough(safeDiagnosticField(state.passthroughReason));
  }
  const classifiedHeaders = headersToClassify(
    state.manifest,
    request.headers,
    input.host.credentials,
    forwarding,
  );
  const classification = classifyRequest({
    method: request.method,
    url,
    headers: classifiedHeaders,
    manifest: manifestForClassification(state.manifest, state.validated),
    deployment: state.manifest.deployment,
  });
  if (!servedAtEdge(classification)) {
    return passthrough(passthroughReason(classification));
  }
  // The asset path fetches the file and answers with it: a `HEAD` of one is the origin's, as it was
  // before `HEAD` was classified with `GET`.
  if (classification.kind === ASSET_CLASS && request.method === 'HEAD') {
    return passthrough('head');
  }
  if (classification.kind === ROUTE_BODY_CLASS && request.method === 'HEAD') {
    return passthrough('route-body-head');
  }
  if (classification.kind === STATIC_PAGE_CLASS && request.method === 'HEAD') {
    return passthrough('static-page-head');
  }
  const manifest = state.manifest;
  return afterPolicy(input, (ready) =>
    routeClassified(ready, manifest, forwarding, { classification, headers: classifiedHeaders }),
  );
}

/** The request needs an edge strategy, and its policy settings now govern its answer. */
async function routeClassified(
  input: RoutingInput,
  manifest: ProjectManifest,
  forwarding: ForwardingContext,
  classified: { readonly classification: RequestClass; readonly headers: Headers },
): Promise<Response> {
  const { request, url, state } = input;
  const { classification, headers: classifiedHeaders } = classified;
  const resolved = resolvePolicy(edgeStrategyRegistry, state.policy);
  const edge = edgeContextFor(input, manifest, forwarding);
  if (classification.kind === ASSET_CLASS) {
    // Or the client's own request, where the strategy's answer is not one to hand it, counted with
    // what the strategy sent for that answer.
    return answerAsset(
      { request, clientUrl: url, strategy: resolved.assets, edge },
      (assetDispatches) =>
        passthroughFor(input, 'asset-unshareable', undefined, { waited: { assetDispatches } }),
    );
  }
  if (
    classification.kind === 'pages-fallback' ||
    (classification.kind === STATIC_PAGE_CLASS &&
      classification.entry.staticPagePrivacy === FALLBACK_PRIVACY)
  ) {
    return routeHostedFallbackPage({
      request,
      url,
      edge,
      manifest,
      classification,
      classifiedHeaders,
      resolved,
      passthrough: (reason, middleware, waited) =>
        passthroughFor(input, reason, middleware, { waited }),
    });
  }
  if (classification.kind === ROUTE_BODY_CLASS || classification.kind === STATIC_PAGE_CLASS) {
    const handler =
      classification.kind === ROUTE_BODY_CLASS ? routeHostedBody : routeHostedStaticPage;
    return handler({
      request,
      url,
      edge,
      manifest,
      entry: classification.entry,
      classifiedHeaders,
      passthrough: (reason, middleware, waited) =>
        passthroughFor(input, reason, middleware, { waited }),
    });
  }
  return routeHostedDocument({
    request,
    url,
    edge,
    manifest,
    resolved,
    classification,
    classifiedHeaders,
    passthrough: (reason, middleware, route, waited) =>
      passthroughFor(input, reason, middleware, { route, waited }),
  });
}
