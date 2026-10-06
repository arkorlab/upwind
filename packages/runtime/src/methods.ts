import { NEXT_ACTION_HEADER } from '@stayingupwind/core/request';

import { type Store, unlocalizedRouteOf } from './store.ts';

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
 * Whether a route is a status page under the application's own spelling of it: `/404`, `/500` and
 * `/_error` behind the base path, and behind a locale where the application has `i18n`.
 */
function isStatusPage(store: Store, route: string): boolean {
  const { basePath } = store.manifest.config;
  const unlocalized = unlocalizedRouteOf(store.manifest.config, route) ?? route;
  const bare =
    basePath !== '' && (unlocalized === basePath || unlocalized.startsWith(`${basePath}/`))
      ? unlocalized.slice(basePath.length) || '/'
      : unlocalized;
  return STATUS_PAGES.has(bare);
}

/**
 * Whether Next.js answers only reads of the page a request resolved to: a Pages Router page the build
 * rendered (`getStaticProps`) — by its route, or by the pathname of a member the build prerendered,
 * which a request for that member resolves to — other than a status page, asked with nothing that may
 * be a Server Action. `next start` refuses every other method there with `405` and
 * `Allow: GET, HEAD` (`base-server.js`); the page handler an adapter calls has no such check, and
 * rendered the page for a `POST` as for a `GET`.
 */
export function readsOnly(
  store: Store,
  resolved: { readonly route: string; readonly pathname: string },
  request: Request,
): boolean {
  const rendered =
    store.renderedPages.has(resolved.route) || store.renderedPages.has(resolved.pathname);
  return rendered && !isStatusPage(store, resolved.route) && !possibleServerAction(request);
}
