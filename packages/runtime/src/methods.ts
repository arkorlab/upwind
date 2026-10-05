import { NEXT_ACTION_HEADER } from '@stayingupwind/core/request';

import type { Store } from './store.ts';

/**
 * Which methods a page is answered for, where Next.js answers reads only: what `next start` refuses
 * before it renders (`base-server.js`), and the handlers an adapter calls do not.
 */

const HTTP_METHOD_NOT_ALLOWED = 405;
/** What a page that answers reads only allows. */
const READS: readonly string[] = ['GET', 'HEAD'];
/** The pages Next.js answers whatever the method, since they answer errors. */
const STATUS_PAGES: ReadonlySet<string> = new Set(['/404', '/500', '/_error']);
const FORM_URLENCODED = 'application/x-www-form-urlencoded';
const FORM_MULTIPART = 'multipart/form-data';

/** Whether a method only reads, which a file and a page that answers reads only are asked with. */
export function isRead(method: string): boolean {
  return READS.includes(method);
}

/** Next.js's refusal of a method where only reads are answered (`base-server.js`). */
export function methodNotAllowed(): Response {
  return new Response('Method Not Allowed', {
    status: HTTP_METHOD_NOT_ALLOWED,
    headers: { allow: READS.join(', ') },
  });
}

/**
 * Whether a request may be a Server Action as Next.js judges one before it refuses a method
 * (`getIsPossibleServerAction`): a `POST` that names an action, or one a form sent.
 */
function possibleServerAction(request: Request): boolean {
  if (request.method !== 'POST') {
    return false;
  }
  const type = request.headers.get('content-type');
  return (
    request.headers.has(NEXT_ACTION_HEADER) ||
    type === FORM_URLENCODED ||
    (type?.startsWith(FORM_MULTIPART) ?? false)
  );
}

/**
 * Whether Next.js answers only reads of the page a request resolved to: a Pages Router page the build
 * rendered (`getStaticProps`), other than a status page, asked with nothing that may be a Server
 * Action. `next start` refuses every other method there with `405` and `Allow: GET, HEAD`
 * (`base-server.js`); the page handler an adapter calls has no such check, and rendered the page for
 * a `POST` as for a `GET`.
 */
export function readsOnly(store: Store, route: string, request: Request): boolean {
  return (
    store.renderedPagesRoutes.has(route) &&
    !STATUS_PAGES.has(route) &&
    !possibleServerAction(request)
  );
}
