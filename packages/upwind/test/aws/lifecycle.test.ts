import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { activateRecord } from '../../src/aws/lifecycle/operations.ts';
import {
  type AwsContext,
  type AwsServices,
  UncertainAwsMutation,
} from '../../src/aws/lifecycle/sdk.ts';
import { LOCK_KEY, STATE_KEY, withProjectLock } from '../../src/aws/lifecycle/state.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import type { AwsBootstrapOutputs } from '../../src/aws/types.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';

function failure(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

function memoryContext() {
  const objects = new Map<string, { body: string; etag: string }>();
  const calls: string[] = [];
  let version = 0;
  let now = 0;
  const send = vi.fn(async (command: unknown): Promise<unknown> => {
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key ?? '');
      if (object === undefined) throw failure('NoSuchKey', 404);
      return { ETag: object.etag, Body: { transformToString: () => Promise.resolve(object.body) } };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? '';
      const old = objects.get(key);
      if (
        (command.input.IfNoneMatch === '*' && old !== undefined) ||
        (command.input.IfMatch !== undefined && command.input.IfMatch !== old?.etag)
      )
        throw failure('PreconditionFailed', 412);
      const etag = String(++version);
      objects.set(key, { body: String(command.input.Body), etag });
      calls.push(`put:${key}`);
      return { ETag: etag };
    }
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key ?? '';
      if (command.input.IfMatch !== objects.get(key)?.etag)
        throw failure('PreconditionFailed', 412);
      objects.delete(key);
      calls.push(`delete:${key}`);
      return {};
    }
    throw new Error('unexpected storage operation');
  });
  const services = { objects: { send } } as unknown as AwsServices;
  const context: AwsContext = {
    services,
    now: () => now,
    sleep: async (milliseconds) => {
      now += milliseconds;
    },
    fetch: vi.fn<typeof fetch>(),
  };
  return { context, objects, calls };
}

describe('AWS deployment exclusion and failed activation', () => {
  it('rejects overlapping deploys and releases only its own lock', async () => {
    const fixture = memoryContext();
    await withProjectLock(fixture.context, 'bucket', async (lock) => {
      await expect(
        withProjectLock(fixture.context, 'bucket', async () => undefined),
      ).rejects.toThrow('another operation owns');
      await expect(lock.assertHeld()).resolves.toBeUndefined();
    });
    expect(fixture.objects.has(LOCK_KEY)).toBe(false);
    expect(fixture.calls.filter((call) => call === `delete:${LOCK_KEY}`)).toHaveLength(1);
  });

  it('preserves exclusion when a provider mutation may still be running', async () => {
    const fixture = memoryContext();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(
        withProjectLock(fixture.context, 'bucket', async () => {
          throw new UncertainAwsMutation('create service', new Error('connection lost'));
        }),
      ).rejects.toThrow('uncertain outcome');
      expect(fixture.objects.has(LOCK_KEY)).toBe(true);
      expect(fixture.calls).not.toContain(`delete:${LOCK_KEY}`);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not acquire a deploy lock against a project marked for destruction', async () => {
    const fixture = memoryContext();
    fixture.objects.set(STATE_KEY, {
      body: JSON.stringify({ v: 1, destroying: true }),
      etag: 'control',
    });
    await expect(withProjectLock(fixture.context, 'bucket', async () => undefined)).rejects.toThrow(
      'being destroyed',
    );
    expect(fixture.calls).toStrictEqual([]);
  });

  it('fails candidate identity checks before production routing or previous tasks change', async () => {
    const fixture = memoryContext();
    const loadBalancer = vi.fn(async () => ({
      TargetHealthDescriptions: [
        { TargetHealth: { State: 'healthy' } },
        { TargetHealth: { State: 'healthy' } },
      ],
    }));
    const context: AwsContext = {
      ...fixture.context,
      services: {
        ...fixture.context.services,
        loadBalancer: { send: loadBalancer },
      } as unknown as AwsServices,
      fetch: vi
        .fn<typeof fetch>()
        .mockImplementation(async () =>
          Response.json({ ready: true, deploymentId: 'other-deployment' }),
        ),
    };
    const aws = awsDeploySettings({ region: 'ap-northeast-1', cache: { backend: 'dynamodb' } });
    const settings = { project: 'shop', checks: ['/'], aws } as DeploySettings;
    await expect(
      activateRecord(
        context,
        { ArtifactsBucket: 'bucket' } as AwsBootstrapOutputs,
        settings,
        {
          v: 1,
          compute: 'fargate',
          deploymentId: 'candidate',
          stackName: 'candidate-stack',
          createdAt: '2026-11-07T00:00:00Z',
          image: 'image',
          imageTag: 'candidate',
          archiveSha256: 'archive',
          template: '{}',
          probeToken: 'probe',
          probePriority: 10,
          settings: aws,
          publicOrigin: 'https://app.example',
          targetGroupArn: 'candidate-target',
          status: 'staging',
        },
        { v: 1, current: 'previous' },
        { assertHeld: async () => undefined },
      ),
    ).rejects.toThrow('failed readiness');
    expect(loadBalancer).toHaveBeenCalledTimes(1);
    expect(fixture.calls).toStrictEqual([]);
  });
});
