import { describe, expect, it } from 'vitest';

import {
  encodeSourceArchive,
  MAX_SOURCE_ARCHIVE_BYTES,
  MAX_SOURCE_ARCHIVE_INDEX_BYTES,
  MAX_SOURCE_CONTENT_BYTES,
  parseSourceArchiveIndex,
  SOURCE_ARCHIVE_PREFIX_BYTES,
  sourceArchiveIndexLength,
} from '../src/source-archive.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Read the ranges exactly as a host reading the prefix and index separately does. */
function contentsOf(bytes: Uint8Array | undefined, sourceCount: number): (string | null)[] {
  if (bytes === undefined) throw new Error('no source archive');
  const indexLength = sourceArchiveIndexLength(bytes.subarray(0, SOURCE_ARCHIVE_PREFIX_BYTES));
  if (indexLength === undefined) throw new Error('no archive index');
  const payloadStart = SOURCE_ARCHIVE_PREFIX_BYTES + indexLength;
  const index = parseSourceArchiveIndex(
    bytes.subarray(SOURCE_ARCHIVE_PREFIX_BYTES, payloadStart),
    sourceCount,
    bytes.byteLength - payloadStart,
  );
  if (index === undefined) throw new Error('invalid archive index');
  return index.map((range) => {
    return range === null
      ? null
      : decoder.decode(bytes.subarray(payloadStart + range[0], payloadStart + range[0] + range[1]));
  });
}

describe('a private source archive', () => {
  it('keeps Unicode byte ranges aligned with missing sources and repeated contents', () => {
    const contents = [
      'const message = "日本語🙂";\r\n',
      null,
      'a\nb\n',
      'const message = "日本語🙂";\r\n',
    ];

    expect(contentsOf(encodeSourceArchive(contents), contents.length)).toStrictEqual(contents);
  });

  it('omits absent, empty and oversized contents while preserving later source indices', () => {
    const contents = [undefined, '', '界'.repeat(MAX_SOURCE_CONTENT_BYTES), 'export const ok = 1;'];

    expect(contentsOf(encodeSourceArchive(contents), contents.length)).toStrictEqual([
      null,
      null,
      null,
      'export const ok = 1;',
    ]);
    expect(encodeSourceArchive([null, undefined, ''])).toBeUndefined();
  });

  it('keeps the archive below its bound without losing source-index alignment', () => {
    const content = 'a'.repeat(MAX_SOURCE_CONTENT_BYTES);
    const bytes = encodeSourceArchive(Array.from({ length: 27 }, () => content));
    const contents = contentsOf(bytes, 27);

    expect(bytes?.byteLength).toBeLessThanOrEqual(MAX_SOURCE_ARCHIVE_BYTES);
    expect(contents.slice(0, 24)).toStrictEqual(Array.from({ length: 24 }, () => content));
    expect(contents.slice(24)).toStrictEqual([null, null, null]);
  });

  it('does not allocate an index too large to be read', () => {
    const contents = Array.from({ length: Math.floor(MAX_SOURCE_ARCHIVE_INDEX_BYTES / 5) + 1 });

    expect(encodeSourceArchive(contents)).toBeUndefined();
  });

  it('refuses an unsupported, truncated or oversized prefix', () => {
    const prefix = new Uint8Array([85, 80, 83, 67, 1, 2, 0, 0, 0]);
    const unsupported = new Uint8Array(prefix);
    unsupported[4] = 2;
    const oversized = new Uint8Array(prefix);
    new DataView(oversized.buffer).setUint32(5, MAX_SOURCE_ARCHIVE_INDEX_BYTES + 1, true);

    expect(sourceArchiveIndexLength(prefix)).toBe(2);
    expect(sourceArchiveIndexLength(unsupported)).toBeUndefined();
    expect(sourceArchiveIndexLength(prefix.subarray(1))).toBeUndefined();
    expect(sourceArchiveIndexLength(oversized)).toBeUndefined();
  });

  it.each(['not JSON', '{}', '[[0,2]]', '[[0,-1],null]', '[[0,1.5],null]', '[[2,2],null]'])(
    'refuses an index with invalid shape or ranges: %s',
    (text) => {
      expect(parseSourceArchiveIndex(encoder.encode(text), 2, 3)).toBeUndefined();
    },
  );

  it('refuses an oversized index and a source range larger than its individual bound', () => {
    const oversizedRange = encoder.encode(`[[0,${String(MAX_SOURCE_CONTENT_BYTES + 1)}]]`);

    expect(
      parseSourceArchiveIndex(new Uint8Array(MAX_SOURCE_ARCHIVE_INDEX_BYTES + 1), 0, 0),
    ).toBeUndefined();
    expect(
      parseSourceArchiveIndex(
        oversizedRange,
        1,
        MAX_SOURCE_CONTENT_BYTES + 1,
      ),
    ).toBeUndefined();
  });
});
