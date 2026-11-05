import { cacheDirectives, removeSharedCacheOverrides } from '../request/cache-control.ts';
import { SHARED_CACHE_CONTROL_HEADERS } from '../request/constants.ts';
import { releaseStream } from '../util/stream.ts';
import {
  publicationDeadline,
  publicationExpired,
  publicationTimeFor,
  type PublicationRequirement,
} from './publication.ts';

/** Whether a targeted cache field also forbids transforming the producer's bytes. */
function targetedNoTransform(headers: Headers): boolean {
  for (const name of SHARED_CACHE_CONTROL_HEADERS) {
    const value = headers.get(name);
    if (value === null) continue;
    for (const directive of cacheDirectives(value)) {
      if (directive.split('=', 1)[0]?.trim().toLowerCase() === 'no-transform') return true;
    }
  }
  return false;
}

/** The final response-admission check, after asynchronous reads and before returning headers. */
export function admitPublication(
  response: Response,
  tags: readonly string[],
  now: number,
  required?: PublicationRequirement,
): Response {
  const checkedNow = required === undefined ? now : publicationTimeFor(required, now);
  if (publicationExpired(tags, checkedNow, required)) {
    releaseStream(response.body, 'publication expired');
    return new Response('Publication unavailable', {
      status: 503,
      headers: { 'cache-control': 'private, no-store' },
    });
  }
  if (publicationDeadline(tags) !== undefined) {
    // Cache API/internal records retain their own grants. No outer cache may bypass admission.
    const admitted = new Response(response.body, response);
    const { headers } = admitted;
    removeSharedCacheOverrides(headers);
    const control = response.headers.get('cache-control') ?? '';
    const directives = new Set(
      cacheDirectives(control).map(
        (directive) => directive.split('=', 1)[0]?.trim().toLowerCase() ?? '',
      ),
    );
    const policy = directives.has('no-store')
      ? 'private, no-store'
      : 'private, no-cache, must-revalidate';
    const transform =
      directives.has('no-transform') || targetedNoTransform(response.headers)
        ? ', no-transform'
        : '';
    headers.set('cache-control', policy + transform);
    return admitted;
  }
  return response;
}
