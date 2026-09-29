import type { RouteEntryDescriptor } from '@stayingupwind/core/cache';
import { NULL_BODY_STATUSES } from '@stayingupwind/core/request';
import { releaseStream } from '@stayingupwind/core/util';

import type { NodeHandler } from './app-module.ts';
import { cacheLifetimeOf, type CapturedRender, renderCaptured } from './cache/capture.ts';
import { invokeNodeHandler } from './node-bridge.ts';
import {
  answerHeaders,
  PAGES_DATA,
  type Representation,
  SEGMENT_PREFIX,
} from './representations.ts';
import {
  baseRequestMeta,
  concatShell,
  NEXT_CACHE_HEADER,
  type NextCacheState,
  resume,
  resumeUrl,
  type RoutedInput,
  stripPlatformHeaders,
} from './serve.ts';

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
export function documentWant(input: RoutedInput): Want {
  return { representation: 'html', url: resumeUrl(input.request) };
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
): Promise<Response | undefined> {
  const headers = stripPlatformHeaders(input.request.headers);
  headers.delete('cookie');
  const { kind, pathname } = target.descriptor;
  if (kind !== 'app-page') {
    return streamForVisitor(input, target, want, headers);
  }
  const url = new URL(pathname, input.request.url);
  const render = await renderCaptured(kind, (meta) => {
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
  return render === undefined ? undefined : answerFromRender(input, target.handler, render, want);
}
