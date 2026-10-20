import type { RouteEntryKind } from '@stayingupwind/core/cache';

import type { NodeHandler } from '../app-module.ts';
import { render404 } from '../error-pages.ts';
import { invokeNodeHandler, type Run } from '../node-bridge.ts';
import { type CapturedRender, renderCaptured } from './capture.ts';

/**
 * A static render of an entry: the render a regeneration publishes (`regenerate.ts`), and the one a
 * capture hands to the edge whole (`capture-invoke.ts`). Next.js is asked for the entry's pathname
 * in minimal mode, with a request of the render's own — no cookies, no body, no query, and of the
 * headers only the host and those Next.js lets an ISR render see — and what the render produced is
 * kept off what Next.js hands the platform (`renderCaptured`) rather than answered.
 */

/** Headers every static render is given, as a browser navigation carries them. */
const STATIC_REQUEST_HEADERS: Readonly<Record<string, string>> = {
  accept: 'text/html,application/xhtml+xml',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
};
/** Next.js's own scoping of its minimal-mode response cache to one invocation. */
const INVOCATION_HEADER = 'x-invocation-id';
/**
 * How Next.js is told that a regeneration was asked for rather than come due: the header it
 * compares against the build's own token (`checkIsOnDemandRevalidate`, `api-utils/index.ts`). It
 * is what `getStaticProps` reads as `revalidateReason: 'on-demand'`, where a render without it
 * reads `'stale'` however the regeneration came about.
 */
const ON_DEMAND_HEADER = 'x-prerender-revalidate';

/** What a static render renders, of which request, and in what context. */
export interface StaticRenderInput {
  /** The request that asked, for its host and the headers the render may see. */
  readonly request: Request;
  readonly handler: NodeHandler;
  readonly kind: RouteEntryKind;
  /** The entry's pathname: what the render is asked for. */
  readonly pathname: string;
  /**
   * The parameters the render is handed in its query, as routing hands them to a render of a
   * visitor's request, where Next.js would read them otherwise off the pathname
   * (`routingParameters`); none by default.
   */
  readonly parameters?: Readonly<Record<string, string>> | undefined;
  /** The request headers Next.js lets the render see (`allowHeader`); none by default. */
  readonly allowHeader?: readonly string[] | undefined;
  /** The build's token, for a render somebody asked for (`ON_DEMAND_HEADER`); none by default. */
  readonly onDemandToken?: string | undefined;
  /** The render's own id, which Next.js scopes its response cache to (`INVOCATION_HEADER`). */
  readonly invocationId: string;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  /** The context the render runs in. */
  readonly run: Run;
}

/** What a static render came to. */
export interface StaticRendering {
  /** The request the render was given. */
  readonly request: Request;
  /** What it produced, as a cache keeps it; `undefined` where Next.js answered the render instead. */
  readonly captured: CapturedRender | undefined;
  /** The status the render's response answered with. */
  readonly answered: number | undefined;
}

/**
 * The URL a static render is handed: the entry's pathname, with the parameters routing would name
 * in its query where there are any (`StaticRenderInput.parameters`).
 */
function staticUrl(input: StaticRenderInput): string {
  const { pathname, parameters } = input;
  return parameters === undefined
    ? pathname
    : `${pathname}?${new URLSearchParams(parameters).toString()}`;
}

/** The request a static render is given: the pathname, and nothing of the visitor's. */
function staticRequest(input: StaticRenderInput): Request {
  const url = new URL(input.pathname, input.request.url);
  const headers = new Headers(STATIC_REQUEST_HEADERS);
  const host = input.request.headers.get('host');
  if (host !== null) {
    headers.set('host', host);
  }
  if (input.allowHeader !== undefined) {
    for (const name of input.allowHeader) {
      const value = input.request.headers.get(name);
      if (value !== null) {
        headers.set(name, value);
      }
    }
  }
  headers.set(INVOCATION_HEADER, input.invocationId);
  if (input.onDemandToken !== undefined) {
    headers.set(ON_DEMAND_HEADER, input.onDemandToken);
  }
  return new Request(url, { headers });
}

/**
 * Render the entry statically and keep what a cache would; nothing is answered. A Pages Router
 * render that ends in `notFound: true` asks for `render404` here as on a visitor's request, and
 * what it writes is what is kept: without it, the line of text Next.js ends with was kept, and
 * served, in place of the application's not-found page.
 */
export async function renderStatically(input: StaticRenderInput): Promise<StaticRendering> {
  const request = staticRequest(input);
  let answered: number | undefined;
  const captured = await renderCaptured(input.kind, async (meta) => {
    const response = await invokeNodeHandler({
      handler: input.handler,
      request,
      url: staticUrl(input),
      requestMeta: {
        minimalMode: true,
        relativeProjectDir: '.',
        initURL: request.url,
        render404,
        ...meta.requestMeta,
      },
      waitUntil: input.waitUntil,
      run: input.run,
      expectNoResponse: meta.expectNoResponse,
    });
    answered = response.status;
    return response;
  });
  return { request, captured, answered };
}
