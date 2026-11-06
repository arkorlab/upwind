import { describe, expect, it } from 'vitest';

import { retainedStaticFiles } from '../../src/aws/assets.ts';

const blob = { sha256: 'a'.repeat(64), byteLength: 12, contentType: 'text/javascript' };

describe('retained immutable assets', () => {
  it('preserves a basePath while requiring Next.js immutable files', () => {
    const files = [{ pathname: '/shop/_next/static/chunks/a.js', immutable: true, blob }];
    expect(retainedStaticFiles({ v: 1, files })).toStrictEqual(files);
  });

  it('does not admit public files, mutable files, or path traversal into the native router', () => {
    for (const pathname of [
      '/private.json',
      '/_next/static/../secret',
      '/_next/static/a.js?token=1',
    ]) {
      expect(() =>
        retainedStaticFiles({ v: 1, files: [{ pathname, immutable: true, blob }] }),
      ).toThrow('immutable');
    }
    expect(() =>
      retainedStaticFiles({
        v: 1,
        files: [{ pathname: '/_next/static/a.js', immutable: false, blob }],
      }),
    ).toThrow('immutable');
  });
});
