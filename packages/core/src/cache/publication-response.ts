import { restrictPublicationCache } from '../request/publication-policy.ts';
import { releaseStream } from '../util/stream.ts';
import {
  publicationDeadline,
  publicationExpired,
  publicationTimeFor,
  type PublicationRequirement,
} from './publication.ts';

const UNSCOPED_CLOCK = {};

interface PublicationAdmission {
  readonly required?: PublicationRequirement | undefined;
  readonly clockOwner: WeakKey;
}

/** The final response-admission check, after asynchronous reads and before returning headers. */
export function admitPublication(
  response: Response,
  tags: readonly string[],
  now: number,
  admission?: PublicationRequirement | PublicationAdmission,
): Response {
  const required =
    admission !== undefined && 'clockOwner' in admission ? admission.required : admission;
  const clockOwner =
    admission !== undefined && 'clockOwner' in admission
      ? admission.clockOwner
      : (required ?? UNSCOPED_CLOCK);
  const bounded = required !== undefined || publicationDeadline(tags) !== undefined;
  const checkedNow = bounded ? publicationTimeFor(clockOwner, now) : now;
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
    restrictPublicationCache(admitted.headers);
    return admitted;
  }
  return response;
}
