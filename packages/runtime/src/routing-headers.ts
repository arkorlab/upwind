import { HEADER_RULES_AFTER_COOKIE_COUNT_HEADER } from '@stayingupwind/core/paas';

import { withHeadersChanged } from './reframe.ts';

const SET_COOKIE = 'set-cookie';
/** A count as the runtime writes it (`noteLaterHeaderRules`) and the edge reads it. */
const COUNT = /^[1-9]\d*$/u;

/**
 * The headers routing decided a response carries — `next.config` header rules, what the
 * middleware set — added to the response that was produced. Anything routing said wins over what
 * the handler said, as it does on Next.js's own server; cookies accumulate (`layRoutingCookies`).
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
    if (routed.length > 0) {
      layRoutingCookies(headers, routed, laterCookieCount(added, routed.length));
    }
  });
}

/**
 * Routing's cookies beside the handler's: ahead of them, each once, as Next.js puts a middleware's
 * ahead of those the handler sets (`patchSetHeaderWithCookieSupport`, `server/lib/patch-set-header.ts`).
 * Appended after them, a middleware's cookie came second where Next.js sends it first
 * (`skip-trailing-slash-redirect`). Two still follow the handler's:
 * - one the handler sets otherwise under the same name, which may be Next.js writing the
 *   middleware's back with less of it (`host/src/splice/cookies.ts`: a `Max-Age=0` it drops). A
 *   browser keeps the last, and the middleware's is the one it meant, as the edge lays a middleware
 *   it ran (`layAfterMiddleware`).
 * - the `later` block, which the edge takes off the end as the routing phases' after the rules it
 *   judged (`noteLaterHeaderRules`, `takeLaterRuleCookies`): it stays last and whole.
 */
function layRoutingCookies(headers: Headers, routed: readonly string[], later: number): void {
  const own = headers.getSetCookie();
  const ahead = routed.slice(0, routed.length - later);
  const last = routed.slice(routed.length - later);
  const same = new Set(ahead);
  const otherwise = new Set<string>();
  for (const cookie of own) {
    if (!same.has(cookie)) otherwise.add(nameOf(cookie));
  }
  const cookies = new Set(ahead.filter((cookie) => !otherwise.has(nameOf(cookie))));
  for (const cookie of own) cookies.add(cookie);
  for (const cookie of ahead) cookies.add(cookie);
  headers.delete(SET_COOKIE);
  for (const cookie of cookies) headers.append(SET_COOKIE, cookie);
  // Not one less for a cookie the handler set as well: the edge counts this block from the end.
  for (const cookie of last) headers.append(SET_COOKIE, cookie);
}

/** How many of routing's cookies end the answer for the edge: none unless the runtime said so. */
function laterCookieCount(added: Headers, routed: number): number {
  const value = added.get(HEADER_RULES_AFTER_COOKIE_COUNT_HEADER);
  return value !== null && COUNT.test(value) ? Math.min(Number(value), routed) : 0;
}

function nameOf(setCookie: string): string {
  return (setCookie.split(';', 1)[0] ?? '').split('=', 1)[0]?.trim() ?? '';
}
