import {
  encodeLocaleRequest,
  LOCALE_REQUEST_HEADER,
  MIDDLEWARE_DONE_HEADER,
  MIDDLEWARE_REWRITE_STATUS_HEADER,
  MIDDLEWARE_SET_COOKIE_HEADER,
  ORIGINAL_URL_HEADER,
} from '@stayingupwind/core/paas';
import { sanitizePassthroughHeaders } from '@stayingupwind/core/request';
import { withoutHostCredentials } from '@stayingupwind/host/credentials';

import type { EdgeContext } from '../strategies/context.ts';
import type { MiddlewareContinued } from './middleware.ts';

/**
 * A source's request as the middleware left it, with the Worker told the middleware ran — and the
 * status it gave its rewrite, which the Worker answers the route under as one it ran the middleware
 * for itself (`MIDDLEWARE_REWRITE_STATUS_HEADER`), and the cookies it set, which the route reads as
 * the client's own: Next.js's router puts them on the request for the route a middleware rewrote
 * to (`resolve-routes.js`), and a passthrough hands them on so too (`markMiddlewareDone`).
 */
export function rewrittenImageRequest(
  edge: EdgeContext,
  original: Request,
  middleware: MiddlewareContinued,
): Request {
  // Without what no application is handed, as a passthrough's request goes without it
  // (`buildPassthroughRequest`): the edge's own headers, which tell the Worker what to do, whether
  // the middleware named one among the request's or answered with one, the middleware protocol's,
  // and the host's credentials. Under the forwarding headers `localRequest` sends: the client's
  // address and country are no source's.
  const headers = withoutHostCredentials(
    sanitizePassthroughHeaders(middleware.requestHeaders, {
      ...edge.forwarding,
      clientIp: undefined,
      clientCountry: undefined,
    }),
    edge.host.credentials,
  );
  headers.set(MIDDLEWARE_DONE_HEADER, '1');
  headers.set(ORIGINAL_URL_HEADER, original.url);
  if (middleware.localeRequest !== undefined) {
    headers.set(LOCALE_REQUEST_HEADER, encodeLocaleRequest(middleware.localeRequest));
  }
  if (middleware.rewriteStatus !== undefined) {
    headers.set(MIDDLEWARE_REWRITE_STATUS_HEADER, String(middleware.rewriteStatus));
  }
  if (middleware.setCookie !== undefined) {
    headers.set(MIDDLEWARE_SET_COOKIE_HEADER, middleware.setCookie);
  }
  return new Request(middleware.url.href, { headers, redirect: 'manual', signal: original.signal });
}
