import type { BlobRange } from '../preview/blobs.ts';
import { httpDateMs, listsTag } from '../strategies/asset-upstream.ts';

/**
 * What a request's preconditions and range make of the answer the edge gives with a shipped file.
 *
 * The edge is the file's origin here, in the place of Next.js's file server (`send`), so it judges
 * them as an origin does, in the order RFC 9110 gives them (§13.2.2): a precondition the file fails
 * first, ahead of a validator the client holds and of a range; the range last.
 */

/** One range of bytes; several, or another unit, are answered with the whole file, as allowed. */
const SINGLE_BYTE_RANGE = /^bytes=(?<start>\d*)-(?<end>\d*)$/u;

/**
 * Whether the request holds the answer to a precondition it fails, as Next.js's file server judges
 * one (`isPreconditionFailure`, in `send`): an `If-Match` naming neither `*` nor the entity tag the
 * answer carries; or, asked without one, an `If-Unmodified-Since` earlier than the answer's
 * `Last-Modified` (RFC 9110 §13.1.1, §13.1.4). The tags are compared weakly, as `send` compares them
 * where the RFC has an origin compare strongly, so that nothing Next.js serves is refused here; an
 * empty `If-Match` asks nothing, as `send` reads it. An answer with no modification date, or a date
 * either side that is no HTTP-date, leaves `If-Unmodified-Since` unjudged; `lastModified` is asked
 * only where there is one to judge.
 */
export function preconditionFails(
  request: Request,
  tag: string,
  lastModified: () => string | null,
): boolean {
  const ifMatch = request.headers.get('if-match');
  if (ifMatch !== null && ifMatch !== '') {
    return !listsTag(ifMatch, tag);
  }
  const since = request.headers.get('if-unmodified-since');
  if (since === null) {
    return false;
  }
  const modified = lastModified();
  const sinceMs = httpDateMs(since);
  const modifiedMs = modified === null ? undefined : httpDateMs(modified);
  return sinceMs !== undefined && modifiedMs !== undefined && modifiedMs > sinceMs;
}

/**
 * The single byte range asked for, when one was and the entity is the one it was asked of: an
 * `If-Range` naming another entity tag turns the request into one for the whole file. `undefined`
 * for no usable range; `null` for one that no byte of the file satisfies.
 */
export function requestedRange(
  request: Request,
  tag: string,
  length: number,
): BlobRange | null | undefined {
  const range = request.headers.get('range');
  if (range === null || request.method !== 'GET') {
    return undefined;
  }
  // Strong comparison (RFC 9110 §13.1.5): a weak tag does not say which bytes a client holds, so
  // it resumes nothing, even one spelled the same as the tag the answer carries.
  const condition = request.headers.get('if-range');
  if (condition !== null && (condition !== tag || tag.startsWith('W/'))) {
    return undefined;
  }
  const groups = SINGLE_BYTE_RANGE.exec(range.trim())?.groups;
  if (groups === undefined || (groups['start'] === '' && groups['end'] === '')) {
    return undefined;
  }
  // No byte of an empty file satisfies any range, and a suffix of it would compute an end before
  // its start: RFC 9110 §14.1.1 has nothing to return but 416.
  if (length === 0) {
    return null;
  }
  if (groups['start'] === '') {
    // A suffix: the last N bytes. An empty file has no last byte, whatever N is.
    const suffix = Number(groups['end']);
    return suffix === 0 || length === 0
      ? null
      : { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(groups['start']);
  const end = groups['end'] === '' ? length - 1 : Math.min(Number(groups['end']), length - 1);
  return start >= length || start > end ? null : { start, end };
}
