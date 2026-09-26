import { getCookieValue } from '@stayingupwind/core/request';

import type { Store } from './store.ts';

/**
 * Draft mode: the one kind of request that is answered by rendering the page rather than by
 * reading what the build wrote.
 *
 * An editor previewing unpublished content enters it through the application's own route handler
 * (`draftMode().enable()`, `res.setPreviewData()`), which sets a cookie holding the token
 * `next build` generated for this build. Next.js checks the cookie against that token and, when
 * it matches, runs `getStaticProps` for the request instead of using its cached output
 * (`try-get-preview-data.ts`) — but only where it is asked to render at all. Which requests those
 * are is the platform's decision to make (Adapters, "Prerendered routes"), and this is where the
 * runtime makes it: a stored document, a stored `_next/data` output and a shell of the build are
 * all answers from before the draft existed.
 *
 * The token is compared, not merely looked for. A cookie of any value would otherwise turn every
 * page of a build into a render, for anyone who sends one.
 */

/** The cookie Next.js reads the token from; the other one carries encrypted preview data. */
const BYPASS_COOKIE = '__prerender_bypass';

export function isDraftRequest(store: Store, request: Request): boolean {
  const { bypassToken } = store.manifest;
  if (bypassToken === undefined) {
    return false;
  }
  const cookie = request.headers.get('cookie');
  // Read before the header is parsed: nearly every request answered here carries no draft cookie,
  // and the answer for those is one scan of a string that is usually short and often absent.
  if (cookie?.includes(BYPASS_COOKIE) !== true) {
    return false;
  }
  return getCookieValue(cookie, BYPASS_COOKIE) === bypassToken;
}
