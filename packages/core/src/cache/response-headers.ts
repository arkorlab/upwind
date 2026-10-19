import {
  NO_STORE_CACHE_CONTROL,
  REDIRECT_STATUSES,
  SHARED_CACHE_CONTROL_HEADERS,
} from '../request/constants.ts';
import { filterShellResponseHeaders, filterStoredResponseHeaders } from '../request/headers.ts';
import type { RouteEntryKind } from './keys.ts';

const CACHE_CONTROL = 'cache-control';
const TRANSFORM_POLICY_HEADERS: ReadonlySet<string> = new Set([
  CACHE_CONTROL,
  ...SHARED_CACHE_CONTROL_HEADERS,
]);

/**
 * What a redirect cannot be answered without: where it leads, and the `Refresh` Next.js sends
 * beside a permanent one for the clients that do not follow a 308.
 */
const REDIRECT_RESPONSE_HEADERS: ReadonlySet<string> = new Set(['location', 'refresh']);

/**
 * The headers a generation is recorded with, from those its render was answered with under
 * `status`: what the entry is answered with from then on, wherever its record is served from. The
 * build's generation (`bundle/cache-seed.ts`) and every one a regeneration publishes are recorded
 * here, so the two never disagree about what the same entry says.
 *
 * A page's generation is a shell the edge may serve ahead of a resume, and keeps only what a
 * shell may replay — unless it is a redirect: the edge serves no status but 200, and the
 * deployment's Function answers a redirect it keeps as Next.js answers one it cached, with where
 * it leads. A route handler keeps its cache-control as a privacy veto for a host that can serve
 * its body. Cookies themselves are never recorded; their presence instead makes the stored
 * response private. Neither a public cache-control nor its absence grants a host sharing rights.
 */
export function generationResponseHeaders(
  kind: RouteEntryKind,
  status: number,
  headers: Iterable<[string, string]>,
): Record<string, string> {
  const answered = [...headers];
  if (kind === 'app-route') {
    return routeBodyHeaders(answered);
  }
  const kept = filterShellResponseHeaders(answered);
  if (REDIRECT_STATUSES.has(status)) {
    for (const [name, value] of answered) {
      const lower = name.toLowerCase();
      if (REDIRECT_RESPONSE_HEADERS.has(lower)) {
        kept[lower] = value;
      }
    }
  }
  return kept;
}

/** Privacy signals survive storage even when their original headers may not be replayed. */
function routeBodyHeaders(answered: readonly [string, string][]): Record<string, string> {
  const kept = filterStoredResponseHeaders(answered);
  const privacyNames = new Set([
    CACHE_CONTROL,
    'content-encoding',
    'content-range',
    'content-type',
    'set-cookie',
    'vary',
    ...SHARED_CACHE_CONTROL_HEADERS,
  ]);
  const cacheControl: string[] = [];
  let privateResponse = false;
  for (const [name, value] of answered) {
    const lower = name.toLowerCase();
    if (lower === CACHE_CONTROL) {
      cacheControl.push(value);
    }
    if (
      lower === 'set-cookie' ||
      lower === 'content-range' ||
      (lower === 'vary' && value.split(',').some((token) => token.trim() === '*')) ||
      (lower === 'content-encoding' && value.trim().toLowerCase() !== 'identity') ||
      (SHARED_CACHE_CONTROL_HEADERS.includes(lower) &&
        /(?:^|,)\s*(?:private|no-store)(?:[\s,=]|$)/iu.test(value)) ||
      (lower === 'connection' &&
        value.split(',').some((token) => privacyNames.has(token.trim().toLowerCase())))
    ) {
      privateResponse = true;
    }
  }
  if (privateResponse) {
    kept[CACHE_CONTROL] = NO_STORE_CACHE_CONTROL;
  } else if (cacheControl.length > 0) {
    kept[CACHE_CONTROL] = cacheControl.join(', ');
  }
  const transformDenied = answered.some(
    ([name, value]) => TRANSFORM_POLICY_HEADERS.has(name.toLowerCase()) && noTransform(value),
  );
  if (transformDenied) {
    const policy = kept[CACHE_CONTROL];
    if (policy === undefined) {
      kept[CACHE_CONTROL] = 'no-transform';
    } else if (!noTransform(policy)) {
      kept[CACHE_CONTROL] = `${policy}, no-transform`;
    }
  }
  return kept;
}

/** A prohibition only; targeted sharing and freshness directives never become browser policy. */
function noTransform(value: string): boolean {
  return value.split(',').some((directive) => directive.trim().toLowerCase() === 'no-transform');
}
