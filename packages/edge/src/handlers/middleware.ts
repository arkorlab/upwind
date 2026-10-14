import { headerRulesFor, type ProjectManifest } from '@stayingupwind/core/manifest';
import {
  MIDDLEWARE_ONLY_HEADER,
  middlewareApplies,
  type MiddlewareResult,
  PLATFORM_REQUEST_HEADERS,
  readMiddlewareResponse,
} from '@stayingupwind/core/paas';
import {
  EDGE_DEBUG_HEADER,
  rewritePassthroughResponseHeaders,
  sanitizePassthroughHeaders,
} from '@stayingupwind/core/request';
import { isDeadlineError, releaseStream, withDeadline } from '@stayingupwind/core/util';
import { withoutHostCredentials } from '@stayingupwind/host/credentials';

import type { DispatchApp } from '../edge-runtime.ts';
import { logWarn } from '../observability/logger.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { applyCspReporting } from './csp-reporting-headers.ts';
import {
  badGatewayResponse,
  keptByNobody,
  mergeScopedMiddlewareHeaders,
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
  | MiddlewareResult
  | MiddlewareSkipped
  | { readonly kind: 'failed'; readonly cause: MiddlewareFailure; readonly reason: string };

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

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, MAX_REASON_LENGTH);
}

/**
 * Whether this request would run the application's middleware at all.
 *
 * Judged on the headers the middleware is handed (`runMiddleware`), without the host's own
 * credentials (`withoutHostCredentials`): a `has` or `missing` that names one of them holds or
 * fails as it does where Next.js judges it, on a request that never carries them. Only a matcher
 * with conditions reads the headers, and most have none, so only then are they copied.
 */
export function middlewareMatches(
  edge: EdgeContext,
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
  const conditioned = matchers.some(
    (matcher) => matcher.has !== undefined || matcher.missing !== undefined,
  );
  const handed = conditioned
    ? withoutHostCredentials(new Headers(headers), edge.host.credentials)
    : headers;
  return middlewareApplies(matchers, url, handed);
}

/**
 * Judge the rules of `next.config` that set a response's headers before the middleware runs.
 *
 * They are judged on the request as it came (`headerRulesFor`), and a request the edge hands on
 * after the middleware has run goes as the middleware left it: the Worker, told the middleware ran,
 * would judge them on headers it may have changed. So one whose pattern costs more against this
 * request than the edge runs (`budgetPatterns`) throws here instead, while the request can still go
 * to the Worker whole, middleware and all. What the rules come to is worked out again where it is
 * used; this asks only that it can be.
 */
export function judgeHeaderRulesAhead(manifest: ProjectManifest, url: URL, headers: Headers): void {
  headerRulesFor(manifest, url, headers);
}

/**
 * The request as the middleware sees it: the client's own headers, forwarded the way every other
 * upstream request forwards them, and the marker that asks for the middleware alone.
 */
function middlewareRequest(edge: EdgeContext, request: Request, signal: AbortSignal): Request {
  const headers = withoutHostCredentials(
    sanitizePassthroughHeaders(request.headers, edge.forwarding),
    edge.host.credentials,
  );
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
 * Only a Worker that cannot be reached at all is not asked, since the second would not be either.
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
  // twice whatever the first was in the middle of.
  const controller = new AbortController();
  const forwarded = middlewareRequest(edge, request, controller.signal);
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
  // request as the middleware left it, and whatever forwards it next builds its own headers.
  //
  // Without the host's own cookies, and here rather than in each of the places that forward what
  // comes out. `requestHeaders` is rebuilt from what is passed in, and half a dozen callers hand it
  // on — to the application's Worker, to an image source, to an origin the application's own
  // rewrite named. Stripping it once at the source is the only way every one of them is covered,
  // including the next one somebody adds. A copy, because a `Request`'s own headers are immutable.
  const client = withoutHostCredentials(new Headers(request.headers), edge.host.credentials);
  let result: MiddlewareResult;
  try {
    result = readMiddlewareResponse(response, new URL(request.url), client);
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
  return { ...result, middlewareMs };
}

type ExternalRewrite = Extract<MiddlewareResult, { kind: 'external-rewrite' }>;

/**
 * A rewrite to another origin, followed from here: the middleware has run once, and running it
 * again in the application's Worker would repeat whatever it did on the way. The request goes out
 * as the middleware left it, without three things: the host's credentials (`EdgeHost.credentials`,
 * its cookies and headers), which `runMiddleware` took off before the middleware's answer rebuilt
 * the request; the edge's own request headers (`PLATFORM_REQUEST_HEADERS`), taken off here; and the
 * site's hostname. What comes back carries the headers the middleware set — as the runtime answers
 * the same rewrite.
 */
export async function followExternalRewrite(
  edge: EdgeContext,
  request: Request,
  rewrite: ExternalRewrite,
): Promise<Response> {
  // Already without the host's own cookies: `runMiddleware` strips them from what
  // `readMiddlewareResponse` rebuilds `requestHeaders` out of, which matters most here — this
  // request goes to an origin the *application* named, further from us than its own Worker rather
  // than nearer.
  const headers = new Headers(rewrite.requestHeaders);
  headers.delete('host');
  for (const name of PLATFORM_REQUEST_HEADERS) {
    headers.delete(name);
  }
  let upstream: Response;
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
      }),
    );
  } catch {
    // A name that does not resolve, a refused connection, a handshake that failed: the target of
    // the application's rewrite is unreachable, which is not this Worker failing. Left to
    // propagate it would end the request as an uncaught exception.
    return badGatewayResponse('external-rewrite-unavailable');
  }
  // As a Worker's answer is taken (`handlePassthrough`): cookies scoped to the host the client
  // used, and nothing of the edge's protocol, nor what a proxy may not replay, carried over.
  const responseHeaders = rewritePassthroughResponseHeaders(upstream.headers, edge.forwarding);
  mergeScopedMiddlewareHeaders(responseHeaders, rewrite.responseHeaders, edge.forwarding);
  privateCacheControl(responseHeaders);
  if (edge.privateDelivery) {
    keptByNobody(responseHeaders);
  }
  responseHeaders.set(EDGE_DEBUG_HEADER, 'passthrough;reason=external-rewrite');
  applyCspReporting(responseHeaders, edge.cspReportingPath);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

/** A redirect or a whole response the middleware produced, handed to the client as such. */
export function middlewareResponse(edge: EdgeContext, response: Response): Response {
  const headers = rewritePassthroughResponseHeaders(response.headers, edge.forwarding);
  privateCacheControl(headers);
  if (edge.privateDelivery) {
    keptByNobody(headers);
  }
  headers.set(EDGE_DEBUG_HEADER, 'passthrough;reason=middleware');
  applyCspReporting(headers, edge.cspReportingPath);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
