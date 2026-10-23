import { generationResponseHeaders } from '@stayingupwind/core/cache';
import {
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  CAPTURE_CONTENT_TYPE,
  CAPTURE_HEADER,
  CAPTURE_VERSION,
  type CaptureAnswer,
  pathFromHeaders,
} from '@stayingupwind/core/paas';
import { decodeUtf8, encodeUtf8, releaseStream, toBase64 } from '@stayingupwind/core/util';

import type { NodeHandler } from './app-module.ts';
import { type CapturedRender, MAX_CAPTURED_BYTES } from './cache/capture.ts';
import { nowMs } from './cache/clock.ts';
import { asCapture, asRegeneration } from './cache/context.ts';
import { within } from './cache/lease.ts';
import { TAG_SYNC_DEADLINE_MS } from './cache/regenerate.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import { renderStatically } from './cache/static-render.ts';
import { nodeHandlerOf } from './entries.ts';
import { routingParameters } from './route-parameters.ts';
import { bypassesPrerender, type RoutedInput } from './serve.ts';
import { entrypointKindOf, findShell, type Store, variesOnQuery } from './store.ts';

/**
 * A capture (`CAPTURE_HEADER`): the edge asks for the page a request names, rendered as a
 * regeneration renders it (`cache/static-render.ts`), and is answered with what the render made —
 * the document, the state that resumes it, its RSC payload and segments, and the status, headers
 * and lifetime it is served with (`CaptureAnswer`) — rather than with the page.
 *
 * Nothing of it is kept here, and nothing is asked of the cache's host but what the render reads:
 * no lease is taken, nothing is uploaded or committed, no record is read or remembered, and what
 * the render would write — a value it fetched, a `use cache` value, an invalidation — is written
 * nowhere (`asCapture`). Its reads are a regeneration's (`asRegeneration`): a value a tag made
 * stale is fetched again rather than rendered.
 *
 * The render runs within the request, as every render of it does, so whatever the application
 * reads of the request for itself — its headers, through the request context libraries look for on
 * the global (`request-context.ts`) — is the request's own, while Next.js is handed none of it.
 */

/** What `CAPTURE_HEADER` says to ask for a capture. */
const CAPTURE_ASKED = '1';
const HTTP_OK = 200;
/** The first status past those that say a request succeeded. */
const HTTP_SUCCESS_END = 300;
const HTTP_CONTENT_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE = 422;
const HTTP_INTERNAL_ERROR = 500;
const HTTP_UNAVAILABLE = 503;
const TEXT_TYPE = 'text/plain; charset=utf-8';
/** What a capture answers is for the edge that asked, and for no cache on the way to it. */
const NOT_STORED = 'private, no-store';
/** What a capture's own invocation id starts with, which tells it apart from an attempt's. */
const INVOCATION_PREFIX = 'capture-';

/** The page a capture renders: the route it names, the pathname asked for, and its handler. */
interface Page {
  readonly route: string;
  readonly pathname: string;
  readonly handler: NodeHandler;
}

/** Whether the edge asks for a capture of the page the request names (`CAPTURE_HEADER`). */
export function asksForCapture(request: Request): boolean {
  return request.headers.get(CAPTURE_HEADER) === CAPTURE_ASKED;
}

/**
 * `answer` to a capture, as every answer to one goes: for the edge that asked, and for no cache on
 * the way to it — the `421` that hands a capture of another Function's route on among them
 * (`misdirectedAhead`), which leaves before the capture is read.
 */
export function keptByNobody(answer: Response): Response {
  answer.headers.set('cache-control', NOT_STORED);
  return answer;
}

/** A capture that hands nothing over, and the line of text that says why. */
function refused(reason: string, status = HTTP_UNPROCESSABLE): Response {
  return new Response(reason, {
    status,
    headers: { 'content-type': TEXT_TYPE, 'cache-control': NOT_STORED },
  });
}

/** Whether a status says the render succeeded: 2xx. */
function succeeded(status: number): boolean {
  return status >= HTTP_OK && status < HTTP_SUCCESS_END;
}

/**
 * The page the capture names: a `GET` of its own path, under a route it names up front, as a
 * resume or a regeneration names one (`CACHE_ROUTE_HEADER`) — and so the one a request for another
 * Function's route has been answered for before it came here (`misdirectedAhead`). The route's
 * kind is asked of the table before its module is loaded, so a route of another kind is never
 * evaluated for it. A refusal where it names no page this Function renders on Node.js, or one a
 * regeneration would not make: of a request its prerender is bypassed for — a draft, a condition
 * the build bypasses it on — or a prerender that varies on a query its pathname does not name
 * (`variesOnQuery`), as `generations.ts` judges the regeneration of an entry.
 */
async function pageOf(input: RoutedInput, store: Store): Promise<Page | Response> {
  const { request } = input;
  if (request.method !== 'GET') {
    releaseStream(request.body, 'capture refused: body unused');
    return refused(`a capture is a GET, not a ${request.method}`);
  }
  const route = pathFromHeaders(request.headers, CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER);
  if (route === undefined) {
    return refused(`a capture names its route (${CACHE_ROUTE_HEADER}), and this one names none`);
  }
  const { pathname } = new URL(request.url);
  const shell = store.prerendersByPathname.get(pathname) ?? findShell(store, route, pathname);
  if (bypassesPrerender(store, request, shell) || variesOnQuery(shell, route, pathname)) {
    return refused(`${pathname} is rendered for each request here, as no regeneration renders it`);
  }
  const handler =
    entrypointKindOf(store, route) === 'app-page' ? await nodeHandlerOf(input, route) : undefined;
  if (handler === undefined) {
    return refused(`no App Router page entry renders ${route} here`);
  }
  return { route, pathname, handler };
}

/**
 * The view of the tags brought up to the host's revision, whatever its hold says, as a
 * regeneration's is before it renders (`regenerate`): what the render's reads of the data cache
 * are judged by, which a capture hands on as made now. Whether it was, within the time a
 * regeneration gives it (`TAG_SYNC_DEADLINE_MS`).
 */
async function tagsBroughtUp(input: RoutedInput, runtime: CacheRuntime): Promise<boolean> {
  const synced = runtime.tags.sync(runtime.host, nowMs(), { force: true });
  input.waitUntil(synced);
  try {
    return await within(synced, TAG_SYNC_DEADLINE_MS, {
      code: 'tags_not_synced',
      message: 'the tags were not synced',
    });
  } catch {
    return false;
  }
}

/** What the render's outputs come to together: everything the answer carries of it. */
function capturedBytes(render: CapturedRender): number {
  let bytes = render.html.byteLength + (render.rscData?.byteLength ?? 0);
  if (render.postponed !== undefined) {
    bytes += encodeUtf8(render.postponed).byteLength;
  }
  for (const segment of render.segments.values()) {
    bytes += segment.byteLength;
  }
  return bytes;
}

/**
 * The answer of a render: of its headers, those a generation of the page keeps
 * (`generationResponseHeaders`), so that what the edge is handed is what it would replay of one.
 */
function answerOf(render: CapturedRender): CaptureAnswer {
  return {
    v: CAPTURE_VERSION,
    status: render.status,
    headers: generationResponseHeaders('app-page', render.status, Object.entries(render.headers)),
    html: decodeUtf8(render.html),
    postponed: render.postponed ?? null,
    rsc: render.rscData === undefined ? null : toBase64(render.rscData),
    segments: [...render.segments].map(([key, bytes]): [string, string] => [key, toBase64(bytes)]),
    cacheControl: {
      revalidate: render.cacheControl.revalidate,
      expire: render.cacheControl.expire ?? null,
    },
  };
}

/**
 * Answer a capture: the page rendered statically, and what the render made, as `CaptureAnswer`.
 * Refused with `422` where there is no such render to hand over — Next.js answered the render
 * itself, as it does a page dynamic here, or the render answered other than 2xx — and with `413`
 * where its outputs come to more than the largest body a delivery record carries
 * (`MAX_CAPTURED_BYTES`). Nothing is kept either way. A failure past those — the page's module
 * failing as it is evaluated, the render throwing — is answered `500` as the Function answers one,
 * its cause in the Function's log, and kept by nobody, as every answer to a capture is.
 */
export async function handleCapture(input: RoutedInput, store: Store): Promise<Response> {
  try {
    return await answerCapture(input, store);
  } catch (error) {
    // eslint-disable-next-line no-console -- the Function's own log, as its entry's catch writes it
    console.error('next-runtime: capture failed', error);
    return refused('the capture failed', HTTP_INTERNAL_ERROR);
  }
}

/** A capture's answer, as `handleCapture` says, where nothing it did not expect fails. */
async function answerCapture(input: RoutedInput, store: Store): Promise<Response> {
  const page = await pageOf(input, store);
  if (page instanceof Response) {
    return page;
  }
  const { pathname } = page;
  if (input.cache !== undefined && !(await tagsBroughtUp(input, input.cache))) {
    return refused(
      `the tags were not brought up for ${pathname}: its render would read by a view behind the host's`,
      HTTP_UNAVAILABLE,
    );
  }
  const { captured, answered } = await renderStatically({
    request: input.request,
    handler: page.handler,
    kind: 'app-page',
    pathname,
    parameters: routingParameters(store, page.route, pathname),
    // One of its own, as a regeneration's attempt has: Next.js scopes its response cache by it.
    invocationId: `${INVOCATION_PREFIX}${crypto.randomUUID()}`,
    waitUntil: input.waitUntil,
    run: (work) => input.run(() => asRegeneration(() => asCapture(work))),
  });
  if (captured === undefined) {
    return refused(
      answered === undefined || succeeded(answered)
        ? `${pathname} rendered dynamically: Next.js answered the render rather than handing it over`
        : `the render of ${pathname} answered ${answered}`,
    );
  }
  if (!succeeded(captured.status)) {
    return refused(`the render of ${pathname} answered ${captured.status}`);
  }
  if (capturedBytes(captured) > MAX_CAPTURED_BYTES) {
    return refused(
      `the render of ${pathname} is larger than the ${MAX_CAPTURED_BYTES} bytes a capture carries`,
      HTTP_CONTENT_TOO_LARGE,
    );
  }
  return Response.json(answerOf(captured), {
    status: HTTP_OK,
    headers: { 'content-type': CAPTURE_CONTENT_TYPE, 'cache-control': NOT_STORED },
  });
}
