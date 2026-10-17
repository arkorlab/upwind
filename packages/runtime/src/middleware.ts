import { middlewareHandler } from './entries.ts';
import { routedHeaders } from './routed-headers.ts';
import type { HandleInput, RoutedInput } from './serve.ts';
import { deploymentConfig } from './store.ts';

const HTTP_OK = 200;

export const MIDDLEWARE_ENTRY_ID = '/_middleware';

export async function runMiddleware(
  input: HandleInput,
  request: Request,
): Promise<Response | undefined> {
  const handler = await middlewareHandler(input, MIDDLEWARE_ENTRY_ID);
  if (handler === undefined) {
    return undefined;
  }
  return handler(request, {
    waitUntil: input.waitUntil,
    requestMeta: { relativeProjectDir: '.' },
  });
}

/**
 * The middleware alone, run ahead of a shell the edge serves itself: its raw response, for the edge
 * to apply. It reads one thing of the manifest — the base path, which tells a data request apart
 * (`routedHeaders`) — and reads it without the store, which is built over every route, prerender
 * and file the deployment has: the middleware Function, whose first request that shell waits on,
 * carries only the head of the manifest (`deploymentConfig`).
 */
export async function answerMiddlewareOnly(input: RoutedInput): Promise<Response> {
  const { request } = input;
  const headers = routedHeaders(request, new URL(request.url), deploymentConfig().basePath);
  const response = await runMiddleware(input, new Request(request, { headers }));
  return response ?? new Response(null, { status: HTTP_OK, headers: { 'x-middleware-next': '1' } });
}
