import { stripCookies } from '@stayingupwind/core/request';

/**
 * The host's own credentials, which never reach an application: cookies by name, headers by name.
 * Taken off everything the edge forwards — to a Function, to the middleware, and to an origin a
 * middleware rewrites to — after the request is sanitised for Next.js.
 */
export interface HostCredentials {
  readonly cookies: readonly string[];
  readonly headers: readonly string[];
}

/**
 * Take the host's own credentials off a request on its way to an application (`HostCredentials`).
 *
 * After the request is sanitised for Next.js, and separate from it: `@stayingupwind/core` strips
 * what a Next.js deployment must not see, and these are what the host must not hand over.
 *
 * A header among them may already be gone from anything sanitised, which drops the edge's own
 * header prefix wholesale, but not from what a middleware leaves behind: `readMiddlewareResponse`
 * carries the client's headers into `requestHeaders`, and what follows a middleware forwards those
 * to the application's Function and, for an external rewrite, to an origin the application named.
 *
 * Every path that forwards goes through here, which is the one place a host's names are applied. A
 * host that names no cookie leaves the cookie header as the client sent it, rather than writing it
 * again.
 */
export function withoutHostCredentials(headers: Headers, credentials: HostCredentials): Headers {
  if (credentials.cookies.length > 0) {
    const cookie = stripCookies(headers.get('cookie'), credentials.cookies);
    if (cookie === null) {
      headers.delete('cookie');
    } else {
      headers.set('cookie', cookie);
    }
  }
  for (const name of credentials.headers) {
    headers.delete(name);
  }
  return headers;
}
