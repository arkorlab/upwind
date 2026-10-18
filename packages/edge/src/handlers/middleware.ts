import { isPagesDataRequestPath } from '@stayingupwind/core/bundle';
import {
  type ConfiguredHeaders,
  headerRulesFor,
  type MiddlewareMatcher,
  type ProjectManifest,
  type RequestHeaderRules,
  requestHeaderRulesFor,
} from '@stayingupwind/core/manifest';
import {
  MIDDLEWARE_ONLY_HEADER,
  MIDDLEWARE_SET_COOKIE_HEADER,
  middlewareApplies,
  type MiddlewareResult,
  PLATFORM_REQUEST_HEADERS,
  readMiddlewareResponse,
} from '@stayingupwind/core/paas';
import {
  dataRequestHeaders,
  EDGE_DEBUG_HEADER,
  HOP_BY_HOP_HEADERS,
  PASSTHROUGH_RESPONSE_HEADER_DENYLIST,
  PLATFORM_HEADER_PREFIX,
  sanitizePassthroughHeaders,
} from '@stayingupwind/core/request';
import { isDeadlineError, releaseStream, withDeadline } from '@stayingupwind/core/util';
import { type HostCredentials, withoutHostCredentials } from '@stayingupwind/host/credentials';

import type { DispatchApp } from '../edge-runtime.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { setConfigured, setConfiguredUnder } from './configured-headers.ts';
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

/**
 * Run a hosted application's middleware before a shell is served.
 *
 * The application has real code, and the edge cannot know what it does to a request until it has
 * run: a locale rewrite, a redirect to a login page, a cookie it sets on every first visit. So it
 * runs — in the small Worker holding only the middleware, so that the cold start is the
 * middleware's and not the whole application's — and the shell goes out afterwards with whatever
 * the middleware decided. That is the one thing on the first-byte path a hosted app adds.
 *
 * Fails closed. A middleware that throws, outruns its budget, or cannot be reached is answered by
 * proxying the request to the application's Worker, which runs the middleware itself as part of
 * serving the whole document. Slower, and exactly what the application would have done anyway.
 */
/**
 * Why a middleware did not answer, as few words as tell the difference.
 *
 * A closed set, because it travels: the passthrough that follows puts it in `x-arkor-edge` and in
 * the metric it hands its host (`EdgeObserver.metric`). A header value is not a place for an
 * error's own words — workerd refuses a control character in one, so a message with a newline would
 * raise on the serving path rather than say anything — and a blob of unbounded values is not a
 * dimension anyone can group by. `reason` keeps the words, for whoever reads the outcome in the
 * same isolate.
 */
export type MiddlewareFailure =
  /** It outran `policy.middleware.timeoutMs`, which a cold isolate of a new deployment can. */
  | 'timeout'
  /** The host has no way to reach it: this deployment cannot run one at all. */
  | 'unreachable'
  /** It answered by throwing, or the dispatch did. */
  | 'threw';

export type MiddlewareOutcome =
  | Exclude<MiddlewareResult, { readonly kind: 'continue' }>
  | MiddlewareContinued
  | MiddlewareSkipped
  | { readonly kind: 'failed'; readonly cause: MiddlewareFailure; readonly reason: string };

/** The request goes on as the middleware left it (`MiddlewareResult`). */
export interface MiddlewareContinued extends Extract<
  MiddlewareResult,
  { readonly kind: 'continue' }
> {
  /**
   * The status the middleware gave a rewrite on the request's own origin, where it gave one other
   * than 200: `NextResponse.rewrite(url, { status: 404 })`. Next.js's router puts the middleware's
   * status on the response before the route it rewrote to renders, and a route that sets none of
   * its own answers under it (`res.statusCode = middlewareRes.status`, in
   * `server/lib/router-utils/resolve-routes.ts`). A Function told the middleware ran is told this
   * beside it (`MIDDLEWARE_REWRITE_STATUS_HEADER`), and answers under it without running it again.
   */
  readonly rewriteStatus?: number | undefined;
  /**
   * The headers the rules of `next.config` set on the request as the client sent it, judged before
   * the middleware ran (`withJudgedRules`): what Next.js's router lays on whatever answers the
   * request. A Function the request is handed on to is told the edge holds them
   * (`HEADER_RULES_JUDGED_HEADER`), and leaves them for the edge to lay where it says it did
   * (`HEADER_RULES_LEFT_HEADER`): judged there, on the request as the middleware left it, the rules
   * of the path the client asked for were lost and those of the path it was rewritten to added.
   */
  readonly judgedRules?: ConfiguredHeaders | undefined;
}

/**
 * How long the middleware took, whatever it came to — `undefined` where it was not run at all.
 *
 * Recorded so that the middleware's budget (`policy.middleware.timeoutMs`) can be set against what
 * a middleware actually takes: a cold isolate of a large bundle can come close to it, and the only
 * way to tell a budget that is too small from a middleware that has genuinely hung is the
 * distribution of this. A `now()` either side of a subrequest that was going to be awaited anyway.
 */
export interface MiddlewareTiming {
  readonly middlewareMs: number | undefined;
}

/**
 * The middleware did not run: there is none, or none of its matchers match this request — or the
 * request is a deployment's validation of a route, which proves the shell and its continuation and
 * leaves what the middleware would decide (a redirect, a cookie) to real visitors.
 */
export interface MiddlewareSkipped {
  readonly kind: 'skipped';
  readonly reason: 'unmatched' | 'validated';
}

const SKIPPED: MiddlewareOutcome = { kind: 'skipped', reason: 'unmatched' };

/**
 * What the passthrough is told, and therefore what `x-arkor-edge` says and the metric the edge
 * hands its host carries (`EdgeObserver.metric`): `middleware-failed;cause=timeout`. The shape the
 * header already uses for the rest of what it says, and the cause is one of three words rather than
 * an error's own.
 */
export function middlewareFailedReason(cause: MiddlewareFailure): string {
  return `middleware-failed;cause=${cause}`;
}
const MAX_REASON_LENGTH = 200;
const REWRITE_HEADER = 'x-middleware-rewrite';
const SET_COOKIE_HEADER = 'set-cookie';
const CONTENT_TYPE_HEADER = 'content-type';
const FORWARDED_HOST_HEADER = 'x-forwarded-host';
const HTTP_OK = 200;
/**
 * What of the middleware protocol a middleware's own answer may still carry, which Next.js's router
 * reads off it and hands no client (`resolve-routes.js`): the copy of its cookies `NextResponse`
 * writes beside each it sets, for the render a `next()` would have led to; the request headers it
 * overrode; the markers of what it decided. Core's own list (`PROTOCOL_HEADERS`, which
 * `readMiddlewareResponse` takes off an answer that lets the request on), less the length, which
 * `forwardedResponse` judges by the method. Not every name under the prefix: Next.js hands a client
 * `x-middleware-cache`, which its own router reads.
 */
const MIDDLEWARE_PROTOCOL_HEADERS: ReadonlySet<string> = new Set([
  MIDDLEWARE_SET_COOKIE_HEADER,
  REWRITE_HEADER,
  'x-middleware-next',
  'x-middleware-override-headers',
  'x-middleware-redirect',
  'x-middleware-refresh',
]);
/** A request header the middleware overrode, one each (`x-middleware-request-<name>`). */
const MIDDLEWARE_REQUEST_HEADER_PREFIX = 'x-middleware-request-';

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_REASON_LENGTH);
}

/**
 * What the middleware decided, with the status it gave a rewrite where that is not 200
 * (`rewriteStatus`): any rewrite on the request's own origin, its path changed or not, as
 * `@next/routing` reads one.
 */
function decided(result: MiddlewareResult, response: Response): MiddlewareOutcome {
  return result.kind === 'continue' &&
    response.status !== HTTP_OK &&
    response.headers.has(REWRITE_HEADER)
    ? { ...result, rewriteStatus: response.status }
    : result;
}

/**
 * The middleware's answer, read against the client's own headers (`runMiddlewareIn`) — but a
 * rewrite to another origin, which nothing forwards again, against the headers the middleware was
 * handed (`middlewareRequest`). Next.js's proxy sends another origin the request its middleware was
 * handed, as the middleware left it (`proxyRequest`, in `server/lib/router-utils/proxy-request.ts`):
 * so the origin is sent the forwarding headers the middleware saw — the edge's own, never a client's
 * `x-forwarded-*` or `cf-*` — and no more of the client's request than the middleware was handed.
 */
function readAnswer(
  response: Response,
  url: URL,
  client: Headers,
  handed: Headers,
): MiddlewareResult {
  const result = readMiddlewareResponse(response, url, client);
  return result.kind === 'external-rewrite'
    ? readMiddlewareResponse(response, url, handed)
    : result;
}

/** A rule of the application's routing, as far as its conditions go. */
type Conditioned = Pick<MiddlewareMatcher, 'has' | 'missing'>;
type Condition = NonNullable<Conditioned['has']>[number];

/**
 * Whether a condition can read otherwise once `withoutHostCredentials` has run: it deletes the
 * host's headers, and where the host names cookies it writes the `cookie` header again. A cookie
 * condition reads that header, whichever cookie it names, so it can read otherwise wherever one on
 * the header whole can: where the host names cookies, or names the header itself. Every other
 * condition reads the same value either way.
 */
export function readsCredentials(condition: Condition, credentials: HostCredentials): boolean {
  if (condition.type !== 'cookie' && condition.type !== 'header') {
    return false;
  }
  const name = condition.type === 'cookie' ? 'cookie' : (condition.key ?? '').toLowerCase();
  return (
    (name === 'cookie' && credentials.cookies.length > 0) ||
    credentials.headers.some((header) => header.toLowerCase() === name)
  );
}

/** What `rulesReadCredentials` found for a set of rules, and for which credentials. */
const credentialReaders = new WeakMap<
  readonly Conditioned[],
  { readonly credentials: HostCredentials; readonly reads: boolean }
>();

/** Asked once for a set of rules, which a manifest holds for as long as it is held. */
function rulesReadCredentials(
  rules: readonly Conditioned[],
  credentials: HostCredentials,
): boolean {
  const known = credentialReaders.get(rules);
  if (known?.credentials === credentials) {
    return known.reads;
  }
  const reads = rules.some((rule) => {
    return [...(rule.has ?? []), ...(rule.missing ?? [])].some((condition) =>
      readsCredentials(condition, credentials),
    );
  });
  credentialReaders.set(rules, { credentials, reads });
  return reads;
}

/**
 * The headers the application's routing judges `rules` on: without the host's own credentials
 * (`withoutHostCredentials`), which never reach the application, so a `has` or `missing` that names
 * one holds or fails as it does where Next.js judges it. They are copied only for rules with a
 * condition that can tell the two apart (`readsCredentials`), not for any condition at all: Next.js
 * writes one on `rsc` into every build with a deployment id.
 */
export function routedHeaders(
  edge: Pick<EdgeContext, 'host'>,
  rules: readonly Conditioned[] | undefined,
  headers: Headers,
): Headers {
  const { credentials } = edge.host;
  return rules !== undefined && rulesReadCredentials(rules, credentials)
    ? withoutHostCredentials(new Headers(headers), credentials)
    : headers;
}

/**
 * The headers the middleware is handed (`middlewareRequest`), as the application's Worker is handed
 * any request: the client's, forwarded the way every upstream request forwards them — the edge's
 * own `x-forwarded-*` in place of a client's, without what no application is sent — and without
 * the host's credentials.
 */
function handedHeaders(edge: Pick<EdgeContext, 'host' | 'forwarding'>, headers: Headers): Headers {
  return withoutHostCredentials(
    sanitizePassthroughHeaders(headers, edge.forwarding),
    edge.host.credentials,
  );
}

/** What `rulesReadHeaders` found for a set of rules. */
const headerReaders = new WeakMap<readonly Conditioned[], boolean>();

/**
 * Whether a condition of `rules` reads the request's headers — a header's, or a cookie's, which
 * reads the `cookie` header — asked once for a set of rules, which a manifest holds for as long as
 * it is held.
 */
function rulesReadHeaders(rules: readonly Conditioned[]): boolean {
  let reads = headerReaders.get(rules);
  if (reads === undefined) {
    reads = rules.some((rule) => {
      return [...(rule.has ?? []), ...(rule.missing ?? [])].some(
        (condition) => condition.type === 'header' || condition.type === 'cookie',
      );
    });
    headerReaders.set(rules, reads);
  }
  return reads;
}

/**
 * Whether this request would run the application's middleware at all, judged on the headers the
 * application's Worker judges its matchers on: those it is handed (`handedHeaders`) — Next.js tests
 * a matcher on the request the proxy in front of it forwarded, less its own internal headers
 * (`filterInternalHeaders`, in `router-server.js`) — and `x-nextjs-data` set on a data request, as
 * its router sets it before the matcher is tested (`resolve-routes.js`). Built only for matchers
 * that read a header: on the others, the headers say nothing.
 */
export function middlewareMatches(
  edge: Pick<EdgeContext, 'host' | 'app' | 'forwarding'>,
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): boolean {
  if (edge.app?.middlewareScriptName === undefined) {
    return false;
  }
  if (manifest.middleware === undefined) {
    return false;
  }
  const { matchers } = manifest.middleware;
  if (!rulesReadHeaders(matchers)) {
    return middlewareApplies(matchers, url, headers);
  }
  const handed = handedHeaders(edge, headers);
  return middlewareApplies(
    matchers,
    url,
    isPagesDataRequestPath(manifest.pagesDataBasePath ?? '', url.pathname)
      ? dataRequestHeaders(handed)
      : handed,
  );
}

/**
 * The rules of `next.config` that set a response's headers, judged as the application's router
 * judges them: on the request as it came, without the host's credentials (`routedHeaders`).
 */
export function headerRulesAsRouted(
  edge: Pick<EdgeContext, 'host'>,
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): ConfiguredHeaders {
  return headerRulesFor(manifest, url, routedHeaders(edge, manifest.headerRules, headers));
}

/**
 * Judge the rules of `next.config` that set a response's headers before the middleware runs.
 *
 * They are judged on the request as it came (`headerRulesAsRouted`), and a request the edge hands
 * on after the middleware has run goes as the middleware left it: the Worker, told the middleware
 * ran, would judge them on headers it may have changed. So one whose pattern costs more against
 * this request than the edge runs (`budgetPatterns`) throws here instead, while the request can
 * still go to the Worker whole, middleware and all. Keep the result for delivery: testing again
 * after the middleware would spend the request's routing allowance twice, and could fail then.
 */
export function judgeHeaderRulesAhead(
  edge: Pick<EdgeContext, 'host'>,
  manifest: ProjectManifest,
  url: URL,
  headers: Headers,
): RequestHeaderRules {
  return requestHeaderRulesFor(manifest, url, routedHeaders(edge, manifest.headerRules, headers));
}

/**
 * Whether the rules a manifest carries are every rule of `next.config` that sets a header: a build
 * whose routing the edge reproduces publishes them all, and its dynamic routes, an empty list
 * included. One it does not — with `i18n` — publishes only the rules `next build` writes itself, and
 * folds its others into its routes' headers (`foldedHeaderRules`), which no request is judged by.
 */
function judgesEveryHeaderRule(manifest: ProjectManifest): boolean {
  return manifest.dynamicRoutes !== undefined && manifest.foldedHeaderRules === undefined;
}

/**
 * What the middleware decided, with the headers the rules of `next.config` set on the request as
 * the client sent it (`configured`, judged before the middleware ran) beside a decision to let the
 * request on (`MiddlewareContinued.judgedRules`), for the Function it may be handed to. Not where the
 * manifest holds only some of the rules (`judgesEveryHeaderRule`): the Function judges them all, as
 * it did, and the edge lays none.
 */
export function withJudgedRules<Outcome extends MiddlewareOutcome>(
  outcome: Outcome,
  configured: ConfiguredHeaders,
  manifest: ProjectManifest,
): Outcome {
  return outcome.kind === 'continue' && judgesEveryHeaderRule(manifest)
    ? { ...outcome, judgedRules: configured }
    : outcome;
}

/**
 * The request as the middleware sees it: the client's own headers, forwarded the way every other
 * upstream request forwards them, and the marker that asks for the middleware alone.
 */
function middlewareRequest(edge: EdgeContext, request: Request, signal: AbortSignal): Request {
  const headers = handedHeaders(edge, request.headers);
  headers.set(MIDDLEWARE_ONLY_HEADER, '1');
  // The method as the client sent it: a middleware may decide differently for `HEAD`. Neither
  // method the edge runs it for carries a body.
  return new Request(request.url, { method: request.method, headers, redirect: 'manual', signal });
}

/** Which Worker runs the middleware, and what it may spend doing so. */
interface MiddlewareTarget {
  readonly scriptName: string;
  /**
   * What the dispatch may spend and how long it is waited for; absent, the Function's own limits
   * and no deadline, which is what a request the edge proxies to the application gets.
   */
  readonly budget?:
    | { readonly limits: Parameters<DispatchApp>[2]; readonly timeoutMs: number }
    | undefined;
}

/**
 * Run the middleware for a request its matchers cover; the caller checks that first, so a request
 * the middleware would not see costs nothing here. A caller with a deadline of its own — an image's
 * source — has the run cut short at `by` (`runtime.now()`), where that comes before the policy's
 * timeout: the policy may give a middleware longer than the caller has.
 */
export async function runMiddleware(
  edge: EdgeContext,
  request: Request,
  by?: number,
): Promise<MiddlewareOutcome & MiddlewareTiming> {
  const scriptName = edge.app?.middlewareScriptName;
  if (scriptName === undefined) {
    return { ...SKIPPED, middlewareMs: undefined };
  }
  const { cpuMs, subRequests, timeoutMs } = edge.policy.middleware;
  const waitMs = by === undefined ? timeoutMs : Math.min(timeoutMs, by - edge.runtime.now());
  return runMiddlewareIn(edge, request, {
    scriptName,
    budget: { limits: { cpuMs, subRequests }, timeoutMs: waitMs },
  });
}

/** The middleware's answer, and the dispatches it took to get: none, one, or two after a retry. */
export interface MiddlewareDecision {
  /** How long it took travels with it: the passthrough's metric reads it (`passthroughFor`). */
  readonly outcome: MiddlewareOutcome & MiddlewareTiming;
  readonly dispatches: number;
}

/** Whether a run of the middleware reached a Worker at all. */
export function dispatchedFor(outcome: MiddlewareOutcome): number {
  const unreached =
    outcome.kind === 'skipped' || (outcome.kind === 'failed' && outcome.cause === 'unreachable');
  return unreached ? 0 : 1;
}

/**
 * The middleware's answer for something the edge serves from storage — a shipped file, an
 * optimized image, an image's source — which the application's Worker cannot serve in its place:
 * it carries none of a build's `_next/static` files, nor a `public/` file past the size it keeps.
 * Handed such a request because the middleware's own Worker failed, it would run the middleware
 * and then answer 404 where the middleware let the request through.
 *
 * So when the middleware's Worker fails, the application's Worker is asked to run the middleware
 * alone — every Worker of a deployment answers `x-arkor-middleware: 1` so — and its answer is acted
 * on here as the first would have been: the file is served when the middleware lets it through,
 * and whatever it answered instead goes to the client. The middleware decides either way; nothing
 * is served that it was not asked about. Unbounded, as the proxied request it stands in for was —
 * unless the caller's own fetch was bounded, as an image's source is: then both runs have until
 * `by` (`runtime.now()`), the first cut short there whatever the policy's timeout, and the second
 * not sent once it has passed.
 * Only a Worker that cannot be reached at all is not asked, since the second would not be either,
 * nor one for a client that left: the first run went with it, and nobody waits for a second.
 */
export async function decideMiddleware(
  edge: EdgeContext,
  request: Request,
  by?: number,
): Promise<MiddlewareDecision> {
  const first = await runMiddleware(edge, request, by);
  const dispatches = dispatchedFor(first);
  const scriptName = edge.app?.scriptName;
  const left = by === undefined ? undefined : by - edge.runtime.now();
  if (
    scriptName === undefined ||
    first.kind !== 'failed' ||
    first.cause === 'unreachable' ||
    request.signal.aborted ||
    (left !== undefined && left <= 0)
  ) {
    return { outcome: first, dispatches };
  }
  logWarn('middleware failed; asking the application Worker', { cause: first.cause });
  const budget = left === undefined ? undefined : { limits: undefined, timeoutMs: left };
  const outcome = await runMiddlewareIn(edge, request, { scriptName, budget });
  // The whole wait is the middleware's: the run that failed, then the one that decided.
  const middlewareMs =
    first.middlewareMs === undefined && outcome.middlewareMs === undefined
      ? undefined
      : (first.middlewareMs ?? 0) + (outcome.middlewareMs ?? 0);
  return { outcome: { ...outcome, middlewareMs }, dispatches: dispatches + dispatchedFor(outcome) };
}

async function runMiddlewareIn(
  edge: EdgeContext,
  request: Request,
  target: MiddlewareTarget,
): Promise<MiddlewareOutcome & MiddlewareTiming> {
  const dispatch = edge.runtime.dispatchApp;
  if (dispatch === undefined) {
    return {
      kind: 'failed',
      cause: 'unreachable',
      reason: 'no-dispatch',
      middlewareMs: undefined,
    };
  }
  // A middleware past its budget is cancelled, not left running: the request goes on to the
  // application's Worker, which runs the middleware itself, and two of them at once would do
  // twice whatever the first was in the middle of. So is one whose client left, as the requests
  // that follow it are (`requestInit`, in `passthrough.ts`): nobody waits for what it decides.
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, request.signal]);
  const forwarded = middlewareRequest(edge, request, signal);
  const { budget } = target;
  let response: Response;
  const startedAt = edge.runtime.now();
  try {
    const dispatched = dispatch(target.scriptName, forwarded, budget?.limits);
    response = await (budget === undefined
      ? dispatched
      : withDeadline(dispatched, budget.timeoutMs, 'middleware'));
  } catch (error) {
    controller.abort(error);
    return {
      kind: 'failed',
      cause: isDeadlineError(error) ? 'timeout' : 'threw',
      reason: describe(error),
      // A timeout's own duration is the budget, near enough; what it is here for is the successful
      // ones, which say how close to the budget a cold isolate actually comes.
      middlewareMs: edge.runtime.now() - startedAt,
    };
  }
  const middlewareMs = edge.runtime.now() - startedAt;
  // Read against the client's own headers, not the forwarded ones: what comes out is a client
  // request as the middleware left it, and whatever forwards it next builds its own headers — all
  // but a rewrite to another origin, which goes out as it is read (`readAnswer`).
  //
  // Without the host's own cookies, and here rather than in each of the places that forward what
  // comes out. `requestHeaders` is rebuilt from what is passed in, and half a dozen callers hand it
  // on — to the application's Worker, to an image source; the headers an origin the application's
  // own rewrite named is sent never had them (`middlewareRequest`). Stripping it once at the source
  // is the only way every one of them is covered, including the next one somebody adds. A copy,
  // because a `Request`'s own headers are immutable.
  const client = withoutHostCredentials(new Headers(request.headers), edge.host.credentials);
  let result: MiddlewareResult;
  try {
    result = readAnswer(response, new URL(request.url), client, forwarded.headers);
  } catch (error) {
    // An answer that says in the middleware's own headers what no request can be — a rewrite to no
    // URL at all, an override naming no header — is the middleware failing as surely as a throw:
    // answered as one, the application's Worker asked next, rather than ending the request.
    releaseStream(response.body, 'middleware');
    return { kind: 'failed', cause: 'threw', reason: describe(error), middlewareMs };
  }
  if (result.kind !== 'responded') {
    releaseStream(response.body, 'middleware');
  }
  return { ...decided(result, response), middlewareMs };
}

type ExternalRewrite = Extract<MiddlewareResult, { kind: 'external-rewrite' }>;

/**
 * What it took the middleware to give an answer of its own — its run, and the dispatches it made —
 * and what that answer carries besides the middleware's own headers.
 */
export interface MiddlewareAnswered {
  /** What the request named, which the answer is counted under. */
  readonly pathname: string;
  readonly middlewareMs: number | undefined;
  readonly dispatches: number;
  /**
   * The headers the rules of `next.config` set on the request, chosen on it as it came, before the
   * middleware ran (`judgeHeaderRulesAhead`, `headerRulesAsRouted`): Next.js's router collects them
   * ahead of the middleware, and lays them on whatever answers the request instead — a redirect, a
   * whole response, another origin's answer to a rewrite.
   */
  readonly configured: ConfiguredHeaders;
}

/**
 * The point of an answer the middleware gave itself — a redirect, a whole response, an origin it
 * rewrote to — counted as a passthrough is, under the reason `x-arkor-edge` gives it: the request
 * and what it spent go to the host whoever answered it.
 */
function recordMiddlewareAnswer(
  edge: EdgeContext,
  reason: string,
  answered: MiddlewareAnswered & { readonly fetched?: { readonly ms: number } | undefined },
): void {
  observeMetric(edge.host, {
    projectId: edge.projectId,
    kind: 'passthrough',
    pathname: answered.pathname,
    shellStrategy: '',
    shellSource: '',
    outcomeKind: reason,
    colo: edge.colo ?? '',
    originCacheHeader: '',
    manifestId: edge.manifestId,
    policyId: edge.policy.id,
    encoding: '',
    middlewareMs: answered.middlewareMs,
    ttfbInternalMs: 0,
    shellLookupMs: 0,
    originFirstByteMs: answered.fetched?.ms ?? 0,
    originTotalMs: 0,
    shellBytes: 0,
    suffixBytes: 0,
    recovery: 0,
    retry: 0,
    assetHit: 0,
    // The middleware's dispatches, and the fetch of the origin it rewrote to where it named one.
    subrequests: answered.dispatches + (answered.fetched === undefined ? 0 : 1),
  });
}

/**
 * What routing lays on its answer to a rewrite it proxies: the headers the rules of `next.config`
 * set, then the middleware's over them — both collected before the proxy (`resolve-routes.ts`) —
 * under the answer's own, as Next.js answers: its router puts what it collected on the response
 * before it proxies (`router-server.js`), and the proxy writes each of the target's own headers over
 * it (`res.setHeader`, in httpxy). So a name the answer carries is the answer's, and routing's
 * stands only where the answer names none. Routing's are merged as the middleware's are on any
 * answer the edge hands on (`mergeScopedMiddlewareHeaders`): not the body's type, encoding, framing
 * or caching. A cookie is its own: routing's go out beside the answer's, scoped to the host, as on
 * every answer the edge hands on. A rule's name that no header can have is left off.
 *
 * The body's type is the answer's where it names one; where the answer names none, routing's
 * stands — the middleware's, else a rule's.
 */
function layRouted(
  edge: EdgeContext,
  headers: Headers,
  rewrite: ExternalRewrite,
  configured: ConfiguredHeaders,
): void {
  const rules = new Headers();
  for (const [name, value] of Object.entries(configured.headers)) {
    try {
      rules.append(name, value);
    } catch {
      // Not a header, on this request: left off.
    }
  }
  // What routing collected before the proxy: the rules', and the middleware's over them.
  const routed = new Headers();
  mergeScopedMiddlewareHeaders(routed, rules, edge.forwarding);
  mergeScopedMiddlewareHeaders(routed, rewrite.responseHeaders, edge.forwarding);
  for (const cookie of routed.getSetCookie()) {
    headers.append(SET_COOKIE_HEADER, cookie);
  }
  // Each name once: a name `routed` repeats (none but `set-cookie` can) is taken once.
  const names = new Set(routed.keys());
  for (const name of names) {
    if (name !== SET_COOKIE_HEADER && !headers.has(name)) {
      headers.set(name, routed.get(name) ?? '');
    }
  }
  const routedType =
    rewrite.responseHeaders.get(CONTENT_TYPE_HEADER) ?? rules.get(CONTENT_TYPE_HEADER);
  if (routedType !== null && !headers.has(CONTENT_TYPE_HEADER)) {
    headers.set(CONTENT_TYPE_HEADER, routedType);
  }
}

/**
 * What a rewrite to an origin that could not be reached is answered with: a 502 under the headers
 * the rules and the middleware set, their cookies scoped as on any answer to the rewrite, as
 * Next.js's router keeps them on its answer whatever became of the request it proxied. Kept by
 * nobody.
 */
function unreachableRewrite(
  edge: EdgeContext,
  rewrite: ExternalRewrite,
  configured: ConfiguredHeaders,
): Response {
  const own = badGatewayResponse('external-rewrite-unavailable');
  const headers = new Headers();
  layRouted(edge, headers, rewrite, configured);
  for (const [name, value] of own.headers) {
    headers.set(name, value);
  }
  keptByNobody(headers);
  applyCspReporting(headers, edge.cspReportingPath);
  return new Response(own.body, { status: own.status, headers });
}

/**
 * What of a request is never another origin's: the edge's own headers (`PLATFORM_HEADER_PREFIX`, the
 * runtime's `PLATFORM_REQUEST_HEADERS` among them), what belongs to one connection alone
 * (`HOP_BY_HOP_HEADERS`, and whatever the request's `Connection` names, `nominatedBy`), and the
 * site's hostname, which the target's URL replaces.
 */
function notForAnotherOrigin(name: string): boolean {
  return (
    name === 'host' ||
    HOP_BY_HOP_HEADERS.includes(name) ||
    PLATFORM_REQUEST_HEADERS.includes(name) ||
    name.startsWith(PLATFORM_HEADER_PREFIX)
  );
}

/**
 * A rewrite to another origin, followed from here: the middleware has run once, and running it
 * again in the application's Worker would repeat whatever it did on the way. The request goes out
 * as Next.js's proxy sends one: the request the middleware was handed, as the middleware left it
 * (`readAnswer`) — so without the host's credentials (`EdgeHost.credentials`, its cookies and
 * headers), which never reached the middleware, and with the edge's forwarding headers rather than
 * a client's — under `x-forwarded-host` naming the host the client asked on, whatever the middleware
 * made of it, and without what is never another origin's (`notForAnotherOrigin`). What comes back
 * carries the headers the rules of `next.config` and the middleware set (`layRouted`) — as the
 * runtime answers the same rewrite.
 */
export async function followExternalRewrite(
  edge: EdgeContext,
  request: Request,
  rewrite: ExternalRewrite,
  answered: MiddlewareAnswered,
): Promise<Response> {
  // What the middleware was handed, which matters most here: this request goes to an origin the
  // *application* named, further from us than its own Worker rather than nearer.
  const headers = new Headers();
  const nominated = nominatedBy(rewrite.requestHeaders);
  for (const [name, value] of rewrite.requestHeaders) {
    if (!notForAnotherOrigin(name) && nominated?.has(name) !== true) {
      headers.append(name, value);
    }
  }
  // As Next.js's proxy names it, over whatever the request carried (`proxyRequest`).
  headers.set(FORWARDED_HOST_HEADER, edge.forwarding.previewHost);
  let upstream: Response;
  const startedAt = edge.runtime.now();
  try {
    // No deadline of the edge's own. Next.js gives a rewrite it proxies the application's
    // `experimental.proxyTimeout`, thirty seconds unless the application raised it, and the bundle
    // does not carry that setting: a fixed one here would cut short an application that had.
    upstream = await edge.runtime.fetchImpl(
      new Request(rewrite.url.href, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        // With no deadline of its own, the client leaving is what lets it go.
        signal: request.signal,
      }),
    );
  } catch {
    // A name that does not resolve, a refused connection, a handshake that failed: the target of
    // the application's rewrite is unreachable, which is not this Worker failing. Left to
    // propagate it would end the request as an uncaught exception.
    const fetched = { ms: edge.runtime.now() - startedAt };
    recordMiddlewareAnswer(edge, 'external-rewrite-unavailable', { ...answered, fetched });
    return unreachableRewrite(edge, rewrite, answered.configured);
  }
  const fetched = { ms: edge.runtime.now() - startedAt };
  // As a Worker's answer is taken (`handlePassthrough`): cookies scoped to the host the client
  // used, and nothing of the edge's protocol, nor what a proxy may not replay, carried over.
  const answer = forwardedResponse(upstream, edge.forwarding, request.method);
  const responseHeaders = answer.headers;
  layRouted(edge, responseHeaders, rewrite, answered.configured);
  privateCacheControl(responseHeaders);
  if (edge.privateDelivery) {
    keptByNobody(responseHeaders);
  }
  responseHeaders.set(EDGE_DEBUG_HEADER, 'passthrough;reason=external-rewrite');
  applyCspReporting(responseHeaders, edge.cspReportingPath);
  recordMiddlewareAnswer(edge, 'external-rewrite', { ...answered, fetched });
  return answer;
}

/**
 * The headers the rules of `next.config` set, laid under a redirect or a whole response the
 * middleware answered with, as Next.js's router lays them: collected ahead of the middleware, each
 * replaced by one of the middleware's own of the same name (`resolve-routes.js`), and all put on the
 * response before it redirects or sends the middleware's body (`router-server.js`). A rule's cookie
 * goes out ahead of the middleware's, as `@next/routing` collects the two for the application's
 * Worker and as every other answer here carries them — Next.js's own server keeps the middleware's
 * alone — so of a cookie both set the middleware's is the one that stands; each is scoped as any
 * is. What the edge takes off every answer it hands on (`forwardedResponse`) is not a rule's to put
 * back.
 */
function layConfiguredUnder(
  edge: EdgeContext,
  headers: Headers,
  configured: ConfiguredHeaders,
): void {
  for (const [name, value] of Object.entries(configured.headers)) {
    if (name === SET_COOKIE_HEADER) {
      const own = headers.getSetCookie();
      headers.delete(SET_COOKIE_HEADER);
      setConfigured(headers, name, value, edge.forwarding);
      for (const cookie of own) {
        headers.append(SET_COOKIE_HEADER, cookie);
      }
    } else if (
      !PASSTHROUGH_RESPONSE_HEADER_DENYLIST.includes(name) &&
      !name.startsWith(PLATFORM_HEADER_PREFIX)
    ) {
      setConfiguredUnder(headers, name, value, edge.forwarding);
    }
  }
}

/** Take what is the middleware protocol's off its own answer (`MIDDLEWARE_PROTOCOL_HEADERS`). */
function withoutMiddlewareProtocol(headers: Headers): void {
  // The names chosen first: deleting from the iterator's own Headers would skip entries.
  const protocol = [...headers.keys()].filter(
    (name) =>
      MIDDLEWARE_PROTOCOL_HEADERS.has(name) || name.startsWith(MIDDLEWARE_REQUEST_HEADER_PREFIX),
  );
  for (const name of protocol) {
    headers.delete(name);
  }
}

/**
 * A redirect or a whole response the middleware produced for `request`, handed to the client as
 * such: without what of it is the middleware protocol's, under the headers the rules of
 * `next.config` set (`layConfiguredUnder`).
 */
export function middlewareResponse(
  edge: EdgeContext,
  request: Request,
  response: Response,
  answered: MiddlewareAnswered,
): Response {
  const answer = forwardedResponse(response, edge.forwarding, request.method);
  const headers = answer.headers;
  withoutMiddlewareProtocol(headers);
  layConfiguredUnder(edge, headers, answered.configured);
  privateCacheControl(headers);
  if (edge.privateDelivery) {
    keptByNobody(headers);
  }
  headers.set(EDGE_DEBUG_HEADER, 'passthrough;reason=middleware');
  applyCspReporting(headers, edge.cspReportingPath);
  recordMiddlewareAnswer(edge, 'middleware', answered);
  return answer;
}
