import { gateFor, type ProjectManifest, type RouteGate } from '@stayingupwind/core/manifest';
import {
  EDGE_DEBUG_HEADER,
  type ForwardingContext,
  NAVIGATION_REQUEST_HEADERS,
  PatternBudgetExceededError,
  RSC_HEADER,
  keptByNobody,
  unsharedUnlessPublic,
} from '@stayingupwind/core/request';
import {
  type BoundedBody,
  isHtmlContentType,
  readBoundedBody,
  releaseStream,
  type TtlCache,
  withDeadline,
} from '@stayingupwind/core/util';
import {
  decodeGateShell,
  GATE_ACCEPT_HEADER,
  GATE_ANSWER_HEADER,
  GATE_CAPTURE,
  GATE_CAPTURE_HEADER,
  GATE_DEPLOYMENT_HEADER,
  GATE_HEADER_PREFIX,
  GATE_PASS,
  GATE_ROUTE_HEADER,
  GATE_SCOPE_DOCUMENTS,
  GATE_SCOPE_HEADER,
  GATE_SHELL,
  type GateShell,
  isGateShellType,
  MAX_GATE_SHELL_BYTES,
  reachesUncoded,
} from '@stayingupwind/host/bindings';
import type { CspNonceMode } from '@stayingupwind/host/delivery';

import type { EdgeGates, EdgeHost } from '../edge-host.ts';
import { buildPassthroughRequest } from '../forwarding.ts';
import { documentGateKey } from '../memory/caches.ts';
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
import { forwardedResponse, serviceUnavailableResponse } from './responses.ts';

/**
 * A request of a route the build declared a gate for (`ProjectManifest.gates`), asked of that gate
 * before the edge decides anything else of it: whether a document is served from a shell or a
 * record, a router's request handed to the Function, a prefetch answered from storage — a `HEAD`
 * and a conditional request as well. What the gate says is final for the request, and only for it.
 *
 * The gate is handed the visitor's request as the deployment's Function would be (`gateRequest`),
 * told the route it is of (`GATE_ROUTE_HEADER`). An answer that says to go on (`GATE_PASS`) is let
 * go, and the request goes on as it would with no gate, its answer kept from shared caches even
 * where the application permits public caching: the gate admitted this visitor alone — a `GET` the
 * gate asks a capture of beside it (`GATE_CAPTURE_HEADER`) to the route's Function at once, told
 * so, served from nothing the edge holds and kept by nobody (`GateCapture`). An answer that is a
 * shell of the gate's own (`GATE_SHELL`) is read whole, and served as the route's runtime cache
 * serves a generation: completed by the route's Function, read nothing else for
 * (`GateShellDirective`), kept from shared caches as a pass's answer is. Any other answer is the
 * visitor's, status, headers and body as the gate gave them, finished as a Function's answer the
 * edge hands on is (`gateAnswer`) — and like such an answer, kept nowhere: no cache, no memory of
 * the edge's holds it, so the next request is the gate's to answer again. A gate the host binds
 * none of, one that fails, and one that does not answer in time (`GATE_TIMEOUT_MS`) are all
 * answered that the gate is unavailable, never with what the edge holds of the route; and so,
 * under a reason of its own, is a shell that is none, or that answers what no shell can
 * (`shellOf`).
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
/** Why one was: its gate answered with a shell whose bytes are none (`decodeGateShell`). */
const GATE_SHELL_MALFORMED = 'gate-shell-malformed';
/**
 * Why one was: its gate answered with a shell where the edge composes no document of one — for a
 * `HEAD`, or for a router's request — or one whose render answered other than 200, the only status
 * the edge composes a document under.
 */
const GATE_SHELL_UNSERVED = 'gate-shell-unserved';
const OK_STATUS = 200;

/**
 * What a gate's answer has the edge do with the request in its place (`routeThroughGate`): hand a
 * `GET` to the route's Function as a capture, or serve the gate's own shell.
 */
export type GateDirective = GateCapture | GateShellDirective;

/**
 * A capture a gate that said to go on asked for (`GATE_CAPTURE_HEADER`), of the route it was asked
 * about: the request handed to that route's Function told so, and its answer kept by nobody.
 */
export interface GateCapture {
  readonly kind: 'capture';
  readonly route: string;
}

/** A shell a gate answered with (`GATE_SHELL`), read whole and checked (`shellOf`). */
export interface GateShellDirective {
  readonly kind: 'shell';
  /** The gate that answered with it, which the document it is served as names. */
  readonly gate: string;
  readonly shell: GateShell;
  /** How long the gate took to answer with it, its bytes read: what the shell's lookup took. */
  readonly lookupMs: number;
}

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
  /**
   * Where the edge remembers the gates that decide a request that takes a shell alone
   * (`GATE_SCOPE_HEADER`), and the manifest this deployment's are remembered by: of such a gate's
   * route, any other request goes on unasked.
   */
  readonly documentGates?:
    | { readonly memory: TtlCache<string, true>; readonly manifestId: string }
    | undefined;
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
  const shell = takesShell(input.request);
  if (shell) {
    asked.headers.set(GATE_ACCEPT_HEADER, GATE_SHELL);
  }
  const deployment = input.manifest.deployment.dplId;
  if (deployment !== undefined) {
    asked.headers.set(GATE_DEPLOYMENT_HEADER, deployment);
  }
  // A shell is read whole, and so is what the edge gives a nonce of: a range of either is none.
  if (shell || input.cspNonce !== undefined) {
    asked.headers.delete('range');
    asked.headers.delete('if-range');
  }
  if (input.cspNonce !== undefined) {
    // Even a payload request can receive terminal HTML that needs nonce rewriting.
    asked.headers.set('accept-encoding', 'identity');
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
 * The capture a gate that says to go on asks for beside it (`GATE_CAPTURE_HEADER`), of a `GET`: a
 * `HEAD` renders nothing to capture, and goes on as though its gate had said only to go on.
 */
function captureOf(input: GateInput, gate: RouteGate, answer: Response): GateCapture | undefined {
  return input.request.method === 'GET' && answer.headers.get(GATE_CAPTURE_HEADER) === GATE_CAPTURE
    ? { kind: 'capture', route: gate.route }
    : undefined;
}

/**
 * Whether a shell can answer the request: a browser's navigation (`isNavigation`), a `GET` of a
 * document, as `gateRequest` reads one — what its gate is told takes a shell, and nothing else.
 */
function takesShell(request: Request): boolean {
  return (
    request.method === 'GET' &&
    request.headers.get(RSC_HEADER) !== '1' &&
    isNavigation(request.headers)
  );
}

/**
 * Whether a request is a browser's navigation, as it says of itself (`NAVIGATION_REQUEST_HEADERS`):
 * what the gate is told takes a shell (`GATE_ACCEPT_HEADER`). Any other request a gate lets
 * through — a crawler's, a prefetch made as a resource's, a client's that says nothing — is served
 * as the route serves it, and no shell need be made for it.
 */
function isNavigation(headers: Headers): boolean {
  return Object.entries(NAVIGATION_REQUEST_HEADERS).every(
    ([name, value]) => headers.get(name) === value,
  );
}

/**
 * When a gate was asked: as the host's clock read it (`started`), which what the edge observes of the
 * request is measured by, and as time passes (`since`, `performance.now()`), which the time a gate
 * is given is measured by — no clock set on or back meanwhile shortening or stretching it.
 */
interface Asked {
  readonly started: number;
  readonly since: number;
}

/**
 * A gate's shell, read whole from `body` — within `left` ms, and no larger than a shell may be
 * (`MAX_GATE_SHELL_BYTES`) — or the edge's answer where it is not: that the gate did not answer,
 * where its bytes do not all arrive; malformed, where they are more.
 */
async function shellBytes(
  gate: RouteGate,
  body: ReadableStream<Uint8Array> | null,
  left: number,
): Promise<Uint8Array | Response> {
  let read: BoundedBody;
  try {
    read = await readBoundedBody(body, {
      limit: MAX_GATE_SHELL_BYTES,
      stallMs: left,
      budgetMs: left,
    });
  } catch (error) {
    logWarn('a gate did not answer with its shell whole', {
      gate: gate.name,
      route: gate.route,
      detail: describe(error),
    });
    return serviceUnavailableResponse(GATE_UNAVAILABLE);
  }
  if (read.kind === 'over-limit') {
    releaseStream(read.body, 'gate');
    return unserved(gate, GATE_SHELL_MALFORMED, 'larger than a shell may be');
  }
  return read.bytes;
}

/**
 * The edge's answer in place of a gate's shell it does not serve: that the gate is unavailable,
 * under `reason`, before any byte — said where the edge's warnings go, with why.
 */
function unserved(gate: RouteGate, reason: string, detail: string): Response {
  logWarn('a gate answered with a shell the edge does not serve', {
    gate: gate.name,
    route: gate.route,
    detail,
  });
  return serviceUnavailableResponse(reason);
}

/**
 * The shell a gate answered with (`GATE_SHELL`), read whole — within what is left of the time a gate
 * is given (`GATE_TIMEOUT_MS`), as it passes (`Asked.since`), whatever the host's clock is set to
 * meanwhile, and no larger than a shell may be (`MAX_GATE_SHELL_BYTES`) — or the edge's answer
 * before any byte where it is not served: that the gate did not answer, where its bytes do not all
 * arrive; malformed, where they are no shell (`decodeGateShell`); unserved, where the request is one
 * no shell answers, or the shell's render answered other than 200.
 */
async function shellOf(
  input: GateInput,
  gate: RouteGate,
  answer: Response,
  { started, since }: Asked,
): Promise<GateShellDirective | Response> {
  const { request } = input;
  if (!takesShell(request)) {
    releaseStream(answer.body, 'gate');
    return unserved(gate, GATE_SHELL_UNSERVED, `a ${request.method} that is no navigation's`);
  }
  if (!isGateShellType(answer.headers.get('content-type'))) {
    releaseStream(answer.body, 'gate');
    return unserved(gate, GATE_SHELL_MALFORMED, 'an answer of another type');
  }
  // Its host's fetch undid a gzip or br of it, if any; no other coding is undone, but refused unread.
  if (!reachesUncoded(answer.headers)) {
    releaseStream(answer.body, 'gate');
    return unserved(gate, GATE_SHELL_MALFORMED, 'an answer in a coding no host undoes');
  }
  const elapsed = (): number => (input.now?.() ?? started) - started;
  const bytes = await shellBytes(gate, answer.body, GATE_TIMEOUT_MS - (performance.now() - since));
  if (bytes instanceof Response) {
    return bytes;
  }
  const decoded = decodeGateShell(bytes);
  if (decoded.kind === 'malformed') {
    return unserved(gate, GATE_SHELL_MALFORMED, decoded.reason);
  }
  const { shell } = decoded;
  if (shell.header.route !== gate.route) {
    return unserved(gate, GATE_SHELL_MALFORMED, `a shell of ${shell.header.route}`);
  }
  if (shell.header.status !== OK_STATUS) {
    return unserved(
      gate,
      GATE_SHELL_UNSERVED,
      `a render that answered ${String(shell.header.status)}`,
    );
  }
  return { kind: 'shell', gate: gate.name, shell, lookupMs: elapsed() };
}

/**
 * The visitor's answer from the gate of `gate`'s route — the gate's own, or the edge's that it is
 * unavailable — what the gate directs the edge to do in its place (`GateDirective`), or `undefined`
 * where the gate says only to go on.
 */
async function answeredAtGate(
  input: GateInput,
  gate: RouteGate,
  asked: Asked,
): Promise<Response | GateDirective | undefined> {
  const answer = await askGate(input, gate);
  if (answer === undefined) {
    return serviceUnavailableResponse(GATE_UNAVAILABLE);
  }
  if (answer.status === SWITCHING_PROTOCOLS || answer.webSocket !== null) {
    releaseAnswer(answer);
    return serviceUnavailableResponse(GATE_UNAVAILABLE);
  }
  const said = answer.headers.get(GATE_ANSWER_HEADER);
  if (said === GATE_PASS) {
    releaseStream(answer.body, 'gate');
    if (answer.headers.get(GATE_SCOPE_HEADER) === GATE_SCOPE_DOCUMENTS) {
      const key = documentGateOf(input, gate);
      if (key !== undefined) {
        input.documentGates?.memory.set(key, true);
      }
    }
    return captureOf(input, gate, answer);
  }
  return said === GATE_SHELL
    ? shellOf(input, gate, answer, asked)
    : gateAnswer(input, gate, answer);
}

async function throughGate(
  input: GateInput,
  gate: RouteGate,
  routed: (directive?: GateDirective) => Promise<Response>,
): Promise<Response> {
  const started = input.now?.() ?? 0;
  const answer = await answeredAtGate(input, gate, { since: performance.now(), started });
  if (answer === undefined || !(answer instanceof Response)) {
    // A directive is a pass the edge acts on: the handler downstream counts the request, as a pass's,
    // and what it answers this visitor is kept from shared caches as a pass's answer is.
    input.passed?.();
    return unshared(await routed(answer));
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

/** What the edge remembers `gate` under, where it remembers gates at all (`documentGates`). */
function documentGateOf(input: GateInput, gate: RouteGate): string | undefined {
  const remembered = input.documentGates;
  return remembered === undefined
    ? undefined
    : documentGateKey(remembered.manifestId, gate.name, gate.route);
}

/**
 * Whether `gate` is one that said it decides a request that takes a shell alone, and the request
 * is none the edge would serve one for — a `HEAD`, the router's payload, a prefetch, a crawler's
 * or a client's GET that says nothing of itself — nor one that says it is to be captured
 * (`GATE_CAPTURE_HEADER`), which only its gate lets through as one. It goes on unasked, as the
 * gate's pass would have it: routed as with no gate, and kept from shared caches as a pass's answer
 * is (`unshared`), without the round trip to the gate.
 */
function goesOnUnasked(input: GateInput, gate: RouteGate): boolean {
  const { request } = input;
  if (takesShell(request) || request.headers.get(GATE_CAPTURE_HEADER) === GATE_CAPTURE) {
    return false;
  }
  const key = documentGateOf(input, gate);
  return key !== undefined && input.documentGates?.memory.get(key) === true;
}

/**
 * The request routed as it would be with no gate (`routed`), where it is of no gated route, or
 * where its gate says to go on — told what the gate directs in its place, where it directs anything
 * (`GateDirective`); otherwise the gate's answer, or the edge's that the gate is unavailable
 * (above). Asked only of a `GET` or a `HEAD` of a deployment that declares a gate, and not of a
 * request a gate said it decides nothing of (`goesOnUnasked`).
 */
export function routeThroughGate(
  input: GateInput,
  routed: (directive?: GateDirective) => Promise<Response>,
): Promise<Response> {
  if (input.validated) {
    return routed();
  }
  const gate = gateOf(input);
  if (gate instanceof Response) {
    input.terminal?.(gate, undefined, 0, false);
    return Promise.resolve(gate);
  }
  if (gate === undefined) {
    return routed();
  }
  return goesOnUnasked(input, gate) ? goneOnUnasked(routed) : throughGate(input, gate, routed);
}

/** A request that goes on unasked (`goesOnUnasked`), routed as with no gate and kept from shared caches. */
async function goneOnUnasked(routed: () => Promise<Response>): Promise<Response> {
  return unshared(await routed());
}

/** What the handler downstream answers a request its gate passes, kept from shared caches. */
function unshared(response: Response): Response {
  const admitted = new Response(response.body, response);
  unsharedUnlessPublic(admitted.headers, false);
  return admitted;
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
