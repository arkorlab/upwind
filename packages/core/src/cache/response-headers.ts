import { REDIRECT_STATUSES } from '../request/constants.ts';
import { filterShellResponseHeaders, filterStoredResponseHeaders } from '../request/headers.ts';
import type { RouteEntryKind } from './keys.ts';

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
 * it leads. A route handler's generation never reaches the edge: the Function answers it whole, as
 * the handler answered it, and without a generation it answers with every header the build
 * recorded — so its generation keeps what the handler said, less what no stored response is
 * replayed with.
 */
export function generationResponseHeaders(
  kind: RouteEntryKind,
  status: number,
  headers: Iterable<[string, string]>,
): Record<string, string> {
  const answered = [...headers];
  if (kind === 'app-route') {
    return filterStoredResponseHeaders(answered);
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
