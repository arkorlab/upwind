import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { CACHE_OUTCOME_HEADER } from '@stayingupwind/core/paas';
import { NULL_BODY_STATUSES, ROUTER_PROTOCOL_HEADERS } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import type { NodeHandler } from './app-module.ts';
import {
  cacheLifetimeOf,
  type CapturedRender,
  renderAppPage,
  renderCaptured,
} from './cache/capture.ts';
import { servable } from './cache/servable.ts';
import { foundDynamic } from './dynamic-misses.ts';
import type { GenerationSource } from './generation-source.ts';
import { invokeNodeHandler } from './node-bridge.ts';
import {
  answerHeaders,
  PAGES_DATA,
  type Representation,
  SEGMENT_PREFIX,
} from './representations.ts';
import { resumeUrlOf, routingParameters } from './route-parameters.ts';
import {
  baseRequestMeta,
  concatShell,
  NEXT_CACHE_HEADER,
  type NextCacheState,
  resume,
  type RoutedInput,
  stripPlatformHeaders,
} from './serve.ts';
import { findShell, generationPathname, isClassShell, type Store } from './store.ts';

/**
 * The visitor's answer from an entry's bytes — a render just made, or what a generation holds —
 * and a render made for the visitor alone, kept by no one: what `generations.ts` answers with,
 * whichever of those it has.
 */

/** The entry a request names, and the handler that renders it. */
export interface Target {
  readonly descriptor: RouteEntryDescriptor;
  readonly handler: NodeHandler;
}

/** What a request wants of an entry: which output, for which URL. */
export interface Want {
  readonly representation: Representation;
  /** The path and query the resume renders for. */
  readonly url: string;
  /** A static RSC prefetch may use the captured payload without rendering its dynamic holes. */
  readonly prefetch?: boolean | undefined;
}

export interface Answer extends Want {
  readonly body: Uint8Array;
  readonly postponed: string | undefined;
  /** Whether the page leaves parts of itself to a resume: it has a postponed state. */
  readonly partial: boolean;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Where the answer came from, said only of one complete without a resume (`NEXT_CACHE_HEADER`). */
  readonly cache: NextCacheState;
}

/** The visitor's answer: a document — a shell, then their own resume of it — or an output whole. */
export function answerWith(input: RoutedInput, handler: NodeHandler, answer: Answer): Response {
  const headers = answerHeaders(answer.representation, answer.headers, answer.partial);
  if (answer.postponed === undefined) {
    headers.set(NEXT_CACHE_HEADER, answer.cache);
  }
  const { status } = answer;
  // A `204` a handler answered is kept with the empty body it was captured as, and a `Response`
  // refuses a body under such a status even when it is empty.
  if (input.request.method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    return new Response(null, { status, headers });
  }
  if (answer.postponed === undefined) {
    return new Response(answer.body as BodyInit, { status, headers });
  }
  const rest = resume({ input, handler, postponed: answer.postponed, url: answer.url });
  return new Response(concatShell(answer.body, rest), { status, headers });
}

/** `response`, saying what came of the regeneration behind it (`CACHE_OUTCOME_HEADER`). */
export function withOutcome(response: Response, outcome: string): Response {
  const headers = new Headers(response.headers);
  headers.set(CACHE_OUTCOME_HEADER, outcome);
  return new Response(response.body, { status: response.status, headers });
}

/** The output of a render a want names, as the render captured it. */
function renderedOutput(
  render: CapturedRender,
  representation: Representation,
): Uint8Array | undefined {
  if (representation === PAGES_DATA) {
    return render.data;
  }
  if (representation === 'rsc') {
    return render.rscData;
  }
  return representation.startsWith(SEGMENT_PREFIX)
    ? render.segments.get(representation.slice(SEGMENT_PREFIX.length))
    : render.html;
}

/** The visitor's answer from a render; `undefined` when the render has no such output. */
export async function answerFromRender(
  input: RoutedInput,
  handler: NodeHandler,
  render: CapturedRender,
  want: Want,
): Promise<Response | undefined> {
  const resumed = resumeRsc(input, handler, want, render.postponed);
  if (resumed !== undefined) {
    return resumed;
  }
  const body = renderedOutput(render, want.representation);
  if (body === undefined) {
    return undefined;
  }
  return answerWith(input, handler, {
    ...want,
    body,
    postponed: want.representation === 'html' ? render.postponed : undefined,
    partial: render.postponed !== undefined,
    status: render.status,
    headers: render.headers,
    cache: 'MISS',
  });
}

/**
 * The visitor's answer from the render this isolate is publishing of the entry — the page every
 * request after its publish is answered with, already made — and told so; `undefined` where there
 * is none, where it is not one a visitor may be answered with, or where it has no output the
 * request wants.
 */
export async function answerFromPublishing(
  input: RoutedInput,
  handler: NodeHandler,
  render: CapturedRender | undefined,
  want: Want,
): Promise<Response | undefined> {
  if (render === undefined || !servable(render.status, render.headers)) {
    return undefined;
  }
  const answered = await answerFromRender(input, handler, render, want);
  return answered === undefined ? undefined : withOutcome(answered, 'publishing');
}

/**
 * A captured RSC payload contains only the static prerender. An actual navigation needs Next.js
 * to render the whole Flight response using this generation's resume cache and this visitor's
 * request. That response is complete in its own right: concatenating the captured payload would
 * duplicate its Flight records. Prefetches and individual segments keep their static artifacts.
 */
export function resumeRsc(
  input: RoutedInput,
  handler: NodeHandler,
  want: Want,
  postponed: string | Uint8Array | undefined,
): Promise<Response> | undefined {
  if (postponed === undefined || want.prefetch === true || want.representation !== 'rsc') {
    return undefined;
  }
  return resume({
    input,
    handler,
    postponed: typeof postponed === 'string' ? postponed : new TextDecoder().decode(postponed),
    url: want.url,
  });
}

/** What the edge asks for on a document's behalf: the document itself. */
export function documentWant(input: RoutedInput, store: Store, route: string): Want {
  return { representation: 'html', url: resumeUrlOf(store, route, input.request) };
}

/**
 * Render a visitor's App Router document once. A newly captured shell needs its resume; an
 * uncaptured response already answers this visitor, with their query and cookies intact.
 */
export async function renderDocumentForVisitor(
  input: RoutedInput,
  handler: NodeHandler,
  url: string,
): Promise<Response> {
  const render = await renderAppPage((meta) => {
    return invokeNodeHandler({
      handler,
      request: input.request,
      url,
      requestMeta: { ...baseRequestMeta(input), ...meta.requestMeta },
      waitUntil: input.waitUntil,
      run: input.run,
      expectNoResponse: meta.expectNoResponse,
    });
  });
  if (render instanceof Response) {
    return render;
  }
  return answerWith(input, handler, {
    representation: 'html',
    url,
    body: render.html,
    postponed: render.postponed,
    partial: render.postponed !== undefined,
    status: render.status,
    headers: render.headers,
    cache: 'MISS',
  });
}

/**
 * A render off its response for this visitor alone, streamed as it is rendered: a Pages Router
 * page's, at its data route when its data is what is wanted, or a route handler's. `undefined`
 * when it turns out to be dynamic here, as a capture would have said.
 */
async function streamForVisitor(
  input: RoutedInput,
  target: Target,
  want: Want,
  headers: Headers,
): Promise<Response | undefined> {
  // One output is all such a render is, and a payload or a segment is none it has, as a capture
  // of it found: a page's is the only kind that has those.
  if (want.representation === 'rsc' || want.representation.startsWith(SEGMENT_PREFIX)) {
    return undefined;
  }
  const path = want.representation === PAGES_DATA ? want.url : target.descriptor.pathname;
  const response = await invokeNodeHandler({
    handler: target.handler,
    request: new Request(new URL(path, input.request.url), { headers }),
    url: path,
    requestMeta: baseRequestMeta(input),
    waitUntil: input.waitUntil,
    run: input.run,
  });
  if (cacheLifetimeOf(response) === undefined) {
    releaseStream(response.body, 'dynamic here: the usual path answers');
    return undefined;
  }
  const init = {
    status: response.status,
    headers: answerHeaders(want.representation, Object.fromEntries(response.headers), false),
  };
  // The render is a `GET`'s, as a generation's is: a `HEAD` is told what that says of the entity,
  // as `answerWith` tells it, and is sent none of it.
  if (input.request.method === 'HEAD') {
    releaseStream(response.body, 'a HEAD is answered without the body');
    return new Response(null, init);
  }
  return new Response(response.body, init);
}

/**
 * A static render for this visitor alone, when the entry cannot be regenerated right now (a
 * lease held elsewhere, a host out of reach, a render too large for any generation): the
 * entry as a regeneration would have made it, kept by no one. `undefined` when it turns out to be
 * dynamic here.
 *
 * Only a page's render is captured for it, since the answer is assembled from it: a shell, then
 * the visitor's own resume. A Pages Router page's render and a route handler's are the answer as
 * they stand, and are streamed rather than read whole first — read, a body too large to publish
 * would be held whole again, on every request, for as long as the entry could not be published.
 */
export async function renderForVisitor(
  input: RoutedInput,
  target: Target,
  want: Want,
  captureFailure?: 'fallback',
): Promise<Response | undefined> {
  const headers = stripPlatformHeaders(input.request.headers);
  headers.delete('cookie');
  const { kind, pathname } = target.descriptor;
  if (kind !== 'app-page') {
    return streamForVisitor(input, target, want, headers);
  }
  // Rendered as a regeneration renders the page — the document, whatever the visitor asked for of
  // it. Given a prefetch's or a navigation's own headers, Next.js answers the segment or the payload
  // itself and captures nothing (`builtSegment`), and the visitor was left the build's answer, an
  // older generation's or none; captured whole, the render holds the payload and every segment, and
  // the visitor is sent the one it asked for (`answerFromRender`).
  for (const name of ROUTER_PROTOCOL_HEADERS) {
    headers.delete(name);
  }
  const url = new URL(pathname, input.request.url);
  let render: CapturedRender | undefined;
  try {
    render = await renderCaptured(kind, (meta) => {
      return invokeNodeHandler({
        handler: target.handler,
        request: new Request(url, { headers }),
        url: pathname,
        requestMeta: { ...baseRequestMeta(input), ...meta.requestMeta },
        waitUntil: input.waitUntil,
        run: input.run,
        expectNoResponse: meta.expectNoResponse,
      });
    });
  } catch (error) {
    if (captureFailure !== 'fallback') throw error;
    input.cache?.log('completed RSC visitor capture failed');
    return undefined;
  }
  // Only the static capture may fall back: a visitor's failing resume keeps its own error.
  return render === undefined ? undefined : answerFromRender(input, target.handler, render, want);
}

/**
 * An ordinary cold RSC navigation still needs the static stage of its completed class when the
 * authority read is unavailable. Capture it for this visitor alone, as when a lease is held
 * elsewhere: a generic build resume can leave the newly resolved parameters dynamic. Only the selected
 * class is eligible; request-specific bypass and query guards have already run in the caller.
 */
export function renderCompletedRscForVisitor(
  job: { readonly input: RoutedInput; readonly store: Store; readonly target: Target },
  source: GenerationSource,
  once: boolean,
): Promise<Response | undefined> {
  const { input, store, target } = job;
  const { descriptor } = target;
  if (
    !once ||
    source.onMiss !== 'render' ||
    input.request.method !== 'GET' ||
    descriptor.kind !== 'app-page' ||
    source.representation !== 'rsc' ||
    source.prefetch === true ||
    input.request.headers.has(store.manifest.routing.rsc.prefetchHeader) ||
    input.cache === undefined ||
    foundDynamic(input.cache, descriptor)
  ) {
    return Promise.resolve(undefined);
  }
  const pathname = new URL(source.url, input.request.url).pathname;
  const shell = findShell(store, descriptor.route, pathname);
  if (
    shell === undefined ||
    shell.body !== undefined ||
    shell.ensureStatic === 'navigation' ||
    descriptor.pathname === shell.pathname ||
    !isClassShell(descriptor.pathname, descriptor.route) ||
    generationPathname(shell, pathname) !== descriptor.pathname ||
    // This helper renders the class pathname, without regeneration's separated catch-all query.
    routingParameters(store, descriptor.route, descriptor.pathname) !== undefined
  ) {
    return Promise.resolve(undefined);
  }
  return renderForVisitor(input, target, source, 'fallback');
}
