import {
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  ListStacksCommand,
} from '@aws-sdk/client-cloudformation';
import { ListImagesCommand } from '@aws-sdk/client-ecr';
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketTaggingCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  ListBucketsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { ListSecretsCommand } from '@aws-sdk/client-secrets-manager';
import { describe, expect, it, vi } from 'vitest';

import { runAwsDestroy } from '../../src/aws/lifecycle/destroy.ts';
import type { AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';

function fixture(bucketPresent: boolean) {
  const objects = new Map<string, { body: string; etag: string }>();
  let version = 0;
  let stackDeleted = false;
  const calls: string[] = [];
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof DescribeStacksCommand) {
      if (stackDeleted)
        throw Object.assign(new Error('stack does not exist'), { name: 'ValidationError' });
      return {
        Stacks: [
          {
            StackName: 'upwind-shop',
            StackId: 'bootstrap-id',
            StackStatus: 'ROLLBACK_COMPLETE',
            Tags: [{ Key: 'upwind:project', Value: 'shop' }],
            Outputs: [],
          },
        ],
      };
    }
    if (command instanceof ListStackResourcesCommand)
      return {
        StackResourceSummaries: [
          {
            LogicalResourceId: 'Repository',
            ResourceType: 'AWS::ECR::Repository',
            PhysicalResourceId: 'images',
            ResourceStatus: 'CREATE_COMPLETE',
          },
          ...(bucketPresent
            ? [
                {
                  LogicalResourceId: 'Artifacts',
                  ResourceType: 'AWS::S3::Bucket',
                  PhysicalResourceId: 'artifacts',
                  ResourceStatus: 'DELETE_SKIPPED',
                },
              ]
            : []),
        ],
      };
    if (command instanceof ListStacksCommand) return { StackSummaries: [] };
    if (command instanceof DeleteStackCommand) {
      stackDeleted = true;
      calls.push('delete-stack');
      return {};
    }
    if (command instanceof ListImagesCommand) {
      calls.push('empty-images');
      return { imageIds: [] };
    }
    if (command instanceof ListSecretsCommand) return { SecretList: [] };
    if (command instanceof GetBucketTaggingCommand)
      return { TagSet: [{ Key: 'upwind:project', Value: 'shop' }] };
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key ?? '');
      if (object === undefined) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { ETag: object.etag, Body: { transformToString: () => Promise.resolve(object.body) } };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? '';
      const etag = String(++version);
      objects.set(key, { body: String(command.input.Body), etag });
      return { ETag: etag };
    }
    if (command instanceof ListObjectsV2Command)
      return {
        Contents:
          command.input.Prefix === undefined ? [...objects.keys()].map((Key) => ({ Key })) : [],
      };
    if (command instanceof DeleteObjectsCommand) {
      for (const key of command.input.Delete?.Objects ?? []) objects.delete(key.Key ?? '');
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      objects.delete(command.input.Key ?? '');
      return {};
    }
    if (command instanceof DeleteBucketCommand) {
      if (objects.size !== 0) throw new Error('bucket is not empty');
      calls.push('delete-bucket');
      return {};
    }
    throw new Error('unexpected AWS operation');
  };
  return {
    services: {
      stacks: { send },
      ecr: { send },
      secrets: { send },
      objects: { send },
    } as unknown as AwsServices,
    calls,
  };
}

const settings = {
  project: 'shop',
  aws: awsDeploySettings({ region: 'ap-northeast-1', cache: { backend: 'dynamodb' } }),
} as DeploySettings;

describe('destroying an incomplete AWS bootstrap', () => {
  it('skips an untagged bucket with a matching name prefix when looking for retained owned buckets', async () => {
    const calls: string[] = [];
    const send = async (command: unknown): Promise<unknown> => {
      if (command instanceof DescribeStacksCommand)
        throw Object.assign(new Error('stack does not exist'), { name: 'ValidationError' });
      if (command instanceof ListBucketsCommand) {
        calls.push('list');
        return { Buckets: [{ Name: 'upwind-shop-artifacts-unowned' }] };
      }
      if (command instanceof GetBucketTaggingCommand) {
        calls.push('tags');
        throw Object.assign(new Error('no tags'), {
          name: 'NoSuchTagSet',
          $metadata: { httpStatusCode: 404 },
        });
      }
      throw new Error('unexpected bucket mutation');
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await expect(
        runAwsDestroy(
          { projectDir: '/app', yes: true, includeStorage: false },
          settings,
          undefined,
          { services: { stacks: { send }, objects: { send } } as unknown as AwsServices },
        ),
      ).resolves.toBe(0);
      expect(calls).toStrictEqual(['list', 'tags']);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([true, false])(
    'cleans the owned failed stack even without bootstrap outputs (bucket exists: %s)',
    async (bucketPresent) => {
      const value = fixture(bucketPresent);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await expect(
          runAwsDestroy(
            { projectDir: '/app', yes: true, includeStorage: false },
            settings,
            undefined,
            { services: value.services },
          ),
        ).resolves.toBe(0);
        expect(value.calls).toStrictEqual([
          'empty-images',
          'delete-stack',
          ...(bucketPresent ? ['delete-bucket'] : []),
        ]);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});
