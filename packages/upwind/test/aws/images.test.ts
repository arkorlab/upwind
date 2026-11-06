import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { uploadStatic } from '../../src/aws/lifecycle/images.ts';
import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import type { FargateBuildReceipt } from '../../src/aws/types.ts';

const RECEIPT: FargateBuildReceipt = {
  compute: 'fargate',
  format: 'upwind-fargate',
  version: 1,
  deploymentId: 'deployment',
  upwind: '0.4.0',
  builtAt: '2026-11-07T00:00:00Z',
  platform: 'linux/amd64',
  imageId: 'image',
  baseImageDigest: 'base',
  nodeVersion: '26.13.0',
  nodeAbi: '147',
  archivePath: '/image.tar',
  archiveSha256: 'archive',
  nativeDirectory: '/native',
  nativeSha256: 'native',
  staticFiles: [],
  safeStaticBypass: false,
};

function fixture(existing?: string) {
  const bodies = new Map<string, string>();
  const key = 'static-manifests/deployment.json';
  if (existing !== undefined) bodies.set(key, existing);
  let writes = 0;
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof PutObjectCommand) {
      const path = command.input.Key ?? '';
      if (bodies.has(path))
        throw Object.assign(new Error('already exists'), {
          name: 'PreconditionFailed',
          $metadata: { httpStatusCode: 412 },
        });
      bodies.set(path, String(command.input.Body));
      writes += 1;
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const body = bodies.get(command.input.Key ?? '');
      if (body === undefined) throw new Error('missing manifest');
      return {
        ContentLength: Buffer.byteLength(body),
        Body: { transformToString: () => Promise.resolve(body) },
      };
    }
    throw new Error('unexpected object operation');
  };
  const context: AwsContext = {
    services: { objects: { send } } as unknown as AwsServices,
    fetch,
    now: Date.now,
    sleep: async () => undefined,
  };
  return { context, bodies, key, writes: () => writes };
}

describe('AWS immutable static manifest publication', () => {
  it('resumes after a manifest was uploaded before the deployment record was saved', async () => {
    const value = fixture();
    await uploadStatic(value.context, 'bucket', RECEIPT);
    await uploadStatic(value.context, 'bucket', RECEIPT);
    expect(value.writes()).toBe(1);
    expect(value.bodies.get(value.key)).toBe(JSON.stringify({ v: 1, files: [] }));
  });

  it('refuses different content under the same deployment ID without overwriting it', async () => {
    const held = JSON.stringify({ v: 1, files: [{ pathname: '/_next/static/other.js' }] });
    const value = fixture(held);
    await expect(uploadStatic(value.context, 'bucket', RECEIPT)).rejects.toThrow(
      'different immutable static manifest',
    );
    expect(value.bodies.get(value.key)).toBe(held);
    expect(value.writes()).toBe(0);
  });
});
