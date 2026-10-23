/**
 * The one range of bytes a request asks of a file, read as the edge reads it (`requestedRange` in its
 * handler for files), mirrored here rather than called: the edge's module imports one of the Workers
 * runtime's.
 */

/** One range of a file's bytes, both ends inclusive. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/** One range of bytes; several, or another unit, are answered with the whole file. */
const SINGLE_BYTE_RANGE = /^bytes=(?<start>\d*)-(?<end>\d*)$/u;

/**
 * Whether an `If-Range` names the answer a range of it would be cut from: its entity tag, compared
 * strongly. A weak tag, or a date, resumes nothing.
 */
function namesTheAnswer(condition: string, tag: string): boolean {
  return condition === tag && !tag.startsWith('W/');
}

/**
 * The single byte range a `GET` asks of a file `length` bytes long whose answer carries `tag`, when
 * one was asked and the entity is the one it was asked of: an `If-Range` naming another turns the
 * request into one for the whole file. `undefined` for no usable range; `null` for one no byte of the
 * file satisfies.
 */
export function requestedRange(
  headers: Headers,
  tag: string,
  length: number,
): ByteRange | null | undefined {
  const range = headers.get('range');
  if (range === null) {
    return undefined;
  }
  const condition = headers.get('if-range');
  if (condition !== null && !namesTheAnswer(condition, tag)) {
    return undefined;
  }
  const groups = SINGLE_BYTE_RANGE.exec(range.trim())?.groups;
  if (groups === undefined || (groups['start'] === '' && groups['end'] === '')) {
    return undefined;
  }
  // No byte of an empty file satisfies any range.
  if (length === 0) {
    return null;
  }
  if (groups['start'] === '') {
    // A suffix: the last N bytes.
    const suffix = Number(groups['end']);
    return suffix === 0 ? null : { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(groups['start']);
  const end = groups['end'] === '' ? length - 1 : Math.min(Number(groups['end']), length - 1);
  return start >= length || start > end ? null : { start, end };
}
