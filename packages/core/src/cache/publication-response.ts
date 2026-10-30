import { releaseStream } from '../util/stream.ts';
import {
  publicationDeadline,
  publicationExpired,
  publicationTimeFor,
  type PublicationRequirement,
} from './publication.ts';

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
    for (const header of ['cdn-cache-control', 'cloudflare-cdn-cache-control', 'surrogate-control'])
      headers.delete(header);
    headers.set(
      'cache-control',
      response.headers.get('cache-control')?.includes('no-store') === true
        ? 'private, no-store'
        : 'private, no-cache, must-revalidate',
    );
    return admitted;
  }
  return response;
}
