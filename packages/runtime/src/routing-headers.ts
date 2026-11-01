import { withHeadersChanged } from './reframe.ts';

const SET_COOKIE = 'set-cookie';

/**
 * The headers routing decided a response carries — `next.config` header rules, what the
 * middleware set — added to the response that was produced. Anything routing said wins over what
 * the handler said, as it does on Next.js's own server; cookies accumulate, routing's ahead of the
 * handler's and each once, as Next.js puts a middleware's ahead of those the handler sets
 * (`patchSetHeaderWithCookieSupport`, `server/lib/patch-set-header.ts`). Appended after them, a
 * middleware's cookie came second where Next.js sends it first (`skip-trailing-slash-redirect`).
 */
export function withRoutingHeaders(response: Response, added: Headers | undefined): Response {
  if (added === undefined) {
    return response;
  }
  return withHeadersChanged(response, (headers) => {
    for (const [name, value] of added) {
      if (name !== SET_COOKIE) {
        headers.set(name, value);
      }
    }
    const routed = added.getSetCookie();
    if (routed.length === 0) {
      return;
    }
    const cookies = new Set(routed);
    for (const cookie of headers.getSetCookie()) {
      cookies.add(cookie);
    }
    headers.delete(SET_COOKIE);
    for (const cookie of cookies) {
      headers.append(SET_COOKIE, cookie);
    }
  });
}
