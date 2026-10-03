import { resolveRoutes } from '@next/routing';
import { isPagesDataPathname } from '@stayingupwind/core/bundle';
import type { ImagesConfig } from '@stayingupwind/core/images';
import { staticFileStatus } from '@stayingupwind/core/manifest';
import {
  MIDDLEWARE_DONE_HEADER,
  MIDDLEWARE_ONLY_HEADER,
  pathFromHeaders,
  RESUME_PRERENDER_ESCAPED_HEADER,
  RESUME_PRERENDER_HEADER,
  ROUTED_HEADER,
} from '@stayingupwind/core/paas';
import { releaseStream } from '@stayingupwind/core/util';

import { nowMs } from './cache/clock.ts';
import { requestContextFor } from './cache/context.ts';
import {
  crawlerWantsWholePage,
  documentFromBuild,
  notFound,
  postponedOf,
  rscFromBuild,
  staticFileResponse,
} from './documents.ts';
import { entryFor, hasEntry } from './entries.ts';
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
  applyRequestChanges,
  decodeHandOff,
  handOffOf,
  requestChanges,
  type Routed,
} from './handoff.ts';
import {
  applicationHosts,
  fetchRemoteSource,
  imageFallback,
  sourceRequest,
  sourceResponse,
} from './image-fallback.ts';
import { hasBody, isRscRequest, wantsBlockingMetadata } from './incoming.ts';
import {
  answerMiddlewareOnly,
  MIDDLEWARE_ENTRY_ID,
  middlewareInvoker,
  type MiddlewareTrace,
} from './middleware-invoke.ts';
import { type Resolved, servePagesData, serveRouteHandler } from './outputs.ts';
import {
  misdirected,
  misdirectedAhead,
  misdirectedTo,
  ownerOfResolved,
  withoutPlacementHeaders,
} from './placement.ts';
import { rscRepresentation } from './representations.ts';
import { DEFAULT_PROXY_BODY_LIMIT, splitBody } from './request-body.ts';
import {
  askedOf,
  internalRedirect,
  landedRoute,
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
  externalRewrite,
  type HandleInput,
  HTTP_NOT_FOUND,
  HTTP_OK,
  initUrlOf,
  invokeEntry,
  resume,
  resumeUrl,
  type RoutedInput,
  withInvalidatedTags,
  withoutBody,
} from './serve.ts';
import { entrypointKindOf, findShell, getStore, type Store } from './store.ts';
import { unrouted } from './unrouted.ts';
import { renderedBy, serveWithBody } from './with-body.ts';

/**
 * Request handling for a deployment's Function.
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

const HTTP_PERMANENT_REDIRECT = 308;
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_METHOD_NOT_ALLOWED = 405;
const FILE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export type { HandleInput } from './serve.ts';

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
    return invokeEntry(input, entry, resolved.url, {
      onFailure: failureAnswer(store, entry, resolved.route),
    });
  }
  const crawled =
    shell !== undefined && crawlerWantsWholePage(store, shell, resolved, input.request);
  if (shell !== undefined && entry.kind === 'node') {
    const built = shell.body !== undefined && !crawled;
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
  // Nothing kept the render; `documentFromBuild` answers a crawler with one all the same.
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
  routed: Pick<Routed, 'resolved' | 'source'>,
): Promise<Response> {
  const { resolved } = routed;
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
  // Routed already, by the Function that handed the image here: answered from there.
  if (routed.source !== undefined) {
    source.headers.set(ROUTED_HEADER, routed.source);
  }
  const answered = await handleFull({ ...input, request: source, initURL: source.url }, store);
  // A source another app Function holds is that Function's to fetch: the request for the image goes
  // there whole, and its source is local when it arrives (`answerResolved`).
  if (misdirectedTo(answered) !== undefined) {
    return answered;
  }
  return sourceResponse({ source: answered, params, images, internal: true, method });
}

async function handleFull(input: RoutedInput, store: Store): Promise<Response> {
  const url = new URL(input.request.url);
  const handedOff = input.request.headers.get(ROUTED_HEADER);
  if (handedOff !== null) {
    return serveHandedOff(input, store, url, handedOff);
  }
  const collapsed = withoutRepeatedSlashes(url);
  if (collapsed !== undefined) {
    return redirectResponse(collapsed, HTTP_PERMANENT_REDIRECT, undefined);
  }
  const headers = routedHeaders(input.request, url, store.manifest.config.basePath);
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
  return serveLanded(forwarded, store, url, {
    landed: landedRoute(store, routed.resolvedPathname, routed.invocationTarget),
    asked: askedOf(request, input.initURL, url, trace.rewrite),
    headers: routed.resolvedHeaders,
    status: trace.status,
    changes: () => requestChanges(requestHeaders, trace.requestHeaders),
  });
}

/** Where routing landed a request, and what it collected on the way. */
interface Landing {
  readonly landed: ReturnType<typeof landedRoute>;
  readonly asked: ReturnType<typeof askedOf>;
  readonly headers: Headers | undefined;
  readonly status: number | undefined;
  /** What the middleware changed of the request headers, for a Function the request is handed to. */
  readonly changes: () => ReturnType<typeof requestChanges>;
}

/** A request routing landed on a route: answered here, or handed to the Function that holds it. */
async function serveLanded(
  forwarded: RoutedInput,
  store: Store,
  url: URL,
  landing: Landing,
): Promise<Response> {
  const { route, target } = landing.landed;
  const routed: Routed = {
    resolved: resolvedOf(store, route, target, landing.asked),
    image: store.manifest.config.images?.path === route,
    headers: landing.headers,
    status: landing.status,
  };
  const owner = ownerOfResolved(store, routed.resolved);
  if (owner !== undefined) {
    return misdirected(owner, forwarded.request.body, handOffOf(routed, landing.changes));
  }
  const answer = await answerResolved(forwarded, store, url, routed);
  // An image whose source another Function holds: the image request goes there, routed as it was,
  // with the routing its source came to here.
  const source = misdirectedTo(answer);
  if (source === undefined) {
    return answer;
  }
  releaseStream(answer.body, 'image source handed on');
  const sourceRouted = answer.headers.get(ROUTED_HEADER) ?? undefined;
  return misdirected(source, null, handOffOf({ ...routed, source: sourceRouted }, landing.changes));
}

/** The answer for a routed request: the image route's, or the resolved route's, with routing's headers. */
async function answerResolved(
  forwarded: RoutedInput,
  store: Store,
  url: URL,
  routed: Routed,
): Promise<Response> {
  const { resolved } = routed;
  const { images } = store.manifest.config;
  if (images !== undefined && routed.image) {
    const image = await serveImageSource(forwarded, store, images, routed);
    return misdirectedTo(image) === undefined ? withRoutingHeaders(image, routed.headers) : image;
  }
  return withRewriteStatus(
    store,
    resolved.route,
    withRoutingHeaders(await serveResolved(forwarded, store, resolved, url), routed.headers),
    routed.status,
  );
}

/**
 * A request another app Function routed and handed over (`handoff.ts`): answered from where its
 * routing left off — the middleware has run, and its decisions are on the request as it left them —
 * and answered as misdirected once more if it reached a Function that does not hold its route
 * either, which only the edge's own mistake can come to and which it does not follow twice.
 */
async function serveHandedOff(
  input: RoutedInput,
  store: Store,
  url: URL,
  value: string,
): Promise<Response> {
  const handOff = decodeHandOff(value);
  if (handOff === undefined) {
    return new Response('the routing handed over does not read', { status: HTTP_BAD_REQUEST });
  }
  const resolved: Resolved = { route: handOff.route, pathname: handOff.pathname, url: handOff.url };
  const owner = ownerOfResolved(store, resolved);
  if (owner !== undefined) {
    return misdirected(owner, input.request.body, value);
  }
  const headers = applyRequestChanges(
    routedHeaders(input.request, url, store.manifest.config.basePath),
    handOff,
  );
  const forwarded: RoutedInput = { ...input, request: new Request(input.request, { headers }) };
  return answerResolved(forwarded, store, url, {
    resolved,
    image: handOff.image === true,
    source: handOff.source,
    headers: new Headers(handOff.headers.map(([name, field]): [string, string] => [name, field])),
    status: handOff.status,
  });
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

async function routeRequest(input: RoutedInput): Promise<Response> {
  const { request } = input;
  if (request.headers.get(MIDDLEWARE_ONLY_HEADER) === '1') {
    return answerMiddlewareOnly(input);
  }
  if (__ARKOR_FUNCTION_KIND__ === 'middleware') {
    return new Response('middleware function', { status: HTTP_NOT_FOUND });
  }
  const store = getStore();
  const elsewhere = misdirectedAhead(store, request);
  if (elsewhere !== undefined) {
    return elsewhere;
  }
  const mode = regenerateMode(request);
  if (mode === 'detached') {
    return await handleDetached(input, store);
  }
  if (mode === 'foreground') {
    const foreground = await handleForeground(input, store);
    if (foreground.response !== undefined) {
      return foreground.response;
    }
    // The regeneration answered nothing — a render dynamic here, a lease held elsewhere and a
    // render of the visitor's own that was dynamic too — and the usual path answers. That path
    // reads the same expired record and regenerated again from it: a second lease, and a second
    // render that could say nothing the first did not.
    const usual = { ...input, regenerated: foreground.regenerated };
    return outcomeOn(await handleFull(usual, store), foreground.outcome);
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
  const context = requestContextFor({
    tables: { app: handled.app, edge: handled.edge },
    runtime: handled.cache,
    request: handled.request,
    startedAt: handled.clock ?? nowMs(),
    waitUntil: handled.waitUntil,
    clock: handled.clock,
  });
  const input: RoutedInput = { ...handled, initURL: initUrlOf(handled.request), run: context.run };
  return context.run(async () => {
    const response = withoutPlacementHeaders(await routeRequest(input));
    return withoutBody(handled.request, withInvalidatedTags(response, context.invalidated));
  });
}
