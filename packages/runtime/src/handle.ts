import { type ResolveRoutesResult, resolveRoutes, responseToMiddlewareResult } from '@next/routing';
import { isPagesDataPathname } from '@upwind/core/bundle';
import type { ImagesConfig } from '@upwind/core/images';
import { staticFileStatus } from '@upwind/core/manifest';
import {
  MIDDLEWARE_DONE_HEADER,
  MIDDLEWARE_ONLY_HEADER,
  pathFromHeaders,
  RESUME_PRERENDER_ESCAPED_HEADER,
  RESUME_PRERENDER_HEADER,
} from '@upwind/core/paas';
import { releaseStream } from '@upwind/core/util';

import { withClock } from './cache/clock.ts';
import { type RequestContext, withRequestContext } from './cache/context.ts';
import {
  documentFromBuild,
  notFound,
  postponedOf,
  rscFromBuild,
  staticFileResponse,
} from './documents.ts';
import { entryFor, hasEntry, middlewareHandler } from './entries.ts';
import { failureAnswer } from './error-pages.ts';
import {
  handleDetached,
  handleForeground,
  outcomeOn,
  regenerateMode,
  serveFromGeneration,
  withBackgroundRegeneration,
} from './generations.ts';
import {
  applicationHosts,
  fetchRemoteSource,
  imageFallback,
  sourceRequest,
  sourceResponse,
} from './image-fallback.ts';
import { hasBody, isRscRequest, wantsBlockingMetadata } from './incoming.ts';
import { type Resolved, servePagesData, serveRouteHandler } from './outputs.ts';
import { notFoundData } from './pages-not-found.ts';
import { rscRepresentation } from './representations.ts';
import { DEFAULT_PROXY_BODY_LIMIT, splitBody } from './request-body.ts';
import {
  askedOf,
  internalRedirect,
  landedRoute,
  type MiddlewareInvoker,
  missesInPlainText,
  parametersDecode,
  pathnamesFor,
  redirectResponse,
  routingI18n,
  routingTables,
  resolvedOf,
  routedHeaders,
  withoutRepeatedSlashes,
  withRewriteStatus,
  withRoutingHeaders,
} from './routing.ts';
import { carriesResumeState, handleRuntimeResume } from './runtime-resume.ts';
import {
  type HandleInput,
  HTTP_NOT_FOUND,
  HTTP_OK,
  initUrlOf,
  invokeEntry,
  plainNotFoundResponse,
  resume,
  resumeUrl,
  type RoutedInput,
  stripPlatformHeaders,
  withoutBody,
} from './serve.ts';
import { entrypointKindOf, findShell, getStore, type Store } from './store.ts';
import { renderedBy, serveWithBody } from './with-body.ts';

/**
 * Request handling for a deployment's Worker.
 *
 * The ways in, all chosen by the edge:
 * - middleware only: run `proxy.ts` and hand back its raw response, so the edge can apply the
 *   rewrite or cookies before serving a shell it holds itself;
 * - regenerate: the edge served a stale generation, or had none valid to serve, and asks for a
 *   new one — after a resume, in the foreground, or on its own;
 * - resume: the edge served a shell, the build's or a generation's, and wants the rest;
 * - everything else: a full request, routed as Next.js would, with a shell streamed ahead of its
 *   resume whenever the build or the cache holds one.
 *
 * A prerendered route is never rendered from scratch for a visitor: its shell and postponed
 * state come from the build or a generation, and rendering only what they left out is both
 * faster and the only path the Workers runtime is known to complete. A route on Next.js's edge
 * runtime is the exception on both counts: its handler renders with nothing postponed, so it is
 * rendered whole, and the cache holds no generation of it.
 */

const MIDDLEWARE_ENTRY_ID = '/_middleware';
const HTTP_PERMANENT_REDIRECT = 308;
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_BAD_GATEWAY = 502;
const HTTP_METHOD_NOT_ALLOWED = 405;
const FILE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
/** What a Pages Router data URL ends in. */
const DATA_SUFFIX = '.json';

export type { HandleInput } from './serve.ts';

async function runMiddleware(input: HandleInput, request: Request): Promise<Response | undefined> {
  const handler = await middlewareHandler(input, MIDDLEWARE_ENTRY_ID);
  if (handler === undefined) {
    return undefined;
  }
  return handler(request, {
    waitUntil: input.waitUntil,
    requestMeta: { relativeProjectDir: '.' },
  });
}

/** The edge holds the build's shell: return only the resumed part. */
async function handleResume(
  input: RoutedInput,
  store: Store,
  prerenderId: string,
): Promise<Response> {
  const prerender = store.prerendersById.get(prerenderId);
  if (prerender === undefined) {
    return new Response(`unknown prerender ${prerenderId}`, { status: HTTP_NOT_FOUND });
  }
  const entry = await entryFor(input, prerender.route);
  if (entry === undefined) {
    return new Response(`no entrypoint for ${prerender.route}`, { status: HTTP_NOT_FOUND });
  }
  // The edge is told which shells it may serve, and a route that cannot resume one is not among
  // them (`edgeServablePrerenders`): rendering the whole document here would send the client the
  // shell twice, so the platform hears that it asked for something it should not have.
  if (entry.kind === 'edge') {
    return new Response(`${prerender.route} is on the edge runtime and cannot resume a shell`, {
      status: HTTP_INTERNAL_ERROR,
    });
  }
  return resume({
    input,
    handler: entry.handler,
    postponed: postponedOf(store, prerender),
    url: resumeUrl(input.request),
  });
}

async function externalRewrite(request: Request, target: URL): Promise<Response> {
  const headers = stripPlatformHeaders(request.headers);
  headers.delete('host');
  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });
  } catch {
    releaseStream(request.body, 'rewrite failed: handler body unused');
    // A name that does not resolve, a refused connection, a handshake that failed: the target is
    // unreachable, which is not the application failing. Left to propagate it would leave the
    // top-level catch reporting this app's own 500.
    return new Response('rewrite target unavailable', { status: HTTP_BAD_GATEWAY });
  }
  return new Response(response.body, response);
}

/**
 * Serve a document: the shell from the cache or the build, then its resume, as one response. A
 * member of a route the build left to the first request for it (`fallback: 'blocking'`, a
 * parameter outside `generateStaticParams`) is rendered once and kept, as Next.js keeps it. A
 * route on the edge runtime has no generation: it is served as the build wrote it, or rendered.
 */

async function serveDocument(input: RoutedInput, store: Store, asked: Resolved): Promise<Response> {
  const rendered = await renderedBy(input, store, asked);
  if (rendered === undefined) {
    return notFound(input, store, new URL(input.request.url));
  }
  const { entry, resolved } = rendered;
  const shell = findShell(store, resolved.route, resolved.pathname);
  // A partially prerendered page streams its metadata after the shell. Next.js bypasses the shell
  // for a visitor it sends blocking metadata to and renders the page whole
  // (`shouldForceDynamicPPRRender`, in the page's handler), so the handler is asked for it.
  if (
    shell?.postponed !== undefined &&
    wantsBlockingMetadata(input.request, store.manifest.config.htmlLimitedBots)
  ) {
    return invokeEntry(input, entry, resolved.url, failureAnswer(store, entry, resolved.route));
  }
  if (shell !== undefined && entry.kind === 'node') {
    const built = shell.body !== undefined;
    const current = await serveFromGeneration(
      input,
      store,
      {
        // The route the build filed the shell under, which its entry is keyed by: a locale's
        // route of an application with `i18n` finds the page's (`findShell`).
        route: shell.route,
        pathname: built ? shell.pathname : resolved.pathname,
        url: resolved.url,
        representation: 'html',
        onMiss: built ? 'build' : 'render',
      },
      entry.handler,
    );
    if (current !== undefined) {
      return current;
    }
  }
  return documentFromBuild(input, store, resolved, { entry, status: HTTP_OK });
}

/**
 * Serve a React Server Components request: resume from the current generation's state for a
 * navigation, serve its static payload for a prefetch, or fall back to the build's state.
 *
 * A regeneration commits the payload and every prefetched segment it produced beside the
 * document. Answering these from the build while documents come from a newer generation is how a
 * client navigation lands on a page assembled out of two of them.
 */
async function serveRsc(input: RoutedInput, store: Store, asked: Resolved): Promise<Response> {
  const rendered = await renderedBy(input, store, asked);
  if (rendered === undefined) {
    return notFound(input, store, new URL(input.request.url));
  }
  const { entry, resolved } = rendered;
  const shell = findShell(store, resolved.route, resolved.pathname);
  if (entry.kind === 'node') {
    const built = shell?.body !== undefined;
    const current = await serveFromGeneration(
      input,
      store,
      {
        // As a document is looked up (`serveDocument`): under the route the build filed the shell
        // under, which its entry is keyed by.
        route: shell?.route ?? resolved.route,
        pathname: built ? shell.pathname : resolved.pathname,
        url: resolved.url,
        representation: rscRepresentation(input.request, store),
        prefetch: input.request.headers.get(store.manifest.routing.rsc.prefetchHeader) === '1',
        onMiss: 'build',
      },
      entry.handler,
    );
    if (current !== undefined) {
      return current;
    }
  }
  return rscFromBuild(input, store, entry, resolved);
}

/** What the middleware left behind that the router does not hand back. */
interface MiddlewareTrace {
  /** Whether the middleware ran for this request, and so may still read its side of the body. */
  invoked: boolean;
  /** A whole response the middleware sent, to answer with as it is. */
  response: Response | undefined;
  /** The request headers as the middleware rewrote them, for whoever handles the request. */
  requestHeaders: Headers | undefined;
  /** Where the middleware rewrote the request to, when it did: what a route that matched nothing was asked at. */
  rewrite: URL | undefined;
  /** The status the middleware gave its rewrite, where it gave one other than 200. */
  status: number | undefined;
}

/**
 * The URL a middleware is handed: for a data request, the page it is for.
 *
 * Next.js hands a middleware the page a `_next/data` request asks for, with the query, and the
 * request's `x-nextjs-data` says what it is (`runMiddleware`, `server/next-server.ts`); only
 * `skipProxyUrlNormalize` hands it the URL as it came. `@next/routing` hands it the data URL. The
 * middleware's adapter writes `x-nextjs-rewrite` and `x-nextjs-redirect` in the form of the URL it
 * was handed, so a redirect of `/_next/data/<id>/es/old-home.json` came back as the data URL of
 * `/es/new-home` where the client's router is answered with the page (`server/web/adapter.ts`).
 */
function middlewareUrl(url: URL, store: Store): URL {
  const { basePath, skipProxyUrlNormalize, trailingSlash } = store.manifest.config;
  const prefix = `${basePath}/_next/data/${store.manifest.buildId}/`;
  if (
    skipProxyUrlNormalize === true ||
    !url.pathname.startsWith(prefix) ||
    !url.pathname.endsWith(DATA_SUFFIX)
  ) {
    return url;
  }
  const page = url.pathname.slice(prefix.length, -DATA_SUFFIX.length);
  const normalized = new URL(url);
  const pathname = page === 'index' ? basePath || '/' : `${basePath}/${page}`;
  // With the trailing slash the application keeps its pages under (`maybeAddTrailingSlash`).
  normalized.pathname = trailingSlash && !pathname.endsWith('/') ? `${pathname}/` : pathname;
  return normalized;
}

/**
 * Run the middleware for the router and keep what it decided.
 *
 * `resolveRoutes` returns the response headers routing collected (a middleware's cookies among
 * them) but not the request headers a middleware overrode: those are read off the object the
 * middleware result was applied to, which the router hands in and never hands back.
 */
function middlewareInvoker(
  input: RoutedInput,
  store: Store,
  trace: MiddlewareTrace,
): MiddlewareInvoker {
  return async (ctx) => {
    trace.invoked = true;
    const response = await runMiddleware(
      input,
      new Request(middlewareUrl(ctx.url, store), {
        method: input.request.method,
        headers: ctx.headers,
        ...(hasBody(input.request.method) && { body: ctx.requestBody, duplex: 'half' }),
      }),
    );
    if (response === undefined) {
      return {};
    }
    const result = responseToMiddlewareResult(response, ctx.headers, ctx.url);
    if (result.bodySent === true) {
      trace.response = response;
    }
    trace.requestHeaders = result.requestHeaders;
    trace.rewrite = result.rewrite;
    if (result.rewrite !== undefined && response.status !== HTTP_OK) {
      trace.status = response.status;
    }
    return result;
  };
}

/**
 * The source `/_next/image` names, unresized; the edge does the optimizing. The request is what
 * routing resolved — a rewrite may have led here. A path of the application is routed in full,
 * its middleware included: what protects `/private/avatar.png` protects it behind the optimizer
 * too, as under Next.js, whose optimizer asks its router the same way. Nothing of the client's
 * request goes to a URL of the internet, nor to the application.
 */
async function serveImageSource(
  input: RoutedInput,
  store: Store,
  images: ImagesConfig,
  resolved: Resolved,
): Promise<Response> {
  const { request } = input;
  const query = new URL(resolved.url, request.url).searchParams;
  const fallback = imageFallback(request, query, images);
  if (fallback.kind === 'response') {
    return fallback.response;
  }
  const { params } = fallback;
  const { method } = request;
  if (fallback.kind === 'remote') {
    const remote = await fetchRemoteSource({
      href: params.href,
      images,
      ownHosts: applicationHosts(request),
    });
    return remote.kind === 'refused'
      ? remote.response
      : sourceResponse({ source: remote.response, params, images, internal: false, method });
  }
  const source = sourceRequest(request, params.href);
  const answered = await handleFull({ ...input, request: source, initURL: source.url }, store);
  return sourceResponse({ source: answered, params, images, internal: true, method });
}

/**
 * A request routing found no route for: a middleware redirect, or a rule that answers with a
 * status, comes back as headers and a status with no route behind them; anything else is the
 * not-found document, rendered for the request as the middleware left it — at the URL it
 * rewrote the request to, when it did, since the router hands back no URL of its own.
 */
async function unrouted(
  routed: ResolveRoutesResult,
  forwarded: RoutedInput,
  store: Store,
  at: URL,
): Promise<Response> {
  const location = routed.resolvedHeaders?.get('location') ?? undefined;
  if (routed.status !== undefined) {
    // Nothing below will read the forwarded body — the slower half of the request's tee — and
    // leaving it queued keeps the whole upload in the isolate for an answer that has no body.
    releaseStream(forwarded.request.body, 'routing exit: handler body unused');
    return location === undefined
      ? new Response(null, { status: routed.status, headers: new Headers(routed.resolvedHeaders) })
      : redirectResponse(location, routed.status, routed.resolvedHeaders);
  }
  // A data request is answered in its own terms. The client router parses what comes back as the
  // page's props, and a document under a 404 would be parsed as those — Next.js answers its own
  // `notFound` on a data request with exactly this, and so does the platform for a page that is
  // not there at all.
  if (isPagesDataPathname(new URL(forwarded.request.url).pathname)) {
    return withRoutingHeaders(notFoundData(), routed.resolvedHeaders);
  }
  if (missesInPlainText(forwarded.request, at, store.manifest.config)) {
    releaseStream(forwarded.request.body, 'plain not found: handler body unused');
    return withRoutingHeaders(plainNotFoundResponse(), routed.resolvedHeaders);
  }
  return withRoutingHeaders(await notFound(forwarded, store, at), routed.resolvedHeaders);
}

async function handleFull(input: RoutedInput, store: Store): Promise<Response> {
  const url = new URL(input.request.url);
  const collapsed = withoutRepeatedSlashes(url);
  if (collapsed !== undefined) {
    return redirectResponse(collapsed, HTTP_PERMANENT_REDIRECT, undefined);
  }
  const headers = routedHeaders(input.request, url, store);
  return (await internalRedirect(store, url, headers)) ?? routeAndServe(input, store, url, headers);
}

/**
 * A request routed as Next.js's router routes it, and answered by what it resolved to. The router
 * is handed the client's headers as `routedHeaders` leaves them.
 */
async function routeAndServe(
  input: RoutedInput,
  store: Store,
  url: URL,
  requestHeaders: Headers,
): Promise<Response> {
  const { request } = input;
  // Asked of the table, not of the module: a middleware the edge has already run is not loaded.
  const skipMiddleware =
    request.headers.get(MIDDLEWARE_DONE_HEADER) === '1' || !hasEntry(input, MIDDLEWARE_ENTRY_ID);
  const trace: MiddlewareTrace = {
    invoked: false,
    response: undefined,
    requestHeaders: undefined,
    rewrite: undefined,
    status: undefined,
  };
  // Split only where a middleware may read it: with none to run the router hands no body to
  // anything, and a side nobody reads would hold every byte the handler reads.
  const { i18n, proxyClientMaxBodySize } = store.manifest.config;
  const bodies = splitBody(
    request.body,
    skipMiddleware
      ? undefined
      : { limit: proxyClientMaxBodySize ?? DEFAULT_PROXY_BODY_LIMIT, url: request.url },
  );
  /**
   * Let go of the side no handler will read.
   *
   * What the middleware read ahead of the handler is queued for the handler's side, so a routing
   * exit that leaves it unread keeps that part of the upload in the isolate, for an answer that
   * needs none of it.
   */
  const dropHandlerBody = (): void => {
    releaseStream(bodies.handler, 'routing exit: handler body unused');
  };
  const routed = await resolveRoutes({
    url,
    buildId: store.manifest.buildId,
    basePath: store.manifest.config.basePath,
    requestBody: bodies.routing ?? new ReadableStream(),
    headers: requestHeaders,
    pathnames: pathnamesFor(store, url),
    ...(i18n !== null && i18n !== undefined && { i18n: routingI18n(i18n) }),
    routes: routingTables(store, skipMiddleware, url),
    invokeMiddleware: middlewareInvoker(input, store, trace),
  });
  if (routed.middlewareResponded === true && trace.response !== undefined) {
    // The middleware's own answer may be streaming its side of the body back: that side stays.
    dropHandlerBody();
    return trace.response;
  }
  // A middleware that ran may still read its side after routing — work it left to `waitUntil` —
  // and that side holds no more than a proxy may read, so it stays. One that never ran leaves the
  // side to nothing, and nothing more is copied into it.
  if (!trace.invoked) {
    bodies.releaseRouting('routing done: no middleware ran');
  }
  if (routed.redirect !== undefined) {
    dropHandlerBody();
    return redirectResponse(
      routed.redirect.url.href,
      routed.redirect.status,
      routed.resolvedHeaders,
    );
  }
  if (!parametersDecode(routed.routeMatches)) {
    dropHandlerBody();
    return withRoutingHeaders(
      new Response('Bad Request', {
        status: HTTP_BAD_REQUEST,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
      routed.resolvedHeaders,
    );
  }
  const forwarded: RoutedInput = {
    ...input,
    request: new Request(request, {
      headers: trace.requestHeaders ?? requestHeaders,
      // The handler's side of a body split for the middleware; one never split goes on as the
      // request's own, which the request hands over as it is copied.
      ...(bodies.handler !== request.body && { body: bodies.handler, duplex: 'half' }),
    }),
  };
  if (routed.externalRewrite !== undefined) {
    return withRoutingHeaders(
      await externalRewrite(forwarded.request, routed.externalRewrite),
      routed.resolvedHeaders,
    );
  }
  if (routed.resolvedPathname === undefined || routed.invocationTarget === undefined) {
    return unrouted(routed, forwarded, store, trace.rewrite ?? url);
  }
  const { route, target } = landedRoute(store, routed.resolvedPathname, routed.invocationTarget);
  const asked = askedOf(request, input.initURL, url, trace.rewrite);
  const resolved = resolvedOf(store, route, target, asked);
  const { images } = store.manifest.config;
  if (images?.path === route) {
    return withRoutingHeaders(
      await serveImageSource(forwarded, store, images, resolved),
      routed.resolvedHeaders,
    );
  }
  return withRewriteStatus(
    store,
    resolved.route,
    withRoutingHeaders(
      await serveResolved(forwarded, store, resolved, url),
      routed.resolvedHeaders,
    ),
    trace.status,
  );
}

/** The answer for a resolved route: a shipped file, a handler, or a document or RSC render. */
async function serveResolved(
  input: RoutedInput,
  store: Store,
  resolved: Resolved,
  asked: URL,
): Promise<Response> {
  const { request } = input;
  const staticFile = staticFileResponse(
    store,
    resolved.route,
    staticFileStatus(resolved.route, store.manifest.config.basePath),
  );
  if (staticFile !== undefined) {
    // A file answers a read and nothing else; the edge sends every other method here.
    return FILE_METHODS.has(request.method)
      ? staticFile
      : new Response('Method Not Allowed', { status: HTTP_METHOD_NOT_ALLOWED });
  }
  if (hasBody(request.method)) {
    return (
      (await serveWithBody(input, store, resolved)) ??
      new Response('Method Not Allowed', { status: HTTP_METHOD_NOT_ALLOWED })
    );
  }
  // Read off the route when routing resolved to a data output of the build, and off the pathname
  // the client asked for otherwise: a data URL the build left no output for is normalized to its
  // page before the dynamic matchers run, and the page is all the router hands back. The request
  // still says `_next/data`, and that is what the answer has to be.
  if (isPagesDataPathname(resolved.route) || isPagesDataPathname(asked.pathname)) {
    return servePagesData(input, store, resolved);
  }
  if (entrypointKindOf(store, resolved.route) === 'app-route') {
    return serveRouteHandler(input, store, resolved);
  }
  if (isRscRequest(request)) {
    return serveRsc(input, store, resolved);
  }
  return serveDocument(input, store, resolved);
}

/** A resume, of the build's shell or of a generation's; regenerated behind when the edge asks. */
async function handleAnyResume(
  input: RoutedInput,
  store: Store,
  prerenderId: string | null,
): Promise<Response> {
  const response = await (prerenderId === null
    ? handleRuntimeResume(input)
    : handleResume(input, store, prerenderId));
  return await withBackgroundRegeneration(input, store, response);
}

async function routeRequest(input: RoutedInput, store: Store): Promise<Response> {
  const { request } = input;
  if (request.headers.get(MIDDLEWARE_ONLY_HEADER) === '1') {
    const headers = routedHeaders(request, new URL(request.url), store);
    const response = await runMiddleware(input, new Request(request, { headers }));
    return (
      response ?? new Response(null, { status: HTTP_OK, headers: { 'x-middleware-next': '1' } })
    );
  }
  if (__ARKOR_WORKER_KIND__ === 'middleware') {
    return new Response('middleware worker', { status: HTTP_NOT_FOUND });
  }
  const mode = regenerateMode(request);
  if (mode === 'detached') {
    return await handleDetached(input, store);
  }
  if (mode === 'foreground') {
    const foreground = await handleForeground(input, store);
    return foreground.response ?? outcomeOn(await handleFull(input, store), foreground.outcome);
  }
  const prerenderId =
    pathFromHeaders(request.headers, RESUME_PRERENDER_HEADER, RESUME_PRERENDER_ESCAPED_HEADER) ??
    null;
  if (prerenderId !== null || carriesResumeState(request)) {
    return handleAnyResume(input, store, prerenderId);
  }
  return handleFull(input, store);
}

export async function handleRequest(handled: HandleInput): Promise<Response> {
  const context: RequestContext = {
    tables: { app: handled.app, edge: handled.edge },
    runtime: handled.cache,
    request: handled.request,
    waitUntil: handled.waitUntil,
    run: (work) => withClock(handled.clock, () => withRequestContext(context, work)),
  };
  const input: RoutedInput = { ...handled, initURL: initUrlOf(handled.request), run: context.run };
  return context.run(async () =>
    withoutBody(handled.request, await routeRequest(input, getStore())),
  );
}
