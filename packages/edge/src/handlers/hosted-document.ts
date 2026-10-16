import {
  findRouteEntry,
  isExactPathname,
  isReserved,
  matchDynamicRoute,
  type ProjectManifest,
  type RequestHeaderRules,
  type RouteEntry,
} from '@stayingupwind/core/manifest';
import { PatternBudgetExceededError, type RequestClass } from '@stayingupwind/core/request';
import type { HostCredentials } from '@stayingupwind/host/credentials';
import { type ResolvedPolicy, runtimeCacheOf } from '@stayingupwind/host/delivery';

import { type RecordRead, serveCachedDocument, startRecordRead } from '../cache/document.ts';
import type { GenerationKey } from '../cache/generation-loader.ts';
import { type MemberRead, startMemberRead, upgradesMember } from '../cache/member.ts';
import { type RewriteSeen, rewriteSeenKey } from '../memory/caches.ts';
import type { EdgeContext } from '../strategies/context.ts';
import { loadShell, type ShellLoadResult } from '../strategies/shell-loader.ts';
import { handleDocument } from './document.ts';
import { serveMemberWithoutShell, type Unserved } from './hosted-member.ts';
import { composePagesData, composePayload, composeSegment } from './hosted-parts.ts';
import {
  bypassed,
  generationKeyOf,
  headersLeftAlone,
  offTheEdge,
  requestAsLeft,
} from './hosted-route.ts';
import { serveHostedFile } from './hosted-static-file.ts';
import {
  dispatchedFor,
  followExternalRewrite,
  judgeHeaderRulesAhead,
  middlewareFailedReason,
  middlewareMatches,
  type MiddlewareOutcome,
  middlewareResponse,
  runMiddleware,
} from './middleware.ts';
import { PATTERN_BUDGET, type PassthroughWait, passthroughReason } from './passthrough.ts';

export interface HostedDocumentInput {
  /** Header rules already selected on the original request, before middleware could change it. */
  readonly headerRules?: RequestHeaderRules | undefined;
  readonly request: Request<unknown, IncomingRequestCfProperties>;
  readonly url: URL;
  readonly edge: EdgeContext;
  readonly manifest: ProjectManifest;
  readonly resolved: ResolvedPolicy<EdgeContext>;
  readonly classification: RequestClass;
  /**
   * The headers the request was classified on, which a route's conditions are judged on where no
   * middleware ran (`requestAsLeft`): the request's own, the host's credentials taken off where a
   * rule of the application's would read one.
   */
  readonly classifiedHeaders: Headers;
  /**
   * Proxy the request to the application's Worker, with what the middleware decided if it ran, and
   * counted under the route it was classified as where there is one (`route`).
   */
  readonly passthrough: (
    reason: string,
    middleware?: MiddlewareOutcome,
    route?: string,
    waited?: PassthroughWait,
  ) => Promise<Response>;
}

/** The class of a router prefetch of part of a page, and the reason one that stays is given. */
const SEGMENT_PREFETCH = 'segment-prefetch';
/** The class of a router's request for a page's whole payload. */
const RSC_PAYLOAD = 'rsc-payload';
/** The class of a Pages Router client's request for a page's props, and the reason one stays. */
const PAGES_DATA = 'pages-data';
const ROUTER_CLASSES: ReadonlySet<string> = new Set([PAGES_DATA, RSC_PAYLOAD, SEGMENT_PREFETCH]);

/** A request of the client's router for what the build wrote beside a page, rather than a document. */
function forRouter(
  classification: RequestClass,
): classification is Extract<
  RequestClass,
  { kind: 'segment-prefetch' | 'rsc-payload' | 'pages-data' }
> {
  return ROUTER_CLASSES.has(classification.kind);
}

/** What a document's read ahead of the middleware is: the build's shell, or the entry's record. */
type Preload =
  | { readonly kind: 'shell'; readonly entry: RouteEntry; readonly read: Promise<ShellLoadResult> }
  | {
      readonly kind: 'generation';
      readonly entry: RouteEntry;
      readonly key: GenerationKey;
      /** The record's read, and the build's shell beside a record this isolate holds nothing of. */
      readonly read: RecordRead;
      /** The member's own record beside the class shell's, when the policy upgrades members. */
      readonly member: MemberRead | undefined;
    };

/**
 * The member's own record, when the policy upgrades members: the route is a class (its pathname
 * the template of a dynamic route), the entry an App Router page's, and the request is for a
 * member of the class. Its read starts at once, beside the class shell's.
 */
function memberReadFor(
  input: HostedDocumentInput,
  entry: RouteEntry,
  scopeId: string,
  pathname: string,
): MemberRead | undefined {
  const settings = runtimeCacheOf(input.edge.policy);
  if (!upgradesMember(settings, entry, pathname)) {
    return undefined;
  }
  // Keyed, as the runtime keys it, by the route the build filed the class under; by the template
  // where a manifest from before that was named says nothing of it.
  const route = entry.cache?.route ?? entry.pathname;
  return startMemberRead(input.edge, settings, { scopeId, route, pathname });
}

/**
 * The route a hosted document request is served, once the middleware has had its say. A rewrite
 * is looked up the way the client's own URL was — an exact route first, then the class of a
 * dynamic route — against the request as the middleware left it; so is a request whose headers it
 * changed, which the rules after it read (`asked` is the request's own).
 */
function hostedEntry(
  manifest: ProjectManifest,
  classification: RequestClass,
  middleware: MiddlewareOutcome,
  asked: { readonly headers: Headers; readonly credentials: HostCredentials },
): RouteEntry | undefined {
  const classified =
    classification.kind === 'document' || forRouter(classification)
      ? classification.entry
      : undefined;
  if (middleware.kind !== 'continue') {
    return classified;
  }
  if (
    !middleware.rewritten &&
    headersLeftAlone(asked.headers, middleware.requestHeaders, asked.credentials)
  ) {
    return classified;
  }
  const { url, requestHeaders } = middleware;
  // Behind the same gate the client's own pathname passed: the middleware runs before the
  // `beforeFiles` rewrites and the filesystem, so a rule of theirs claims the path it was
  // rewritten to, or the request it changed, exactly as it would have claimed the path the client
  // asked for (`classifyRequest`).
  if (isReserved(manifest, url, requestHeaders, true)) {
    return undefined;
  }
  return (
    findRouteEntry(manifest, url.pathname) ??
    (isExactPathname(manifest, url.pathname)
      ? undefined
      : matchDynamicRoute(manifest, url, requestHeaders))
  );
}

/**
 * Let a read the response will not wait for finish: it fills the isolate's memory for the next
 * request that wants it, and a read torn down with the response would fill nothing.
 */
function abandon(edge: EdgeContext, preload: Preload): void {
  if (preload.kind === 'shell') {
    edge.ctx.waitUntil(preload.read);
    return;
  }
  edge.ctx.waitUntil(preload.read.load);
  if (preload.read.shell !== undefined) {
    edge.ctx.waitUntil(preload.read.shell);
  }
  if (preload.member !== undefined) {
    edge.ctx.waitUntil(preload.member.pending);
  }
}

function preloadFor(
  input: HostedDocumentInput,
  target: { readonly entry: RouteEntry; readonly pathname: string; readonly guessed: boolean },
): Preload {
  const { entry, pathname } = target;
  const key = generationKeyOf(input, entry);
  if (key === undefined) {
    return { kind: 'shell', entry, read: loadShell(entry.shell, input.resolved.shell, input.edge) };
  }
  const settings = runtimeCacheOf(input.edge.policy);
  // Beside a member's own record, the build's shell is not read ahead (`startRecordRead`). Nor
  // beside the record of a route only guessed at, nor that route's member: a record and a shell, or
  // a class and a member, each read the data center's copy beside KV or storage, and a guess the
  // middleware does not bear out would hold four of the six connections a request has while the
  // route it did settle on read its own (`cache/document.ts`). The shell is read once the record
  // says it is the one to serve, and the member once the middleware has settled the route
  // (`memberFor`).
  const build =
    target.guessed || upgradesMember(settings, entry, pathname)
      ? undefined
      : { entry, resolved: input.resolved };
  const read = startRecordRead(input.edge, key, settings, build);
  const member = target.guessed ? undefined : memberReadFor(input, entry, key.scopeId, pathname);
  return { kind: 'generation', entry, key, read, member };
}

/**
 * What the middleware last did with this document's pathname in this isolate, or `undefined` when
 * it has not run for it within the minute this is trusted for.
 *
 * A prediction, and nothing is served on it: the route a request is served is still the one its own
 * middleware settles on, and the middleware runs for every request it covers. What it decides is
 * only what is read ahead of the middleware: the route the middleware last rewrote the pathname
 * onto, where the URL names another or none — the root of a localised application, a default
 * locale's bare path — and nothing where it last left the pathname on no route the edge serves.
 */
function rewriteSeen(input: HostedDocumentInput): RewriteSeen | undefined {
  const key = rewriteSeenKey(input.edge.manifestId, input.url.pathname);
  return input.edge.runtime.memory.rewritesSeen.get(key);
}

/**
 * The route to read ahead of the middleware, and the pathname it would be served at: the one the
 * middleware last rewrote this pathname onto; none when it last left it on no route the edge
 * serves, or onto one already off the edge, demoted or suspect (`offTheEdge`), which goes to the
 * Worker whole however the read comes out; else the one the URL names. A wrong guess costs a read
 * the response lets go of, which still fills the isolate's memory; a right one takes the read off
 * the time to the first byte.
 */
function preloadTarget(
  input: HostedDocumentInput,
  seen: RewriteSeen | undefined,
):
  | { readonly entry: RouteEntry; readonly pathname: string; readonly guessed: boolean }
  | undefined {
  // A request of the router reads nothing ahead of the middleware: the read is the whole answer,
  // and starting it before the route is settled would as often be the wrong route's. Nor does a
  // `HEAD`: what is read shapes only its headers, and only once the middleware lets it through, so
  // a health check the middleware answers itself reads nothing on every probe.
  if (
    seen?.kind === 'unserved' ||
    forRouter(input.classification) ||
    input.request.method === 'HEAD'
  ) {
    return undefined;
  }
  const { manifest } = input;
  if (seen?.kind === 'served' && Object.hasOwn(manifest.routes, seen.route)) {
    const entry = manifest.routes[seen.route];
    if (entry !== undefined) {
      // A rewrite that kept the route and the pathname the URL already names — a query changed,
      // nothing else — guessed at nothing: it is read ahead as the route the URL names is.
      const named =
        input.classification.kind === 'document' &&
        input.classification.entry === entry &&
        seen.pathname === input.url.pathname;
      return offTheEdge(input.edge, entry) === undefined
        ? { entry, pathname: seen.pathname, guessed: !named }
        : undefined;
    }
  }
  // Nor a route already off the edge, demoted or suspect: it goes to the Worker whole, whatever is
  // read for it. The pointer looked up the pathname the client asked for, which for a member of a
  // class is not the template the class is condemned under.
  return input.classification.kind === 'document' &&
    offTheEdge(input.edge, input.classification.entry) === undefined
    ? { entry: input.classification.entry, pathname: input.url.pathname, guessed: false }
    : undefined;
}

const UNSERVED: RewriteSeen = { kind: 'unserved' };

/**
 * The longest pathname the rewrite memo remembers, as asked for or as rewritten to. Far longer than
 * any page's, and short enough that a memo full of them is a few megabytes.
 */
const MAX_REMEMBERED_PATHNAME_CHARS = 1024;

/**
 * Remember what the middleware did with the document's pathname: the route it rewrote the request
 * onto, or that it rewrote it onto none the edge serves. A request on the route its URL names that
 * it left there needs no guess, and forgets one. A request on no route that it left there changes
 * nothing: the build proved no route for the pathname, where the memo is kept for the visitors it is
 * rewritten for, or the request names none only for what it carries — a cookie a rule ahead of the
 * filesystem matches — which says nothing of the pathname's other visitors either way.
 */
function rememberRewrite(
  input: HostedDocumentInput,
  middleware: MiddlewareOutcome,
  entry: RouteEntry | undefined,
): void {
  // Navigations only, the ones whose URL names no proved route among them — the root of a localised
  // application rewritten onto its language is what the memo is for. What the middleware makes of a
  // request of the router at the same pathname is its own.
  if (middleware.kind !== 'continue' || forRouter(input.classification)) {
    return;
  }
  // The client chooses the pathname, and the memo is bounded by a count of entries: one long enough
  // to hold the isolate's memory to ransom is not remembered — as asked for, which every memo is
  // kept under, nor as rewritten to, which only a served one keeps.
  if (input.url.pathname.length > MAX_REMEMBERED_PATHNAME_CHARS) {
    return;
  }
  const memory = input.edge.runtime.memory.rewritesSeen;
  const key = rewriteSeenKey(input.edge.manifestId, input.url.pathname);
  if (!middleware.rewritten) {
    if (input.classification.kind === 'document') {
      memory.delete(key);
    }
  } else if (entry === undefined) {
    memory.set(key, UNSERVED);
  } else if (middleware.url.pathname.length <= MAX_REMEMBERED_PATHNAME_CHARS) {
    memory.set(key, { kind: 'served', route: entry.pathname, pathname: middleware.url.pathname });
  } else {
    memory.delete(key);
  }
}

/**
 * The member's record for the request as the middleware left it: the one read ahead when the
 * middleware left the pathname alone, else a read started now, the other left to finish.
 */
function memberFor(
  input: HostedDocumentInput,
  served: { readonly entry: RouteEntry; readonly key: GenerationKey; readonly pathname: string },
  ready: Preload | undefined,
): MemberRead | undefined {
  const preloaded = ready?.kind === 'generation' ? ready.member : undefined;
  if (preloaded?.pathname === served.pathname) {
    return preloaded;
  }
  if (preloaded !== undefined) {
    input.edge.ctx.waitUntil(preloaded.pending);
  }
  return memberReadFor(input, served.entry, served.key.scopeId, served.pathname);
}

/**
 * A document request of a hosted application.
 *
 * The middleware runs before the route is looked up, because it is what decides the route: the
 * root of a localised app is a rewrite to `/en` or `/ja`, and only the middleware knows which. So
 * a request that names no proved route is still given to it, and served a shell if the rewrite
 * lands on one. What the middleware answers outright — a redirect, a whole response — goes to the
 * client as it is; what it cannot decide, or fails to, goes to the application's Worker, which
 * runs the middleware itself and serves the whole document.
 */
export async function routeHostedDocument(input: HostedDocumentInput): Promise<Response> {
  const { request, url, edge, manifest } = input;
  // Validation proves the shell and its continuation, under the route's own key; what the
  // middleware would make of the request — a redirect, a cookie — is not what is being proved.
  if (edge.validated) {
    return serveHostedDocument(input, { kind: 'skipped', reason: 'validated' }, undefined);
  }
  if (!middlewareMatches(edge, manifest, url, request.headers)) {
    return serveHostedDocument(input, { kind: 'skipped', reason: 'unmatched' }, undefined);
  }
  // A middleware answers a request for a page's props in a way of its own — a rewrite or a
  // redirect is said in headers for the client's router (`x-nextjs-rewrite`) — which the edge does
  // not reproduce: such a request is the Function's, which runs the middleware itself. A build with
  // a middleware holds no props for the edge (`routePagesData`); this keeps it so for one that did.
  if (input.classification.kind === PAGES_DATA) {
    return input.passthrough(PAGES_DATA);
  }
  const headerRules = judgeHeaderRulesAhead(edge, manifest, url, request.headers);
  const seen = rewriteSeen(input);
  // The shell the request is served — or the record it is the current generation of — is read
  // while the middleware runs, so the two costs overlap: the middleware most often leaves the route
  // alone, and the read is then already done when the document is composed. A route it rewrote this
  // pathname onto before is read instead (`preloadTarget`). A guess the middleware does not bear
  // out is let go, and that read stays useful for the next request that lands on the route. A
  // `HEAD` reads nothing ahead, and nor does a route already off the edge, demoted or suspect
  // (`preloadTarget`).
  const target = preloadTarget(input, seen);
  const preload = target === undefined ? undefined : preloadFor(input, target);
  const middlewareStarted = edge.runtime.now();
  const middleware = await runMiddleware(edge, request);
  const middlewareMs = edge.runtime.now() - middlewareStarted;
  const answered = {
    pathname: url.pathname,
    middlewareMs: middleware.middlewareMs,
    dispatches: dispatchedFor(middleware),
  };
  if (middleware.kind === 'responded') {
    if (preload !== undefined) {
      abandon(edge, preload);
    }
    return middlewareResponse(edge, request, middleware.response, answered);
  }
  if (middleware.kind === 'failed' || middleware.kind === 'external-rewrite') {
    if (preload !== undefined) {
      abandon(edge, preload);
    }
    // A failed middleware's time goes with the request it was given up for, as a file's does.
    return middleware.kind === 'failed'
      ? input.passthrough(middlewareFailedReason(middleware.cause), middleware)
      : followExternalRewrite(edge, request, middleware, {
          ...answered,
          configured: headerRules.response,
        });
  }
  // What the document reports it waited on includes the middleware from here on.
  const timed = { ...edge, timings: { ...edge.timings, middlewareMs } };
  return serveAfterItsMiddleware({ ...input, edge: timed, headerRules }, middleware, preload);
}

/**
 * `serveHostedDocument`, once the middleware ran — or, where a pattern of the application's would
 * cost more against the request as the middleware left it than the edge runs (`budgetPatterns`),
 * the request handed on with what the middleware decided, which the Function does not run again.
 */
async function serveAfterItsMiddleware(
  input: HostedDocumentInput,
  middleware: MiddlewareOutcome,
  preload: Preload | undefined,
): Promise<Response> {
  try {
    return await serveHostedDocument(input, middleware, preload);
  } catch (error) {
    if (!(error instanceof PatternBudgetExceededError)) {
      throw error;
    }
    if (preload !== undefined) {
      abandon(input.edge, preload);
    }
    return input.passthrough(PATTERN_BUDGET, middleware);
  }
}

/**
 * The middleware left the request on no proved route: a shipped file it rewrote to, a member of a
 * class with no shell served from its own record (`serveMemberWithoutShell`), or the Worker.
 */
function unprovedRoute(
  input: HostedDocumentInput,
  middleware: MiddlewareOutcome,
): Promise<Response> {
  const { classification } = input;
  // A rewrite that lands on a shipped file — a download behind a friendlier path — is served
  // from storage as that file, whatever its size; the Worker carries only the small ones.
  if (middleware.kind === 'continue' && middleware.rewritten) {
    const file = serveHostedFile(
      { ...input, configured: input.headerRules?.response },
      middleware.url,
      middleware,
      dispatchedFor(middleware),
    );
    if (file !== undefined) {
      return file;
    }
  }
  const toWorker: Unserved = (route, waited) => {
    const reason =
      classification.kind === 'document' ? 'rewrite-not-proved' : passthroughReason(classification);
    return input.passthrough(reason, middleware, route, waited);
  };
  return serveMemberWithoutShell(input, middleware, toWorker) ?? toWorker();
}

/** Compose the document for a route: from its record when the deployment has one, else its shell. */
function composeHostedDocument(
  input: HostedDocumentInput,
  entry: RouteEntry,
  middleware: MiddlewareOutcome,
  ready: Preload | undefined,
): Promise<Response> {
  if (input.classification.kind === SEGMENT_PREFETCH) {
    return composeSegment(input, entry, middleware);
  }
  if (input.classification.kind === RSC_PAYLOAD) {
    return composePayload(input, entry, middleware);
  }
  if (input.classification.kind === PAGES_DATA) {
    return composePagesData(input, entry);
  }
  const document = {
    headerRules: input.headerRules,
    request: input.request,
    entry,
    manifest: input.manifest,
    resolved: input.resolved,
    edge: input.edge,
    middleware:
      middleware.kind === 'continue' || middleware.kind === 'skipped' ? middleware : undefined,
    passthrough: input.passthrough,
  };
  const key = generationKeyOf(input, entry);
  if (key === undefined) {
    return handleDocument({
      ...document,
      shellRead: ready?.kind === 'shell' ? ready.read : undefined,
      generation: undefined,
    });
  }
  const settings = runtimeCacheOf(input.edge.policy);
  const { pathname } = requestAsLeft(input, middleware).url;
  // Beside a member's own record, the build's shell is not read ahead (`startRecordRead`), nor for
  // a `HEAD`, which reads it only when the record ends in a build complete in itself.
  const build =
    upgradesMember(settings, entry, pathname) || input.request.method === 'HEAD'
      ? undefined
      : { entry, resolved: input.resolved };
  // The record the first byte waits on goes out before the member's own beside it. A rewrite can
  // leave the reads started ahead of the middleware for the route the URL named still out, and a
  // request's connections are few (`cache/document.ts`): the read the response is gated on is not
  // the one left queued.
  const generationRead =
    ready?.kind === 'generation' ? ready.read : startRecordRead(input.edge, key, settings, build);
  return serveCachedDocument({
    ...document,
    key,
    settings,
    generationRead,
    member: memberFor(input, { entry, key, pathname }, ready),
    passthrough: input.passthrough,
  });
}

/** Serve the route the middleware left the request on, with the read that may already be under way. */
function serveHostedDocument(
  input: HostedDocumentInput,
  middleware: MiddlewareOutcome,
  preload: Preload | undefined,
): Promise<Response> {
  const { manifest, classification } = input;
  const entry = hostedEntry(manifest, classification, middleware, {
    headers: input.request.headers,
    credentials: input.edge.host.credentials,
  });
  rememberRewrite(input, middleware, entry);
  const preloaded = preload !== undefined && entry?.pathname === preload.entry.pathname;
  if (preload !== undefined && !preloaded) {
    abandon(input.edge, preload);
  }
  if (entry === undefined) {
    return unprovedRoute(input, middleware);
  }
  const off = offTheEdge(input.edge, entry);
  if (off !== undefined) {
    // Off the edge, or condemned while the middleware ran: a read started for it is left to finish,
    // as every other read this function does not serve from is, rather than cut off half read.
    if (preload !== undefined && preloaded) {
      abandon(input.edge, preload);
    }
    return input.passthrough(off, middleware, entry.pathname);
  }
  const left = requestAsLeft(input, middleware);
  if (bypassed(manifest, entry, left.url, left.headers)) {
    // The read started before the middleware ran is left to finish, as every other read this
    // function abandons is: it fills the isolate's memory for the next request that wants it.
    if (preload !== undefined && preloaded) {
      abandon(input.edge, preload);
    }
    return input.passthrough('bypass-for', middleware, entry.pathname);
  }
  return composeHostedDocument(input, entry, middleware, preloaded ? preload : undefined);
}
