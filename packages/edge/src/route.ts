import type { AppRuntime, ProjectManifest } from '@stayingupwind/core/manifest';
import { MIDDLEWARE_DONE_HEADER } from '@stayingupwind/core/paas';
import {
  classifyRequest,
  type ForwardingContext,
  PatternBudgetExceededError,
  type RequestClass,
} from '@stayingupwind/core/request';
import { type EdgePointer, resolvePolicy } from '@stayingupwind/host/delivery';

import type { EdgeBindings } from './bindings.ts';
import { lookAtScope } from './cache/scope-signal.ts';
import type { EdgeHost } from './edge-host.ts';
import type { EdgeRuntime } from './edge-runtime.ts';
import { answerAsset } from './handlers/asset-answer.ts';
import { routeHostedDocument } from './handlers/hosted-document.ts';
import type { MiddlewareOutcome, MiddlewareTiming } from './handlers/middleware.ts';
import {
  handlePassthrough,
  type PassthroughInput,
  type PassthroughWait,
  PATTERN_BUDGET,
  passthroughReason,
} from './handlers/passthrough.ts';
import { serviceUnavailableResponse } from './handlers/responses.ts';
import { handleStaticFile } from './handlers/static-file.ts';
import { hostedFirst } from './hosted-first.ts';
import { getManifest, getPolicy, type PolicyLookup } from './preview/manifest.ts';
import { EDGE_MODE } from './preview/pointer.ts';
import { notDeployed, type PreviewState, stateFromPointer } from './preview/state.ts';
import { heldBehind, type Lookup, MISSING } from './preview/storage.ts';
import { coloOf, forwardingFor, type IncomingRequest } from './request-context.ts';
import type { EdgeContext, RequestTimings } from './strategies/context.ts';
import { edgeStrategyRegistry } from './strategies/registry.ts';

/**
 * A request whose project is known, from the reads its pointer names to the answer: what is left to
 * do once the host has said whether, and as what, the request is served. The host reads the pointer
 * and decides what it alone decides first; everything here is the edge's.
 */

const ASSET_CLASS = 'immutable-asset-candidate';
const STATIC_FILE_CLASS = 'static-file';
/** A request that names no route of the build may still be served one after the middleware. */
const ROUTE_NOT_PROVED = 'route-not-proved';
/** A probe of one app Worker of a split deployment (`fn`, signed): that Worker's to answer. */
const FUNCTION_PROBE = 'function-probe';

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
   * body, and a word once the answer is in (`PassthroughObservation`). Asked of every passthrough,
   * so it answers `undefined` at once for one it leaves alone; absent, none is observed.
   */
  readonly observePassthrough?:
    | ((
        request: IncomingRequest,
        url: URL,
        state: PreviewState,
      ) => PassthroughObservation | undefined)
    | undefined;
}

/**
 * Begin the request's look at where its scope stands (`lookAtScope`), where its deployment has a
 * cache: beside the reads the request makes, and waited for by none of them — what it brings is in
 * force once it lands, for this request where that is before it is judged, and for the next.
 */
function lookAtScopeOf(input: RoutingInput): void {
  const scope = input.state.manifest?.cache;
  if (scope === undefined || input.state.app === undefined) {
    return;
  }
  // A question to the authority is kept past the answer as the pointer's refresh is, among the
  // requests out (`heldBehind`); the look itself only has to end.
  const look = { runtime: input.runtime, host: input.host, waitUntil: heldBehind(input.ctx) };
  input.ctx.waitUntil(lookAtScope(look, scope.scopeId));
}

/**
 * A host's view of one passthrough: the copy of the request's body it reads, a branch of the body
 * forwarded beside it (`PassthroughInput.observedBody`), and what it is told once the answer is in —
 * the answer itself, or nothing where forwarding failed.
 */
interface PassthroughObservation {
  readonly body: ReadableStream<Uint8Array> | undefined;
  readonly finish: (response?: Response) => void;
}

/** The answer to an observed passthrough, its observer told as it comes, or that none came. */
async function finishObserved(
  pending: Promise<Response>,
  finish: PassthroughObservation['finish'],
): Promise<Response> {
  try {
    const response = await pending;
    finish(response);
    return response;
  } catch (error) {
    finish();
    throw error;
  }
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
  input: RoutingInput,
  reason: string,
  middleware?: MiddlewareOutcome & Partial<MiddlewareTiming>,
  { route, waited }: Counted = {},
): Promise<Response> {
  const { servedAgain } = input;
  const passthrough: PassthroughInput = {
    request: input.request,
    forwarding: forwardingFor(input.request, input.host.sharedDomain, input.url.hostname),
    runtime: input.runtime,
    host: input.host,
    app: input.state.app,
    cspReportingPath: input.state.cspReportingPath,
    // For the tables that say which app Worker the route is in, where the build split them; a
    // validation probe names its own.
    manifest: input.state.manifest,
    function: input.state.function,
    reason,
    validated: input.state.validated,
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
      // And a record read for the request that served nothing.
      ...(waited?.recordLookupMs !== undefined && { recordLookupMs: waited.recordLookupMs }),
    },
  };
  // Only a request the host observes pays for the observer; any other keeps the forwarding's own
  // promise.
  const observed = input.observePassthrough?.(input.request, input.url, input.state);
  if (observed === undefined) {
    return handlePassthrough(passthrough);
  }
  return finishObserved(
    handlePassthrough({ ...passthrough, observedBody: observed.body }),
    observed.finish,
  );
}

function servedAtEdge(classification: RequestClass): boolean {
  switch (classification.kind) {
    case 'document':
    case ASSET_CLASS:
    case STATIC_FILE_CLASS: {
      return true;
    }
    case 'passthrough': {
      // The middleware may still rewrite it onto a route the build prerendered.
      return classification.reason === ROUTE_NOT_PROVED;
    }
    case 'segment-prefetch': {
      // Taken in whatever this request's own route names, and left to `routeHostedDocument` to
      // answer or hand on: the middleware is what decides the route, so what the client asked for
      // says little about what holds the part. The root of a localised application is a rewrite to
      // `/en` or `/ja` and names no route at all, and a route that names no parts may still be
      // rewritten onto one that does.
      //
      // Refusing the ones that name no parts was tried, to spare a build with none the middleware.
      // It spared nothing: where no matcher covers the path the middleware does not run either way
      // (`middlewareMatches` decides that there), and where one does, that is the rewrite this
      // exists to follow. What the coverage costs is one middleware subrequest on a prefetch of a
      // matched path that turns out to hold no part — and the Function runs the middleware anyway.
      return true;
    }
    case 'rsc-payload': {
      // Taken by the route its own URL names, which holds a payload to answer with: the middleware
      // may still put the request on another route, as it may a prefetch's (`routeHostedDocument`).
      return true;
    }
    case 'pages-data': {
      // Taken by the page whose props the build wrote, unless a middleware is to run for it, which
      // `routeHostedDocument` leaves to the Function rather than run in a data request's way.
      return true;
    }
    case 'rsc':
    case 'action': {
      return false;
    }
  }
}

/** The policy and the manifest a pointer names, read side by side (`startReads`). */
export interface PointerReads {
  readonly policyLookup: Promise<PolicyLookup>;
  readonly manifestLookup: Promise<Lookup<ProjectManifest>>;
}

/** The policy and the manifest the pointer names, read together; neither rejects. */
export function startReads(input: {
  readonly env: EdgeBindings;
  readonly ctx: ExecutionContext;
  readonly runtime: EdgeRuntime;
  readonly pointer: EdgePointer;
}): PointerReads {
  const { env, ctx, runtime, pointer } = input;
  return {
    policyLookup: getPolicy(env, runtime, pointer.policyId, heldBehind(ctx)),
    manifestLookup:
      pointer.manifestId === undefined
        ? Promise.resolve(MISSING)
        : getManifest(env, runtime, pointer.manifestId, {
            namedSince: pointer.updatedAt,
            keep: heldBehind(ctx),
          }),
  };
}

/** A request the host has read the pointer for and let through, with what it decided of it. */
export interface PointerRequest {
  readonly request: IncomingRequest;
  readonly url: URL;
  readonly env: EdgeBindings;
  readonly ctx: ExecutionContext;
  readonly runtime: EdgeRuntime;
  readonly host: EdgeHost;
  readonly pointer: EdgePointer;
  /** How long the pointer's lookup took (`RequestTimings`). */
  readonly pointerMs: number;
  /** What the host says of the project: its responses are for the visitor let through alone. */
  readonly privateDelivery: boolean;
  /** The host's CSP collector path for the deployment, where it has one (`EdgeContext`). */
  readonly cspReportingPath: string | undefined;
  readonly servedAgain?: RoutingInput['servedAgain'];
  readonly observePassthrough?: RoutingInput['observePassthrough'];
}

/**
 * Live traffic: the two KV reads the pointer names, the manifest and the policy, overlap, so a
 * cold isolate pays one round trip for the pair rather than two in series. `reads` are the pair
 * where the host started them already, beside a wait of its own (`startReads`).
 */
export async function serveFromPointer(
  input: PointerRequest,
  reads?: PointerReads,
): Promise<Response> {
  const { request, url, env, ctx, runtime, host, pointer } = input;
  const manifestStarted = runtime.now();
  const { policyLookup, manifestLookup } = reads ?? startReads(input);
  const stored = await manifestLookup;
  const lookup = await policyLookup;
  // Read side by side, and waited on together: `man` is the wait for both, which the policy's own
  // can lengthen — a named policy with no document reads the stand-in's pointer and document after.
  // Reads the host started beside a wait of its own are timed from here: what this request waited
  // on them.
  const manifestMs = runtime.now() - manifestStarted;
  const state = stateFromPointer({
    runtime,
    pointer,
    stored,
    lookup,
    pathname: url.pathname,
    privateDelivery: input.privateDelivery,
    cspReportingPath: input.cspReportingPath,
  });
  const timings = { pointerMs: input.pointerMs, manifestMs, middlewareMs: undefined };
  return routeRequest({
    request,
    url,
    env,
    ctx,
    runtime,
    host,
    state,
    timings,
    servedAgain: input.servedAgain,
    observePassthrough: input.observePassthrough,
  });
}

/** Everything a handler may touch, once the manifest is known. */
function edgeContextFor(
  input: RoutingInput,
  manifest: ProjectManifest,
  forwarding: ForwardingContext,
): EdgeContext {
  const { request, env, ctx, runtime, host, state } = input;
  return {
    env,
    ctx,
    runtime,
    host,
    forwarding,
    app: state.app,
    originalUrl: undefined,
    headOnly: request.method === 'HEAD',
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
export async function routeRequest(input: RoutingInput): Promise<Response> {
  try {
    return await routeWithinBudget(input);
  } catch (error) {
    if (error instanceof PatternBudgetExceededError) {
      return passthroughFor(input, PATTERN_BUDGET);
    }
    throw error;
  }
}

async function routeWithinBudget(input: RoutingInput): Promise<Response> {
  const { request, url, state } = input;
  const forwarding = forwardingFor(request, input.host.sharedDomain, url.hostname);
  const passthrough = (reason: string): Promise<Response> => passthroughFor(input, reason);
  // A probe names the Worker it is for, and is that Worker's to answer whatever the path would be
  // served from otherwise — a catch-all's shell, say, answered here and resumed in a Worker the
  // probe did not name. Only a signed validation sets this.
  if (state.function !== undefined) {
    return passthrough(FUNCTION_PROBE);
  }
  lookAtScopeOf(input);
  const hosted = hostedFirst({
    request,
    url,
    app: state.app,
    manifest: state.manifest,
    edge: (manifest) => edgeContextFor(input, manifest, forwarding),
    passthrough: (reason, middleware) => passthroughFor(input, reason, middleware),
  });
  if (hosted !== undefined) {
    return hosted;
  }
  // With no Workers named yet — the first deployment still running, or failed — there is nowhere
  // to send the request: the only host the edge knows for the project is this very route, and
  // sending it there would arrive straight back here and go round again. The same whichever
  // hostname it came in on.
  if (notDeployed(state)) {
    return serviceUnavailableResponse('not-deployed');
  }
  if (state.mode !== EDGE_MODE || state.manifest === undefined) {
    return passthrough(state.passthroughReason);
  }
  const classification = classifyRequest({
    method: request.method,
    url,
    headers: request.headers,
    manifest: state.manifest,
    deployment: state.manifest.deployment,
  });
  if (!servedAtEdge(classification)) {
    return passthrough(passthroughReason(classification));
  }
  const resolved = resolvePolicy(edgeStrategyRegistry, state.policy);
  const edge = edgeContextFor(input, state.manifest, forwarding);
  if (classification.kind === STATIC_FILE_CLASS) {
    return handleStaticFile({
      request,
      pathname: classification.pathname,
      file: classification.file,
      edge,
    });
  }
  // The asset path fetches the file and answers with it: a `HEAD` of one is the origin's, as it was
  // before `HEAD` was classified with `GET`.
  if (classification.kind === ASSET_CLASS && request.method === 'HEAD') {
    return passthrough('head');
  }
  if (classification.kind === ASSET_CLASS) {
    const answered = await answerAsset({
      request,
      clientUrl: url,
      strategy: resolved.assets,
      edge,
    });
    // Or the client's own request, where the strategy's answer is not one to hand it.
    return answered ?? passthrough('asset-unshareable');
  }
  return routeHostedDocument({
    request,
    url,
    edge,
    manifest: state.manifest,
    resolved,
    classification,
    passthrough: (reason, middleware, route, waited) =>
      passthroughFor(input, reason, middleware, { route, waited }),
  });
}
