import type { IncomingMessage, ServerResponse } from 'node:http';

import { isRegeneration, type RequestContext, requestContext } from './cache/context.ts';
import { invokeEdgeHandler } from './edge-invoke.ts';
import { type Entry, entryFor, nodeHandlerOf } from './entries.ts';
import { initUrlOf, stripPlatformHeaders } from './incoming.ts';
import type { FailureAnswer } from './node-bridge.ts';
import { entrypointKindOf, getStore, type Store } from './store.ts';

/**
 * The pages the build made for a miss and for a failure, and the hooks Next.js asks the platform
 * to answer with them through.
 *
 * Next.js writes the not-found and the error page as the `/404` and `/500` outputs under the
 * `basePath`: a file when the page needs nothing from the request, a prerender when it has
 * `getStaticProps`, and otherwise a page like any other — which is what a custom `App` with
 * `getInitialProps` makes of both. The Pages Router reaches for the not-found twice — a render
 * that ended in `notFound: true`, and a `fallback: false` route asked for a member the build did
 * not make — and in both it calls `requestMeta.render404`, which is the platform's to provide (the
 * Adapter API's "Invoking Entrypoints"). Without one, Next.js ends the response with a line of
 * plain text. A render that fails it does not answer at all: it throws, for its server to answer
 * with the error page (`renderErrorToResponse`, `server/base-server.ts`) — which here is the
 * Function's to do.
 */

/** Next.js names these outputs `/404` and `/500`, under the `basePath` as it names every output. */
const NOT_FOUND_PAGE = '/404';
/** The App Router's not-found, which every build with an App Router has: its own or Next.js's. */
const APP_NOT_FOUND = '/_not-found';
const SERVER_ERROR_PAGE = '/500';
/** The page Next.js renders any status with when the application has none of its own for it. */
const ERROR_PAGE = '/_error';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const CONTENT_TYPE = 'content-type';
const HTTP_INTERNAL_ERROR = 500;
/** What Next.js's own server ends with when an application ships no not-found document. */
const LAST_WORDS = 'This page could not be found';
/** What Next.js sends its error page with: the page is about this request alone. */
export const NEVER_STORED = 'private, no-cache, no-store, max-age=0, must-revalidate';

/** The page the build wrote for `page`, as bytes: the file, else the page it prerendered. */
function documentOf(
  store: Store,
  page: string,
): { bytes: Uint8Array<ArrayBuffer>; contentType: string } | undefined {
  const pathname = `${store.manifest.config.basePath}${page}`;
  const file = store.staticFiles.get(pathname);
  if (file !== undefined) {
    return { bytes: store.readBlob(file.blob.sha256), contentType: file.blob.contentType };
  }
  const prerender = store.prerendersByPathname.get(pathname);
  if (prerender?.body !== undefined) {
    return {
      bytes: store.readBlob(prerender.body.sha256),
      contentType: prerender.body.contentType,
    };
  }
  return undefined;
}

/**
 * `page` rendered by its own entrypoint into `response`, for the request that was being answered,
 * as Next.js's own server renders it; whether the deployment has that entrypoint to render with.
 * The render is not handed `render404`, so a not-found page that asks for one ends in plain text
 * rather than in itself.
 */
async function renderedPage(
  page: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const context = requestContext();
  if (context === undefined) {
    return false;
  }
  const id = `${getStore().manifest.config.basePath}${page}`;
  const handler = await nodeHandlerOf(context.tables, id);
  if (handler === undefined) {
    return false;
  }
  await handler(request, response, {
    waitUntil: context.waitUntil,
    requestMeta: {
      minimalMode: true,
      relativeProjectDir: '.',
      initURL: initUrlFor(context, request),
    },
  });
  return true;
}

/** What an answer from the edge runtime keeps out of the response it is copied into. */
const NOT_COPIED: ReadonlySet<string> = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'set-cookie',
  'transfer-encoding',
]);

/**
 * The URL a render for the request being answered is told the client asked for: the visitor's, and
 * in a regeneration — which renders for no visitor, under the request's own context — the URL of the
 * request the render was given (`staticRequest`, `cache/regenerate.ts`).
 */
function initUrlFor(context: RequestContext, active: IncomingMessage): string {
  return isRegeneration()
    ? new URL(active.url ?? '/', context.request.url).href
    : initUrlOf(context.request);
}

/**
 * The request the edge runtime renders the not-found for: the one being answered, as the render was
 * given it — in a regeneration, a request with nothing of the visitor's (`staticRequest`), which the
 * request's own context would put back — without the platform's headers.
 */
function edgeRequestOf(context: RequestContext, active: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(active.headers)) {
    const values = typeof value === 'string' ? [value] : (value ?? []);
    for (const one of values) {
      headers.append(name, one);
    }
  }
  return new Request(new URL(active.url ?? '/', context.request.url), {
    method: active.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: stripPlatformHeaders(headers),
  });
}

/**
 * An answer of the edge runtime, copied into the Node.js response a render was already using: its
 * headers, set over what the response had as a Node.js render's would be, and its body whole —
 * a not-found page is small. A rendered page keeps the 404 being answered; a redirect or a failure
 * keeps the status that says so, as the not-found of a document that matched no route does.
 */
async function copyInto(answer: Response, response: ServerResponse): Promise<void> {
  if (answer.status !== HTTP_OK) {
    response.statusCode = answer.status;
  }
  for (const [name, value] of answer.headers) {
    if (!NOT_COPIED.has(name)) {
      response.setHeader(name, value);
    }
  }
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) {
    response.setHeader('set-cookie', cookies);
  }
  response.end(new Uint8Array(await answer.arrayBuffer()));
}

/**
 * The App Router's not-found, where the application has an App Router: Next.js's own server answers
 * a 404 with it before it looks for the Pages Router's `/404` (`renderErrorToResponseImpl`,
 * `server/base-server.ts`), so where the two routers share an application, a Pages Router miss is
 * answered with the App Router's page — which is what Next.js 16.3's pages handler asks of the
 * platform's `render404`. Rendered whole for the request, through whichever runtime it was built
 * for, as Next.js renders it there: under `cacheComponents` with an empty postponed state, which is
 * what the pages handler readies it with, since an invocation of its own has no shell to resume.
 * The build's own document of it is not read: where the page was complete, Next.js publishes it as
 * `/404`, which in an application of both routers is the Pages Router's name. Whether it answered.
 */
async function renderedAppNotFound(
  store: Store,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  const route = `${store.manifest.config.basePath}${APP_NOT_FOUND}`;
  const context = requestContext();
  if (context === undefined || entrypointKindOf(store, route) !== 'app-page') {
    return false;
  }
  const entry = await entryFor(context.tables, route);
  if (entry === undefined) {
    return false;
  }
  const requestMeta = {
    minimalMode: true,
    relativeProjectDir: '.',
    initURL: initUrlFor(context, request),
    ...(store.manifest.config.cacheComponents === true && { postponed: '' }),
  };
  if (entry.kind === 'node') {
    await entry.handler(request, response, { waitUntil: context.waitUntil, requestMeta });
    return true;
  }
  const answer = await invokeEdgeHandler({
    handler: entry.handler,
    request: edgeRequestOf(context, request),
    requestMeta,
    waitUntil: context.waitUntil,
  });
  await copyInto(answer, response);
  return true;
}

/**
 * `requestMeta.render404`, writing into the response the render was already using: the App Router's
 * not-found where there is one (`renderedAppNotFound`), else the Pages Router's. The status is
 * Next.js's own — it sets 404 before it asks — and is set here for a caller that did not.
 *
 * One function for every request, which is why it reads the store rather than closing over one:
 * the request metadata is built per request, and a closure per request would be an allocation on
 * the path of every render.
 */
export async function render404(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (response.writableEnded) {
    return;
  }
  if (response.statusCode < HTTP_NOT_FOUND) {
    response.statusCode = HTTP_NOT_FOUND;
  }
  const store = getStore();
  if (await renderedAppNotFound(store, request, response)) {
    return;
  }
  const document = documentOf(store, NOT_FOUND_PAGE);
  if (document !== undefined) {
    response.setHeader(CONTENT_TYPE, document.contentType);
    response.end(document.bytes);
    return;
  }
  // The not-found page, else the page every status falls back to, as Next.js's own server picks
  // (`renderErrorToResponseImpl`, `server/base-server.ts`).
  for (const page of [NOT_FOUND_PAGE, ERROR_PAGE]) {
    if (await renderedPage(page, request, response)) {
      return;
    }
  }
  response.end(LAST_WORDS);
}

/**
 * A Pages Router render that failed before it sent anything, answered as Next.js answers it: with
 * the error page under a 500. What the page itself cannot answer with — a deployment that has
 * neither the page nor its entrypoint — is left to the caller.
 */
async function renderServerError(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  response.statusCode = HTTP_INTERNAL_ERROR;
  response.setHeader('cache-control', NEVER_STORED);
  const document = documentOf(getStore(), SERVER_ERROR_PAGE);
  if (document !== undefined) {
    response.setHeader(CONTENT_TYPE, document.contentType);
    response.end(document.bytes);
    return;
  }
  await renderedPage(SERVER_ERROR_PAGE, request, response);
}

/**
 * How a render of `route` that fails is answered: a page of the Pages Router with the error page,
 * which Next.js leaves to its server, whatever the request's method, and anything else in plain
 * text. An App Router page renders its own failures, with its error boundaries, inside the
 * handler, and a route on the edge runtime answers its own: only the Node.js bridge is handed an
 * answer to use.
 */
export function failureAnswer(
  store: Store,
  entry: Entry,
  route: string,
): FailureAnswer | undefined {
  return entry.kind === 'node' && entrypointKindOf(store, route) === 'pages'
    ? renderServerError
    : undefined;
}
