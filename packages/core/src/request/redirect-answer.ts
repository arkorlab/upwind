import { REDIRECT_STATUS } from './constants.ts';

const ENCODER = new TextEncoder();

/**
 * A redirect that brings no body of its own, answered as Next.js's server answers one
 * (`server/lib/router-server.js`): its destination for a body, which a client that does not follow
 * `Location` shows, and on a permanent redirect a `Refresh` that names it too. The body is bytes, so
 * that no `Content-Type` is added that Next.js does not send. `headers` are the redirect's own, and
 * gain the `Refresh`.
 */
export function redirectAnswer(location: string, status: number, headers: Headers): Response {
  if (status === REDIRECT_STATUS.permanentRedirect) {
    headers.set('refresh', `0;url=${location}`);
  }
  return new Response(ENCODER.encode(location), { status, headers });
}
