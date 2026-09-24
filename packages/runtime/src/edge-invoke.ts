import type { WebHandler } from './app-module.ts';

/**
 * Invoke an entrypoint built for Next.js's edge runtime.
 *
 * These take a Web `Request` and give back a `Response`, so there is no `node:http` server
 * between the Worker and them: the request goes to the handler as it arrived, under the URL
 * routing resolved, and the response streams back as the handler writes it.
 *
 * What the handler is told the client asked for rides on `requestMeta`, as it does for a Node.js
 * entrypoint; `minimalMode` is not among it, since Next.js's edge adapter sets that itself for
 * anything but a development build.
 */

export interface InvokeEdgeInput {
  readonly handler: WebHandler;
  readonly request: Request;
  /** Path and query the handler is asked for (after rewrites), defaulting to the request's. */
  readonly url?: string | undefined;
  readonly requestMeta: Record<string, unknown>;
  readonly waitUntil: (promise: Promise<unknown>) => void;
}

export function invokeEdgeHandler(input: InvokeEdgeInput): Promise<Response> {
  const target = new URL(input.request.url);
  // Under another URL, the request as it is: workerd takes the method, the headers and the body —
  // a stream by then, the router having teed it — from the request handed as the initializer, and
  // what it attached to the request along with them. A body that did not survive would reach the
  // handler empty, which the fixture's `POST` to a rewritten edge route would answer with.
  const asked =
    input.url === undefined
      ? input.request
      : new Request(new URL(input.url, target), input.request);
  return input.handler(asked, {
    waitUntil: input.waitUntil,
    signal: input.request.signal,
    requestMeta: input.requestMeta,
  });
}
