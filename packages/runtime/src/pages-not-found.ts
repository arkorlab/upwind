/**
 * What a Pages Router data request is told when the page is not there.
 *
 * The client router parses what comes back from `/_next/data/…json` as the page's props, so a
 * not-found document under a 404 would be read as those. Next.js answers its own `notFound: true`
 * on a data request with this object, and the platform answers a pathname with no page at all the
 * same way — one shape for the router to read, whichever of the two it is.
 */

const NOT_FOUND_DATA = '{"notFound":true}';
const HTTP_NOT_FOUND = 404;

export function notFoundData(): Response {
  return new Response(NOT_FOUND_DATA, {
    status: HTTP_NOT_FOUND,
    headers: { 'content-type': 'application/json' },
  });
}
