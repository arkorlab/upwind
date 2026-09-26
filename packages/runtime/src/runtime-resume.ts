import {
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  pathFromHeaders,
  RESUME_STATE_BODY,
  RESUME_STATE_HEADER,
} from '@upwind/core/paas';

import { nodeHandlerOf } from './entries.ts';
import { readResumeState } from './resume-state.ts';
import {
  HTTP_NOT_FOUND,
  resume,
  resumeUrl,
  type RoutedInput,
  stripPlatformHeaders,
} from './serve.ts';

/**
 * A resume of a generation the runtime cache made: the edge served the generation's shell from
 * its record and sends the state that resumes it as the request's body — it read the state with
 * the shell, and the build this Worker carries never had it.
 */

const HTTP_BAD_REQUEST = 400;

/** Whether the edge sent a generation's resume state as the body. */
export function carriesResumeState(request: Request): boolean {
  return request.headers.get(RESUME_STATE_HEADER) === RESUME_STATE_BODY;
}

/** The edge served a generation made at runtime: resume from the state it sent in the body. */
export async function handleRuntimeResume(input: RoutedInput): Promise<Response> {
  const route =
    pathFromHeaders(input.request.headers, CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER) ?? '';
  const handler = await nodeHandlerOf(input, route);
  if (handler === undefined) {
    return new Response(`no Node.js entrypoint for ${route}`, { status: HTTP_NOT_FOUND });
  }
  const postponed = await readResumeState(input.request);
  if (postponed === undefined) {
    return new Response('resume state is not as declared', { status: HTTP_BAD_REQUEST });
  }
  // Next.js sees a GET with no body: the state travels in its metadata, never as an action's body.
  const headers = stripPlatformHeaders(input.request.headers);
  headers.delete('content-length');
  headers.delete('content-type');
  return resume({
    input,
    handler,
    postponed,
    url: resumeUrl(input.request),
    request: new Request(input.request.url, { headers }),
  });
}
