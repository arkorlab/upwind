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
 * Routing's cookies beside the handler's: ahead of them, as Next.js puts a middleware's ahead of
 * those the handler sets (`patchSetHeaderWithCookieSupport`, `server/lib/patch-set-header.ts`).
 * Appended after them, a middleware's cookie came second where Next.js sends it first
 * (`skip-trailing-slash-redirect`). Each of routing's is sent once, where routing writes it last
 * (`lastWrites`), and the handler's copies of them are left out. The handler's own keep their order
 * and their repeats: a cookie it writes again after deleting it is still its last write. Two of
 * routing's still follow the handler's, as they always did:
 * - one under a name the handler sets otherwise. The handler's may be Next.js writing the
 *   middleware's back as the render's own (`mergeMiddlewareCookies`), with less of it
 *   (`host/src/splice/cookies.ts`: a `Max-Age=0` it drops), or a value of the handler's own; which
 *   it is takes the rules the edge splices a resume by, and is not judged here. A browser keeps the
 *   last, routing's, as the edge lays a middleware it ran (`layAfterMiddleware`).
 * - the `later` block, which the edge takes off the end as the routing phases' after the rules it
 *   judged (`noteLaterHeaderRules`, `takeLaterRuleCookies`): it stays last and whole.
 */
function layRoutingCookies(headers: Headers, routed: readonly string[], later: number): void {
  const own = headers.getSetCookie();
  const ahead = routed.slice(0, routed.length - later);
  const last = routed.slice(routed.length - later);
  const routing = new Set(ahead);
  const otherwise = new Set<string>();
  for (const cookie of own) {
    if (!routing.has(cookie)) otherwise.add(nameOf(cookie));
  }
  const lead = lastWrites(ahead.filter((cookie) => !otherwise.has(nameOf(cookie))));
  const trail = lastWrites(ahead.filter((cookie) => otherwise.has(nameOf(cookie))));
  headers.delete(SET_COOKIE);
  for (const cookie of lead) headers.append(SET_COOKIE, cookie);
  // The handler's own, in order: its copies of routing's are routing's to send.
  for (const cookie of own) {
    if (!routing.has(cookie)) headers.append(SET_COOKIE, cookie);
  }
  for (const cookie of trail) headers.append(SET_COOKIE, cookie);
  // Not one less for a cookie the handler set as well: the edge counts this block from the end.
  for (const cookie of last) headers.append(SET_COOKIE, cookie);
}

/**
 * Each of `cookies` once, where it is written last. An earlier copy of a cookie written again later
 * changes nothing a browser keeps; keeping the first of them instead would let a write between the
 * two outlast the second.
 */
function lastWrites(cookies: readonly string[]): string[] {
  return cookies.filter((cookie, index) => !cookies.includes(cookie, index + 1));
}

/** How many of routing's cookies end the answer for the edge: none unless the runtime said so. */
function laterCookieCount(added: Headers, routed: number): number {
  const value = added.get(HEADER_RULES_AFTER_COOKIE_COUNT_HEADER);
  return value !== null && COUNT.test(value) ? Math.min(Number(value), routed) : 0;
}

function nameOf(setCookie: string): string {
  return (setCookie.split(';', 1)[0] ?? '').split('=', 1)[0]?.trim() ?? '';
}
