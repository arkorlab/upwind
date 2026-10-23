import {
  BYPASS_COOKIE_NAMES,
  DEPLOYMENT_ID_REQUEST_HEADER,
  EDGE_BYPASS_COOKIE,
  INTERNAL_REQUEST_HEADERS,
  NAVIGATION_REQUEST_HEADERS,
  PREFETCH_HINT_HEADERS,
  ROUTER_REQUEST_HEADERS,
  SKEW_PROTECTION_COOKIE,
  STATIC_PAGE_PRIVATE_HEADERS,
} from '@stayingupwind/core/request';
import type { HostCredentials } from '@stayingupwind/host/credentials';

/**
 * The headers the classification reads by name (`classifyRequest`), beside the application's
 * conditions, and what is read of the request as it came after it (`requestAsLeft`): the router's
 * and a Server Action's, a service worker's and a range's, the internal ones no client may send, a
 * navigation's Fetch Metadata and its prefetch hints, the agent, `accept`, and the `cookie` header
 * the cookies below are read from.
 */
export const CLASSIFIED_HEADERS: ReadonlySet<string> = new Set([
  ...ROUTER_REQUEST_HEADERS,
  DEPLOYMENT_ID_REQUEST_HEADER,
  'range',
  'service-worker',
  ...INTERNAL_REQUEST_HEADERS,
  ...Object.keys(NAVIGATION_REQUEST_HEADERS),
  ...PREFETCH_HINT_HEADERS,
  'accept',
  'cookie',
  'user-agent',
]);
export const STATIC_CLASSIFIED_HEADERS: ReadonlySet<string> = new Set(STATIC_PAGE_PRIVATE_HEADERS);
/** How the internal headers it turns a request away for begin (`hasInternalDocumentHeader`). */
export const CLASSIFIED_HEADER_PREFIXES: readonly string[] = ['x-middleware-', 'x-prerender-'];
/**
 * The cookies it reads by name: draft mode's, Next.js's testing one, and the deployment a client is
 * pinned to. Not the edge's own (`EDGE_BYPASS_COOKIE`), which no application is handed whatever the
 * host keeps, and which the classification reads as the visitor sent it (`withoutCredentials`).
 */
const CLASSIFIED_COOKIES: ReadonlySet<string> = new Set([
  ...BYPASS_COOKIE_NAMES.filter((name) => name !== EDGE_BYPASS_COOKIE),
  SKEW_PROTECTION_COOKIE,
]);

/** What `classificationReadsCredentials` found for a host's credentials. */
const credentialsRead = new WeakMap<
  HostCredentials,
  {
    readonly general: boolean;
    readonly staticPages: boolean;
  }
>();

/**
 * Whether the classification reads one of the host's credentials by name (`CLASSIFIED_HEADERS`,
 * `CLASSIFIED_COOKIES`): a cookie it names, a header it names, or the `cookie` header whole. Asked
 * once for a host's credentials, which are the host's for as long as it is.
 */
export function classificationReadsCredentials(
  credentials: HostCredentials,
  staticPages: boolean,
): boolean {
  let reads = credentialsRead.get(credentials);
  if (reads === undefined) {
    const general =
      credentials.cookies.some((name) => CLASSIFIED_COOKIES.has(name)) ||
      credentials.headers.some((header) => {
        const name = header.toLowerCase();
        return (
          CLASSIFIED_HEADERS.has(name) ||
          CLASSIFIED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
        );
      });
    reads = {
      general,
      staticPages: credentials.headers.some((name) =>
        STATIC_CLASSIFIED_HEADERS.has(name.toLowerCase()),
      ),
    };
    credentialsRead.set(credentials, reads);
  }
  return reads.general || (staticPages && reads.staticPages);
}
