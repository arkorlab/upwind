import { beforeEach, describe, expect, test, vi } from 'vitest';

import { S3Objects } from '../../src/aws/objects.ts';

const fake = vi.hoisted(() => ({ send: vi.fn<() => Promise<unknown>>(), destroy: vi.fn() }));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = fake.send;
    destroy = fake.destroy;
  },
  GetObjectCommand: class {},
  PutObjectCommand: class {},
  DeleteObjectsCommand: class {},
  ListObjectsV2Command: class {},
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AWS immutable object validation', () => {
  test.each(['reject', 'throw'])(
    'preserves a length mismatch when body cancellation will %s',
    async (mode) => {
      const cancel = vi.fn(() => {
        const failure = new Error('body disposal failed');
        if (mode === 'throw') throw failure;
        return Promise.reject(failure);
      });
      fake.send.mockResolvedValueOnce({
        ContentLength: 5,
        Body: { transformToWebStream: () => ({ cancel }) },
      });
      const objects = new S3Objects('us-east-1', 'bucket', 'scope');
      try {
        await expect(
          objects.read({
            key: 'aws-cache/scope/blobs/content',
            sha256: 'a'.repeat(64),
            byteLength: 4,
          }),
        ).rejects.toThrow('AWS cache object length differs from its reference');
        expect(cancel).toHaveBeenCalledOnce();
      } finally {
        objects.close();
      }
    },
  );
});
