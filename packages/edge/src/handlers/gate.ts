import { gateFor, type ProjectManifest, type RouteGate } from '@stayingupwind/core/manifest';
import {
  EDGE_DEBUG_HEADER,
  type ForwardingContext,
  PatternBudgetExceededError,
  RSC_HEADER,
} from '@stayingupwind/core/request';
import { isHtmlContentType, releaseStream, withDeadline } from '@stayingupwind/core/util';
import {
  GATE_ANSWER_HEADER,
  GATE_DEPLOYMENT_HEADER,
  GATE_HEADER_PREFIX,
  GATE_PASS,
  GATE_ROUTE_HEADER,
} from '@stayingupwind/host/bindings';
import type { CspNonceMode } from '@stayingupwind/host/delivery';

import type { EdgeGates, EdgeHost } from '../edge-host.ts';
import { buildPassthroughRequest } from '../forwarding.ts';
import { logWarn } from '../observability/logger.ts';
import { stripEdgeHeaders } from '../request-context.ts';
import { appendConfigured, setConfigured } from './configured-headers.ts';
import {
  acceptsNonce,
  applyNonceToHeaders,
  cspMarkers,
  mintCspNonce,
  rewriteDocumentNonces,
  withoutPolicies,
} from './csp-nonce.ts';
import { applyCspReporting } from './csp-reporting-headers.ts';
import { gateBodyDecodedByFetch } from './gate-body-encoding.ts';
import { decompressLive } from './live-compression.ts';
import { headerRulesAsRouted } from './middleware.ts';
import {
  forwardedResponse,
  keptByNobody,
  serviceUnavailableResponse,
  unsharedUnlessPublic,
} from './responses.ts';

/**
 * A request of a route the build declared a gate for (`ProjectManifest.gates`), asked of that gate
 * before the edge decides anything else of it: whether a document is served from a shell or a
 * record, a router's request handed to the Function, a prefetch answered from storage — a `HEAD`
 * and a conditional request as well. What the gate says is final for the request, and only for it.
 *
 * The gate is handed the visitor's request as the deployment's Function would be (`gateRequest`),
 * told the route it is of (`GATE_ROUTE_HEADER`). An answer that says to go on (`GATE_PASS`) is let
 * go, and the request goes on as it would with no gate, its answer kept from shared caches even
 * where the application permits public caching: the gate admitted this visitor alone. Any other
 * answer is the visitor's,
 * status, headers and body as the gate gave them, finished as a Function's answer the edge hands
 * on is (`gateAnswer`) — and like such an answer, kept nowhere: no cache, no memory of the edge's
 * holds it, so the next request is the gate's to answer again. A gate the host binds none of, one
 * that fails, and one that does not answer in time (`GATE_TIMEOUT_MS`) are all answered that the
 * gate is unavailable, never with what the edge holds of the route.
 *
 * Asked of `GET` and `HEAD` alone: any other method goes to the application's Function, a Server
 * Action's among them, as it does with no gate. Nor of a request whose validation the edge accepted,
 * which proves what the deployment stores and not what a gate makes of a visitor. Nothing takes a
 * request on to a gated route after its gate is asked: a rewrite of `next.config` may reach none,
 * which the bundle is refused for where one could (`rewritesOnto`), and a build with a middleware,
 * whose rewrites no build can know, declares no gate at all (`gateIssues`).
 */

/** How long the edge waits on a route's gate before it answers that the gate is unavailable. */
export const GATE_TIMEOUT_MS = 20_000;
/** Why a request of a gated route was answered 503: its gate did not answer it. */
const GATE_UNAVAILABLE = 'gate-unavailable';
const SWITCHING_PROTOCOLS = 101;
const NORMAL_SOCKET_CLOSE = 1000;
/**
 * Why one was where no route could be found for it within what the request may spend testing the
 * application's patterns (`budgetPatterns`): it may be of a gated route, and is answered as one
 * whose gate did not answer, never handed on as though it had none.
 */
const GATE_PATTERN_BUDGET = 'gate-pattern-budget';

/** What a request brings to its gate, once the deployment it is of is known to declare one. */
export interface GateInput {
  readonly request: Request;
  readonly url: URL;
  readonly manifest: ProjectManifest;
  /**
   * The headers the request is routed on: the visitor's, the host's credentials taken off where
   * a rule of the application's would read one, as the request is classified on them.
   */
  readonly routedHeaders: Headers;
  readonly host: EdgeHost;
  readonly forwarding: ForwardingContext;
  /** The request carried a validation the edge accepted. */
  readonly validated: boolean;
  /** Nothing the project serves is to be kept, by a browser or a cache between (`keptByNobody`). */
  readonly privateDelivery: boolean;
  /** Where the host collects the deployment's policy reports, where it does. */
  readonly cspReportingPath: string | undefined;
  /**
   * How the edge mints a document's nonce, where the project handed nonces over
   * (`EdgeContext.cspNonce`): the policy it goes in, and whether `'strict-dynamic'` goes beside it.
   * None for a project that did not.
   */
  readonly cspNonce: { readonly mode: CspNonceMode; readonly strictDynamic: boolean } | undefined;
  /** The host's clock, read only where a gate is actually asked. */
  readonly now?: (() => number) | undefined;
  /** A dispatched gate passed; its existing downstream request metric includes that dispatch. */
  readonly passed?: (() => void) | undefined;
  /** A terminal gate answer, before returning it; a pass is counted by its downstream handler. */
  readonly terminal?:
    | ((
        response: Response,
        route: string | undefined,
        elapsed: number,
        dispatched: boolean,
      ) => void)
    | undefined;
}

function ignore(): void {
  // A late answer that fails has nothing left to let go of.
}

/** A gate's response has no right to retain the visitor's upgrade or an abandoned body. */
function releaseAnswer(answer: Response): void {
  const socket = answer.webSocket;
  if (socket !== null) {
    try {
      socket.accept();
    } catch {
      // An already accepted endpoint can still be closed below.
    }
    try {
      socket.close(NORMAL_SOCKET_CLOSE, 'gate');
    } catch {
      // A socket that already ended is still no gate authorization to forward.
    }
  }
  releaseStream(answer.body, 'gate');
}

/** Let go of what a gate given up on answers with, once it does. */
async function releaseLate(answering: Promise<Response>): Promise<void> {
  releaseAnswer(await answering);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Conditional validators that could keep a nonce document from being answered whole. */
const VALIDATOR_HEADERS: readonly string[] = ['if-none-match', 'if-modified-since'];
/** The validators, length and digests of the gate's saved bytes, which a minted nonce changes. */
const REPRESENTATION_HEADERS: readonly string[] = [
  'etag',
  'last-modified',
  'content-length',
  'content-digest',
  'content-md5',
  'repr-digest',
  'digest',
];
const NOT_MODIFIED_STATUS = 304;
const CONTENT_ENCODING = 'content-encoding';

/** The gate protocol's reserved fields removed from a visitor's request or terminal answer. */
function stripGateHeaders(headers: Headers): void {
  const names = [...headers.keys()].filter((name) => name.startsWith(GATE_HEADER_PREFIX));
  for (const name of names) {
    headers.delete(name);
  }
}

/**
 * The visitor's request as the deployment's Function would be handed it (`buildPassthroughRequest`):
 * on the host the visitor asked, its headers forwarded, the host's credentials taken off. Told the
 * route, and the deployment it is of where the manifest names one, by the edge alone: whatever the
 * visitor sent under the protocol's names is taken off first.
 *
 * Of a project that handed nonces over, a request for a document goes without the visitor's
 * validators (`VALIDATOR_HEADERS`): its gate answers it whole, for the edge to give it a nonce of
 * its own, as the edge composes a document whole — its continuation asked with none
 * (`sanitizeContinuationHeaders`), its validators kept from the visitor. A 304 would have the browser
 * keep a page stamped with another response's nonce under this one's policy.
 */
function gateRequest(input: GateInput, gate: RouteGate, signal: AbortSignal): Request {
  const client = new Request(input.request, {
    headers: stripEdgeHeaders(input.request.headers),
    signal,
  });
  const asked = buildPassthroughRequest(client, input.forwarding, input.host.credentials);
  stripGateHeaders(asked.headers);
  asked.headers.set(GATE_ROUTE_HEADER, gate.route);
  const deployment = input.manifest.deployment.dplId;
  if (deployment !== undefined) {
    asked.headers.set(GATE_DEPLOYMENT_HEADER, deployment);
  }
  if (input.cspNonce !== undefined) {
    // Even a payload request can receive terminal HTML that needs nonce rewriting.
    asked.headers.set('accept-encoding', 'identity');
    asked.headers.delete('range');
    asked.headers.delete('if-range');
    // A document is any request but a payload's, `RSC: 1` alone, as read elsewhere.
    if (asked.headers.get(RSC_HEADER) !== '1') {
      for (const name of VALIDATOR_HEADERS) {
        asked.headers.delete(name);
      }
    }
  }
  return asked;
}

/** The gate's answer, as a promise however it fails: one that throws as it is asked rejects. */
async function answerOf(gates: EdgeGates, gate: RouteGate, request: Request): Promise<Response> {
  return gates.answer(gate.name, request, gate.route);
}

/**
 * What the gate answered, or `undefined` where it did not: none bound, a failure, or no answer
 * within `GATE_TIMEOUT_MS`. One past the deadline is cancelled, as a middleware past its budget is
 * (`runMiddleware`), and whatever it answers after is let go unread; so is one whose visitor left.
 */
async function askGate(input: GateInput, gate: RouteGate): Promise<Response | undefined> {
  const { gates } = input.host;
  if (gates === undefined) {
    logWarn('a gated route has no gate to ask', { gate: gate.name, route: gate.route });
    return undefined;
  }
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, input.request.signal]);
  const answering = answerOf(gates, gate, gateRequest(input, gate, signal));
  try {
    return await withDeadline(answering, GATE_TIMEOUT_MS, 'gate');
  } catch (error) {
    controller.abort(error);
    void releaseLate(answering).catch(ignore);
    logWarn('a gate did not answer', {
      gate: gate.name,
      route: gate.route,
      detail: describe(error),
    });
    return undefined;
  }
}

/**
 * The nonce a gate's document is answered with, minted for this response alone and put in its
 * policies, where the project handed nonces over and the document's policy has somewhere for one
 * (`acceptsNonce`) — as the edge mints one for a document it composes (`documentHeaders`). A gate
 * answers with a page kept for every visitor — rendered once, through this edge, with the nonce
 * minted for that one response — and replayed so, every visitor would be sent one nonce, which a
 * nonce may never be. A 304, which a gate asked with no validator (`gateRequest`) has no cause to
 * answer, goes with no policy at all. Nothing is read of an answer of a project that did not opt in.
 */
function gateNonce(input: GateInput, response: Response): string | undefined {
  const { cspNonce } = input;
  if (cspNonce === undefined) {
    return undefined;
  }
  const { headers } = response;
  if (response.status === NOT_MODIFIED_STATUS) {
    // A 304 refreshes what the browser kept with the headers it carries: a policy on one would name
    // a nonce the page it kept does not hold. It keeps the policy it kept with the page.
    withoutPolicies(headers);
    return undefined;
  }
  if (!isHtmlContentType(headers.get('content-type')) || !acceptsNonce(headers)) {
    return undefined;
  }
  // A HEAD can refresh a cached GET's headers, whose body carries another response's nonce.
  if (input.request.method === 'HEAD') {
    keptByNobody(headers);
  }
  const nonce = mintCspNonce();
  applyNonceToHeaders(headers, nonce, cspNonce.mode, cspNonce.strictDynamic);
  // These name the gate's saved bytes, not the stamped document. A HEAD's length would describe
  // that stamped GET too, whose size cannot be known without reading it.
  for (const name of REPRESENTATION_HEADERS) {
    headers.delete(name);
  }
  return nonce;
}

const SET_COOKIE = 'set-cookie';

/**
 * The rules of `next.config` this request matches, laid over a gate's answer as the deployment's
 * router lays them over its Function's (`withRoutingHeaders`, in the runtime): each header a rule
 * names but Location over the answer's own, a cookie beside the answer's — judged as the edge judges them for
 * whatever it answers itself (`headerRulesAsRouted`). A gate answers with a page kept for every
 * visitor, which went out under the rules the request it was made for matched: those that hold for
 * every request it carries as these lay them again, a cookie excepted, which it keeps none of; one
 * a request's headers, cookies or query choose is this request's. Throws where a rule costs more
 * against the request than the edge runs (`PatternBudgetExceededError`).
 */
function layHeaderRules(input: GateInput, headers: Headers): void {
  const { manifest, forwarding } = input;
  if (manifest.headerRules === undefined || manifest.headerRules.length === 0) {
    return;
  }
  const { host, url, request } = input;
  const rules = headerRulesAsRouted({ host, forwarding }, manifest, url, request.headers);
  for (const [name, value] of Object.entries(rules.headers)) {
    // Routing rules cannot distinguish a redirect's Location from an ordinary header rule.
    if (name === 'location') {
      continue;
    }
    if (name === SET_COOKIE) {
      appendConfigured(headers, name, value, forwarding);
    } else {
      setConfigured(headers, name, value, forwarding);
    }
  }
}

/**
 * The gate's own answer, finished as an answer of the Function the edge hands on is
 * (`handlePassthrough`): what the edge's protocol reserves taken off, the gate's among it, a cookie
 * scoped to the visitor's host, kept by no cache between — `private, no-store` where the gate said
 * nothing of it — and by none at all for a project whose delivery is private. The rules of
 * `next.config` the request matches laid over it (`layHeaderRules`) — where one costs more than the
 * edge runs, answered as a request whose gate cannot be found in time is (`gateBudgetSpent`), never
 * handed on. A document given the nonce the edge minted for it (`gateNonce`), in its headers and on
 * its scripts (`rewriteDocumentNonces`). Streamed as it comes.
 */
function gateAnswer(input: GateInput, gate: RouteGate, answer: Response): Response {
  let response = forwardedResponse(answer, input.forwarding, input.request.method);
  try {
    layHeaderRules(input, response.headers);
  } catch (error) {
    if (!(error instanceof PatternBudgetExceededError)) {
      throw error;
    }
    releaseStream(response.body, 'gate');
    return gateBudgetSpent();
  }
  // Each hop's nominations apply to its own fields, even where a rule replaces Connection.
  if ((input.manifest.headerRules?.length ?? 0) > 0) {
    response = forwardedResponse(response, input.forwarding, input.request.method);
  }
  const { headers } = response;
  stripGateHeaders(headers);
  unsharedUnlessPublic(headers, false);
  if (input.privateDelivery) {
    keptByNobody(headers);
  }
  const nonce = gateNonce(input, response);
  const { cspNonce } = input;
  const csp = cspMarkers(nonce, cspNonce?.mode, cspNonce?.strictDynamic === true);
  headers.set(EDGE_DEBUG_HEADER, `gate;name=${gate.name}${csp}`);
  applyCspReporting(headers, input.cspReportingPath);
  if (nonce === undefined) return response;
  if (response.body === null) {
    headers.delete(CONTENT_ENCODING);
    return response;
  }
  const decoded = decodedNonceDocument(response, input.host.gates);
  if (decoded === undefined) {
    releaseStream(response.body, 'gate');
    return serviceUnavailableResponse(GATE_UNAVAILABLE);
  }
  return rewriteDocumentNonces(decoded, nonce);
}

/**
 * The visitor's answer from the gate of `gate`'s route — the gate's own, or the edge's that it is
 * unavailable — or `undefined` where the gate says to go on.
 */
async function answeredAtGate(input: GateInput, gate: RouteGate): Promise<Response | undefined> {
  const answer = await askGate(input, gate);
  if (answer === undefined) {
    return serviceUnavailableResponse(GATE_UNAVAILABLE);
  }
  if (answer.status === SWITCHING_PROTOCOLS || answer.webSocket !== null) {
    releaseAnswer(answer);
    return serviceUnavailableResponse(GATE_UNAVAILABLE);
  }
  if (answer.headers.get(GATE_ANSWER_HEADER) === GATE_PASS) {
    releaseStream(answer.body, 'gate');
    return undefined;
  }
  return gateAnswer(input, gate, answer);
}

async function throughGate(
  input: GateInput,
  gate: RouteGate,
  routed: () => Promise<Response>,
): Promise<Response> {
  const started = input.now?.() ?? 0;
  const answer = await answeredAtGate(input, gate);
  if (answer === undefined) {
    input.passed?.();
    const response = await routed();
    const admitted = new Response(response.body, response);
    unsharedUnlessPublic(admitted.headers, false);
    return admitted;
  }
  const elapsed = (input.now?.() ?? started) - started;
  input.terminal?.(answer, gate.route, elapsed, input.host.gates !== undefined);
  return answer;
}

/**
 * The edge's answer to a request whose route cannot be found within what it may spend testing the
 * application's patterns (`budgetPatterns`) of a deployment that declares a gate: it may be of a
 * gated route, and is answered as one whose gate did not answer, never handed on as though it had
 * none — a request of the route itself (`gateOf`), and one for an image whose source it may be
 * (`routeHostedImage`).
 */
export function gateBudgetSpent(): Response {
  return serviceUnavailableResponse(GATE_PATTERN_BUDGET);
}

/**
 * The gate of the route that serves a request (`gateFor`), or the edge's answer where no route can
 * be found for it within what the request may spend testing the application's patterns
 * (`gateBudgetSpent`).
 */
function gateOf(input: GateInput): RouteGate | Response | undefined {
  try {
    return gateFor(input.manifest, input.url, input.routedHeaders);
  } catch (error) {
    if (!(error instanceof PatternBudgetExceededError)) {
      throw error;
    }
    return gateBudgetSpent();
  }
}

/**
 * The request routed as it would be with no gate (`routed`), where it is of no gated route, or
 * where its gate says to go on; otherwise the gate's answer, or the edge's that the gate is
 * unavailable (above). Asked only of a `GET` or a `HEAD` of a deployment that declares a gate.
 */
export function routeThroughGate(
  input: GateInput,
  routed: () => Promise<Response>,
): Promise<Response> {
  if (input.validated) {
    return routed();
  }
  const gate = gateOf(input);
  if (gate instanceof Response) {
    input.terminal?.(gate, undefined, 0, false);
    return Promise.resolve(gate);
  }
  return gate === undefined ? routed() : throughGate(input, gate, routed);
}

/** Content codings describe the input bytes and are removed once the gate's HTML is decoded. */
function decodedNonceDocument(
  response: Response,
  gates: EdgeGates | undefined,
): Response | undefined {
  const encoding = response.headers.get(CONTENT_ENCODING);
  if (encoding === null || encoding.trim() === '' || response.body === null) return response;
  const parts = encoding.split(',');
  const codings: ('br' | 'deflate' | 'gzip' | 'identity')[] = [];
  for (const part of parts) {
    const coding = part.trim().toLowerCase();
    if (!supportedCoding(coding)) return undefined;
    codings.push(coding);
  }
  // Fetch response bodies carry bytes; the Workers declaration leaves their element type open.
  let body = response.body as ReadableStream<Uint8Array>;
  const remaining = gateBodyDecodedByFetch(gates, encoding) ? [] : codings.toReversed();
  for (const coding of remaining) {
    if (coding !== 'identity') body = decompressLive(body, coding);
  }
  const headers = new Headers(response.headers);
  headers.delete(CONTENT_ENCODING);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: 'automatic',
  });
}

/** Content codings the nonce path can remove without inspecting or guessing another format. */
function supportedCoding(coding: string): coding is 'br' | 'deflate' | 'gzip' | 'identity' {
  return ['br', 'deflate', 'gzip', 'identity'].includes(coding);
}
