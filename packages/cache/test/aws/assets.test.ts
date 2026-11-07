import { NoSuchKey, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { readRetainedManifest, retainedStaticFiles } from '../../src/aws/assets.ts';

const blob = { sha256: 'a'.repeat(64), byteLength: 12, contentType: 'text/javascript' };

describe('retained immutable assets', () => {
  it('tolerates retirement after listing but fails readiness for other storage errors', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send');
    const client = new S3Client({ region: 'us-east-1' });
    try {
      send.mockRejectedValueOnce(new NoSuchKey({ $metadata: {}, message: 'retired' }));
      await expect(
        readRetainedManifest(client, 'assets', 'static-manifests/old.json'),
      ).resolves.toStrictEqual([]);
      send.mockRejectedValueOnce(new Error('S3 unavailable'));
      await expect(
        readRetainedManifest(client, 'assets', 'static-manifests/kept.json'),
      ).rejects.toThrow('S3 unavailable');
    } finally {
      send.mockRestore();
      client.destroy();
    }
  });

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
