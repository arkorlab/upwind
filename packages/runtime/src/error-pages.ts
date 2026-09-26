import type { IncomingMessage, ServerResponse } from 'node:http';

import { requestContext } from './cache/context.ts';
import { type Entry, nodeHandlerOf } from './entries.ts';
import { initUrlOf } from './incoming.ts';
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
const SERVER_ERROR_PAGE = '/500';
/** The page Next.js renders any status with when the application has none of its own for it. */
const ERROR_PAGE = '/_error';
const HTTP_NOT_FOUND = 404;
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
      initURL: initUrlOf(context.request),
    },
  });
  return true;
}

/**
 * `requestMeta.render404`, writing into the response the render was already using. The status is
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
  const document = documentOf(getStore(), NOT_FOUND_PAGE);
  if (document !== undefined) {
    response.setHeader('content-type', document.contentType);
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
    response.setHeader('content-type', document.contentType);
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
