import { concatBytes, decodeUtf8, encodeUtf8, startsWithBytes } from './util/bytes.ts';

/**
 * Original sources kept beside a compact source map, without putting their text in its cache.
 * The fixed prefix names the format and measures a JSON index; the index has one entry per map
 * source, and measures byte ranges in the UTF-8 payload after it. A host can read one source with
 * three bounded range requests instead of parsing every source of an application's bundle.
 */
const MAGIC = encodeUtf8('UPSC');
const VERSION = 1;
const LENGTH_BYTES = 4;
export const SOURCE_ARCHIVE_PREFIX_BYTES = MAGIC.byteLength + 1 + LENGTH_BYTES;
const KIB = 1024;
const ARCHIVE_MIB = 25;
const NULL_LENGTH = 'null'.length;
export const MAX_SOURCE_ARCHIVE_BYTES = ARCHIVE_MIB * KIB * KIB;
export const MAX_SOURCE_ARCHIVE_INDEX_BYTES = KIB * KIB;
export const MAX_SOURCE_CONTENT_BYTES = KIB * KIB;

export type SourceArchiveRange = readonly [offset: number, length: number];
export type SourceArchiveIndex = readonly (SourceArchiveRange | null)[];

/**
 * Lay out the available source contents, in their map's order. Missing contents, individual
 * sources over the bound and sources that would exceed the archive's bound leave a null entry.
 * No source text is a reason for a build to fail, and no available text means no artifact to keep.
 */
export function encodeSourceArchive(contents: readonly unknown[]): Uint8Array | undefined {
  // `[null,null]`: four characters an entry, a comma between entries, and two brackets.
  let indexLength = contents.length === 0 ? 2 : contents.length * (NULL_LENGTH + 1) + 1;
  if (indexLength > MAX_SOURCE_ARCHIVE_INDEX_BYTES) return undefined;
  const index: (SourceArchiveRange | null)[] = Array.from({ length: contents.length }, () => null);
  const payload: Uint8Array[] = [];
  let payloadLength = 0;
  for (const [at, content] of contents.entries()) {
    if (
      typeof content !== 'string' ||
      content === '' ||
      content.length > MAX_SOURCE_CONTENT_BYTES
    ) {
      continue;
    }
    const bytes = encodeUtf8(content);
    const range: SourceArchiveRange = [payloadLength, bytes.byteLength];
    const nextIndexLength = indexLength + JSON.stringify(range).length - NULL_LENGTH;
    if (
      bytes.byteLength > MAX_SOURCE_CONTENT_BYTES ||
      nextIndexLength > MAX_SOURCE_ARCHIVE_INDEX_BYTES ||
      SOURCE_ARCHIVE_PREFIX_BYTES + nextIndexLength + payloadLength + bytes.byteLength >
        MAX_SOURCE_ARCHIVE_BYTES
    ) {
      continue;
    }
    index[at] = range;
    indexLength = nextIndexLength;
    payload.push(bytes);
    payloadLength += bytes.byteLength;
  }
  if (payload.length === 0) return undefined;
  const encodedIndex = encodeUtf8(JSON.stringify(index));
  const prefix = new Uint8Array(SOURCE_ARCHIVE_PREFIX_BYTES);
  prefix.set(MAGIC);
  prefix[MAGIC.byteLength] = VERSION;
  new DataView(prefix.buffer).setUint32(MAGIC.byteLength + 1, encodedIndex.byteLength, true);
  return concatBytes([prefix, encodedIndex, ...payload]);
}

/** The bounded index length of a supported archive prefix; nothing for a corrupt prefix. */
export function sourceArchiveIndexLength(prefix: Uint8Array): number | undefined {
  if (
    prefix.byteLength !== SOURCE_ARCHIVE_PREFIX_BYTES ||
    !startsWithBytes(prefix, MAGIC) ||
    prefix[MAGIC.byteLength] !== VERSION
  ) {
    return undefined;
  }
  const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(
    MAGIC.byteLength + 1,
    true,
  );
  return length >= 2 && length <= MAX_SOURCE_ARCHIVE_INDEX_BYTES ? length : undefined;
}

function isRange(value: unknown, payloadLength: number): value is SourceArchiveRange {
  if (!Array.isArray(value) || value.length !== 2) return false;
  const offset: unknown = value[0];
  const length: unknown = value[1];
  return (
    typeof offset === 'number' &&
    typeof length === 'number' &&
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length > 0 &&
    length <= MAX_SOURCE_CONTENT_BYTES &&
    offset + length <= payloadLength
  );
}

/** The index of one map's sources, validated before any of its byte ranges is read. */
export function parseSourceArchiveIndex(
  bytes: Uint8Array,
  sourceCount: number,
  payloadLength: number,
): SourceArchiveIndex | undefined {
  if (
    bytes.byteLength > MAX_SOURCE_ARCHIVE_INDEX_BYTES ||
    !Number.isSafeInteger(sourceCount) ||
    sourceCount < 0 ||
    !Number.isSafeInteger(payloadLength) ||
    payloadLength < 0 ||
    SOURCE_ARCHIVE_PREFIX_BYTES + bytes.byteLength + payloadLength > MAX_SOURCE_ARCHIVE_BYTES
  ) {
    return undefined;
  }
  let index: unknown;
  try {
    index = JSON.parse(decodeUtf8(bytes));
  } catch {
    return undefined;
  }
  return Array.isArray(index) &&
    index.length === sourceCount &&
    index.every((range) => range === null || isRange(range, payloadLength))
    ? index
    : undefined;
}
