import { ORIGINAL_URL_HEADER, PLATFORM_REQUEST_HEADERS } from '@upwind/core/paas';
import { BYPASS_QUERY_PREFIXES } from '@upwind/core/request';

/**
 * What an incoming request says about itself.
 *
 * Every function here reads the client's request — its headers, its URL — and nothing of the
 * deployment: no store, no routing table, no entrypoint. They are the first thing request
 * handling does with a request and the last thing that has to change when routing does.
 */

const RSC_HEADER = 'rsc';

/** The headers the edge adds for the Worker's own use; Next.js never sees them. */
export function stripPlatformHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of PLATFORM_REQUEST_HEADERS) {
    out.delete(name);
  }
  return out;
}

/** The URL the client asked for: the edge names it when it rewrote the request, else it is this one. */
export function initUrlOf(request: Request): string {
  const original = request.headers.get(ORIGINAL_URL_HEADER);
  const url = new URL(request.url);
  return original === null ? request.url : new URL(original, url.origin).href;
}

/**
 * The path and query a resume renders for, with the query keys Next.js reads its own route
 * parameters from (`nxtPorgSlug`) left out. The edge sends a class shell's member by its own
 * path, and the parameters come from that path: a key smuggled into the query is not given the
 * chance to compete with it.
 */
export function resumeUrl(request: Request): string {
  const url = new URL(request.url);
  const smuggled = [...url.searchParams.keys()].filter((key) =>
    BYPASS_QUERY_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
  for (const key of smuggled) {
    url.searchParams.delete(key);
  }
  return `${url.pathname}${url.search}`;
}

export function isRscRequest(request: Request): boolean {
  return request.headers.get(RSC_HEADER) === '1';
}

/** The pathname a shell's RSC twins hang off: the build names the root's `/index`. */
export function rscBase(pathname: string): string {
  return pathname === '/' ? '/index' : pathname;
}

export function hasBody(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}
