import { SHARED_ANSWER_CACHE_CONTROL } from '@stayingupwind/core/paas';
import { filterStoredResponseHeaders } from '@stayingupwind/core/request';

import { documentHeaders, POSTPONED_HEADER, PRERENDER_HEADER, RSC_CONTENT_TYPE } from './serve.ts';
import { saySharedAnswer } from './shared-answer.ts';
import type { Store } from './store.ts';

/**
 * Which output of an entry a request is for: the document, a page's data, a handler's body, the
 * route's RSC payload, or one prefetched segment of it. The names are the host's own output
 * keys (`cache/regenerate.ts`), so a want is what a record's artifact list is searched with.
 */
export type Representation = 'html' | 'pages-data' | 'route-body' | 'rsc' | `segment:${string}`;

const JSON_UTF8_TYPE = 'application/json; charset=utf-8';
const OCTET_STREAM = 'application/octet-stream';
/** The representation of a page's data, and the role of the artifact that holds it. */
export const PAGES_DATA = 'pages-data';
/** The representation of a route handler's body, whose bytes the record carries as the primary. */
export const ROUTE_BODY = 'route-body';
/** What a representation of one prefetched segment begins with; the rest is the segment's key. */
export const SEGMENT_PREFIX = 'segment:';

/** The cached output an RSC request names: the route's payload or one prefetched segment. */
export function rscRepresentation(request: Request, store: Store): 'rsc' | `segment:${string}` {
  const segment = request.headers.get(store.manifest.routing.rsc.prefetchSegmentHeader);
  return segment === null ? 'rsc' : `${SEGMENT_PREFIX}${segment}`;
}

/**
 * The headers an output other than a document is served with: its own type, and one visitor's
 * alone unless it is a route handler's body out of a generation.
 *
 * That one is shareable, and is the only one here that is. It is the whole answer — the bytes a
 * handler wrote, an image or a feed, with no resume to come and nothing of the visitor in it — and
 * a generation of it is the same bytes for everyone until it is replaced. Served under
 * `SHARED_ANSWER_CACHE_CONTROL` with the generation as its validator, so that a metadata route's
 * image is revalidated rather than sent again: Next.js writes that very `Cache-Control` on such a
 * route itself, and without it a browser was made to re-read every icon on every navigation.
 *
 * A page's data, its RSC payload and its segments stay one visitor's: each is read by the client
 * router alongside a document, keyed on headers a cache cannot be trusted to vary on here.
 */
function outputHeaders(
  recorded: Readonly<Record<string, string>>,
  representation: Representation,
  partial: boolean,
  validator: string | undefined,
): Headers {
  // Whatever the application wrote under the platform's prefix is not what a host may read there;
  // what this function sets below is.
  const answered =
    representation === ROUTE_BODY
      ? filterStoredResponseHeaders(Object.entries(recorded))
      : recorded;
  const headers = new Headers(answered);
  headers.set('content-type', contentTypeOf(representation, recorded));
  if (representation === ROUTE_BODY && validator !== undefined) {
    headers.set('cache-control', SHARED_ANSWER_CACHE_CONTROL);
    headers.set('etag', validator);
    saySharedAnswer();
  } else {
    headers.set('cache-control', 'private, no-store');
  }
  if (representation === 'rsc' || representation.startsWith(SEGMENT_PREFIX)) {
    headers.set(PRERENDER_HEADER, '1');
    // The client keeps a partial Flight stream open for the unresolved records. Segments use
    // Next.js's distinct marker even when this segment itself contains no dynamic component.
    if (representation.startsWith(SEGMENT_PREFIX)) {
      headers.set(POSTPONED_HEADER, '2');
    } else if (partial) {
      headers.set(POSTPONED_HEADER, '1');
    }
  }
  return headers;
}

function contentTypeOf(
  representation: Representation,
  recorded: Readonly<Record<string, string>>,
): string {
  if (representation === PAGES_DATA) {
    return JSON_UTF8_TYPE;
  }
  if (representation === 'rsc' || representation.startsWith(SEGMENT_PREFIX)) {
    return RSC_CONTENT_TYPE;
  }
  return recorded['content-type'] ?? OCTET_STREAM;
}

/**
 * The headers the visitor is answered with, whatever the answer was read from. `validator` is the
 * entity tag the answer's bytes are named by, where the caller has one: a render made for this
 * visitor alone has none, and of the outputs only a route handler's body is given it.
 */
export function answerHeaders(
  representation: Representation,
  recorded: Readonly<Record<string, string>>,
  partial: boolean,
  validator?: string,
): Headers {
  return representation === 'html'
    ? documentHeaders(recorded)
    : outputHeaders(recorded, representation, partial, validator);
}
