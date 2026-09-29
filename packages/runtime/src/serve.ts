import type { Prerender } from '@stayingupwind/core/bundle';
import { anyConditionHolds, NULL_BODY_STATUSES } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import type { NodeHandler } from './app-module.ts';
import type { CacheRuntime } from './cache/runtime.ts';
import { isDraftRequest } from './draft.ts';
import { invokeEdgeHandler } from './edge-invoke.ts';
import type { Entry, EntryTables } from './entries.ts';
import { NEVER_STORED, render404 } from './error-pages.ts';
import { stripPlatformHeaders } from './incoming.ts';
import { type FailureAnswer, invokeNodeHandler, type Run } from './node-bridge.ts';
import type { Store } from './store.ts';

/**
 * What every way of answering a request is built from: the request as Next.js may see it, a
 * route rendered whole through whichever runtime it was built for, the headers a prerender is
 * served with, a resume of a shell, and a shell joined to the resume that completes it.
 */

export const HTML_CONTENT_TYPE = 'text/html; charset=utf-8';
export const RSC_CONTENT_TYPE = 'text/x-component';
export const PRERENDER_HEADER = 'x-nextjs-prerender';
export const POSTPONED_HEADER = 'x-nextjs-postponed';
export const HTTP_OK = 200;
export const HTTP_NOT_FOUND = 404;
const HTTP_BAD_GATEWAY = 502;

export interface HandleInput extends EntryTables {
  readonly request: Request;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** The deployment's runtime cache; absent when it was given none. */
  readonly cache?: CacheRuntime | undefined;
  /** The clock a test configuration handed the request; the wall clock otherwise. */
  readonly clock?: number | undefined;
}

/**
 * A request as it travels through the runtime: the URL the client asked for is read once, off the
 * request as the edge sent it, and stays with it through rewrites and the stripping of the
 * platform's headers.
 */
export interface RoutedInput extends HandleInput {
  /** What Next.js is told the client asked for: `requestMeta.initURL`. */
  readonly initURL: string;
  /** The context every render of the request runs in: its clock and its platform hooks. */
  readonly run: Run;
  /**
   * Whether the request has had its regeneration already: one in the foreground whose render
   * answered nothing, which leaves the request to the usual path. Nothing on that path begins
   * another (`serveFromGeneration`).
   */
  readonly regenerated?: boolean | undefined;
}

export { initUrlOf, resumeUrl, stripPlatformHeaders } from './incoming.ts';

export function baseRequestMeta(input: RoutedInput): Record<string, unknown> {
  return {
    minimalMode: true,
    relativeProjectDir: '.',
    initURL: input.initURL,
    // What the Pages Router asks the platform for when a render ends in `notFound: true`, or
    // when a `fallback: false` route is asked for a member the build did not make.
    render404,
  };
}

/** A valid draft or a matching build condition must be rendered for the request. */
export function bypassesPrerender(
  store: Store,
  request: Request,
  prerender?: Prerender,
  url = request.url,
): boolean {
  return (
    isDraftRequest(store, request) ||
    anyConditionHolds(prerender?.bypassFor ?? [], new URL(url, request.url), request.headers)
  );
}

/**
 * Render a route whole, through whichever runtime it was built for; a Node.js render that fails
 * before it sends anything is answered by `onFailure` when the route has an answer of its own.
 */
export function invokeEntry(
  input: RoutedInput,
  entry: Entry,
  url: string | undefined,
  onFailure?: FailureAnswer,
): Promise<Response> {
  const invocation = {
    request: input.request,
    url,
    requestMeta: baseRequestMeta(input),
    waitUntil: input.waitUntil,
  };
  return entry.kind === 'edge'
    ? input.run(() => invokeEdgeHandler({ ...invocation, handler: entry.handler }))
    : invokeNodeHandler({ ...invocation, handler: entry.handler, run: input.run, onFailure });
}

/** A prerender's body as the build wrote it, under the headers it recorded and the type given. */
export function staticResponse(
  store: Store,
  prerender: Prerender,
  contentType: string,
  status: number,
): Response {
  // A build may write a route handler's `204` too, with the empty body it answered with.
  const body =
    prerender.body === undefined || NULL_BODY_STATUSES.has(status)
      ? null
      : store.readBlob(prerender.body.sha256);
  return new Response(body, {
    status,
    headers: prerenderHeaders(prerender, contentType),
  });
}

/**
 * Where an answer complete from the cache came from, as Next.js says it (`x-nextjs-cache`): `HIT`
 * from the cache, `STALE` from it while it is regenerated, `MISS` rendered for the request. Its own
 * server sets it on a page answered whole, and not on one a resume completes; in minimal mode it
 * leaves the header to the platform (`build/templates/app-page.ts`).
 */
export const NEXT_CACHE_HEADER = 'x-nextjs-cache';
export type NextCacheState = 'HIT' | 'STALE' | 'MISS';

export function withCacheState(response: Response, state: NextCacheState): Response {
  response.headers.set(NEXT_CACHE_HEADER, state);
  return response;
}

export async function externalRewrite(request: Request, target: URL): Promise<Response> {
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

/** A plain 404, for a request that names nothing the deployment has. */
export function notFoundResponse(): Response {
  return new Response('Not Found', { status: HTTP_NOT_FOUND });
}

/**
 * The 404 Next.js answers a miss with when no page is rendered for it — a file under
 * `_next/static`, or a read by an image, a script or a font — with the headers its router sends
 * that miss (`server/lib/router-server.ts`). Without a `Cache-Control` of its own the edge would
 * give it `private, no-store` instead of Next.js's.
 */
export function plainNotFoundResponse(): Response {
  return new Response('Not Found', {
    status: HTTP_NOT_FOUND,
    headers: { 'cache-control': NEVER_STORED, 'content-type': 'text/plain; charset=utf-8' },
  });
}

export function prerenderHeaders(prerender: Prerender, contentType: string): Headers {
  const headers = new Headers();
  const initial = Object.entries(prerender.initialHeaders ?? {});
  for (const [name, value] of initial) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }
  headers.set('content-type', contentType);
  return headers;
}

/** The headers a document is served with: what the render recorded, minus the resume marker. */
export function documentHeaders(recorded: Readonly<Record<string, string>>): Headers {
  const headers = new Headers(recorded);
  headers.delete(POSTPONED_HEADER);
  headers.set('content-type', HTML_CONTENT_TYPE);
  headers.set('cache-control', 'private, no-store');
  return headers;
}

/**
 * Send the available shell without waiting for the continuation's headers. Its status is already
 * committed when the continuation arrives: a failed resume must fail the stream, never append an
 * error page to a successful document. A cancelled reader also releases a response arriving later.
 */
export function concatShell(
  shell: Uint8Array,
  rest: Promise<Response>,
): ReadableStream<Uint8Array> {
  const state: {
    reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    cancelled: boolean;
    reason: unknown;
  } = { reader: undefined, cancelled: false, reason: undefined };
  // Observe a rejection even when nobody has pulled the continuation yet.
  async function prepare(): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
      const response = await rest;
      if (state.cancelled || !response.ok) {
        const { body } = response;
        if (body !== null) {
          void body.cancel(state.reason).catch(() => {
            // A body already closed or failed has nothing left to release.
          });
        }
        if (!state.cancelled) {
          throw new Error(`next-runtime: resume answered ${response.status}`);
        }
      } else {
        state.reader = response.body?.getReader();
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }
  const ready = prepare();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(shell);
    },
    async pull(controller) {
      const outcome = await ready;
      if (state.cancelled) {
        return;
      }
      if (!outcome.ok) {
        controller.error(outcome.error);
        return;
      }
      if (state.reader === undefined) {
        controller.close();
        return;
      }
      const { done, value } = await state.reader.read();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- cancel may run while read is pending
      if (state.cancelled) {
        return;
      }
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason: unknown) {
      state.cancelled = true;
      state.reason = reason;
      return state.reader?.cancel(reason);
    },
  });
}

export interface ResumeInput {
  readonly input: RoutedInput;
  readonly handler: NodeHandler;
  /** The state to resume from; absent for a page complete at render time. */
  readonly postponed: string | undefined;
  readonly url?: string | undefined;
  /** The request Next.js sees; the routed request, stripped of the platform's headers, by default. */
  readonly request?: Request | undefined;
}

/** Render what the prerender left out; the response body is the suffix only. */
export function resume(r: ResumeInput): Promise<Response> {
  const request =
    r.request ??
    new Request(r.input.request, { headers: stripPlatformHeaders(r.input.request.headers) });
  return invokeNodeHandler({
    handler: r.handler,
    request,
    url: r.url,
    requestMeta: {
      ...baseRequestMeta(r.input),
      ...(r.postponed !== undefined && { postponed: r.postponed }),
    },
    waitUntil: r.input.waitUntil,
    run: r.input.run,
  });
}

/** A `HEAD` is answered with the response's status and headers alone, whatever produced it. */
export function withoutBody(request: Request, response: Response): Response {
  if (request.method !== 'HEAD' || response.body === null) {
    return response;
  }
  // Released, not awaited: a stalled cancellation must not hold back completed headers.
  releaseStream(response.body, 'HEAD: body not sent');
  return new Response(null, response);
}
