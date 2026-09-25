import { filterStoredResponseHeaders } from '@upwind/core/request';

import { documentHeaders, POSTPONED_HEADER, PRERENDER_HEADER, RSC_CONTENT_TYPE } from './serve.ts';
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

/** The headers an output other than a document is served with: its own type, never shared. */
function outputHeaders(
  recorded: Readonly<Record<string, string>>,
  representation: Representation,
  partial: boolean,
): Headers {
  const headers = new Headers(
    representation === ROUTE_BODY
      ? filterStoredResponseHeaders(Object.entries(recorded))
      : recorded,
  );
  headers.set('content-type', contentTypeOf(representation, recorded));
  headers.set('cache-control', 'private, no-store');
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

/** The headers the visitor is answered with, whatever the answer was read from. */
export function answerHeaders(
  representation: Representation,
  recorded: Readonly<Record<string, string>>,
  partial: boolean,
): Headers {
  return representation === 'html'
    ? documentHeaders(recorded)
    : outputHeaders(recorded, representation, partial);
}
