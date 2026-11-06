import {
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import { BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import { RunTaskCommand, DescribeTasksCommand } from '@aws-sdk/client-ecs';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { retain } from '../../src/aws/lifecycle/operations.ts';
import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import { deploymentStackName } from '../../src/aws/lifecycle/stacks.ts';
import { recordKey, type DeploymentRecord } from '../../src/aws/lifecycle/state.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import type { AwsBootstrapOutputs } from '../../src/aws/types.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';

const aws = awsDeploySettings({ region: 'ap-northeast-1', cache: { backend: 'dynamodb' } });
const settings = { project: 'shop', keep: 0, aws } as DeploySettings;

function fixture(hasTaskDefinition: boolean, failImageOnce = false) {
  const record: DeploymentRecord = {
    v: 1,
    compute: 'fargate',
    deploymentId: 'failed-candidate',
    stackName: deploymentStackName('shop', 'failed-candidate'),
    createdAt: new Date(0).toISOString(),
    image: 'image',
    imageTag: 'failed-candidate',
    archiveSha256: 'archive',
    template: JSON.stringify({
      Resources: { Service: { Type: 'AWS::ECS::Service', Properties: { DesiredCount: 2 } } },
    }),
    probeToken: 'probe',
    probePriority: 10,
    settings: aws,
    publicOrigin: 'https://app.example',
    targetGroupArn: 'target',
    status: 'staging',
    ...(hasTaskDefinition ? { taskDefinitionArn: 'definition' } : {}),
  };
  let body = JSON.stringify(record);
  let deleted = false;
  const calls: string[] = [];
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof ListObjectsV2Command)
      return { Contents: [{ Key: recordKey(record.deploymentId) }] };
    if (command instanceof GetObjectCommand)
      return { ETag: 'record', Body: { transformToString: () => Promise.resolve(body) } };
    if (command instanceof PutObjectCommand) {
      body = String(command.input.Body);
      return { ETag: 'updated' };
    }
    if (command instanceof DescribeStacksCommand) {
      if (deleted)
        throw Object.assign(new Error('stack does not exist'), { name: 'ValidationError' });
      return {
        Stacks: [
          {
            StackName: record.stackName,
            StackStatus: 'CREATE_COMPLETE',
            Tags: [{ Key: 'upwind:project', Value: 'shop' }],
            Outputs: [],
          },
        ],
      };
    }
    if (command instanceof ListStackResourcesCommand) return { StackResourceSummaries: [] };
    if (command instanceof UpdateStackCommand) {
      calls.push('drain');
      return {};
    }
    if (command instanceof RunTaskCommand) {
      calls.push('retire');
      return { tasks: [{ taskArn: 'retirement' }] };
    }
    if (command instanceof DescribeTasksCommand)
      return { tasks: [{ lastStatus: 'STOPPED', containers: [{ name: 'app', exitCode: 0 }] }] };
    if (command instanceof DeleteStackCommand) {
      calls.push('delete-stack');
      deleted = true;
      return {};
    }
    if (command instanceof BatchDeleteImageCommand) {
      calls.push('delete-image');
      if (failImageOnce) {
        failImageOnce = false;
        throw Object.assign(new Error('temporary image deletion failure'), {
          $metadata: { httpStatusCode: 400 },
        });
      }
      return {};
    }
    return { Rules: [] };
  };
  const context: AwsContext = {
    services: {
      objects: { send },
      stacks: { send },
      ecs: { send },
      ecr: { send },
      loadBalancer: { send },
    } as unknown as AwsServices,
    fetch,
    now: () => 7_200_000,
    sleep: async () => undefined,
  };
  return { context, calls, saved: () => JSON.parse(body) as DeploymentRecord };
}

describe('AWS failed-candidate cache retirement', () => {
  it('drains and retires an initialized staging cache before deleting the stack or image', async () => {
    const value = fixture(true);
    await retain(
      value.context,
      {
        ArtifactsBucket: 'bucket',
        ListenerArn: 'listener',
        ClusterArn: 'cluster',
        TaskSubnetIds: 'subnet-a,subnet-b',
        TaskSecurityGroupId: 'security',
        RepositoryName: 'images',
      } as AwsBootstrapOutputs,
      settings,
      'current',
      { assertHeld: async () => undefined },
    );
    expect(value.calls).toStrictEqual(['drain', 'retire', 'delete-stack', 'delete-image']);
    expect(value.saved().status).toBe('deleted');
  });

  it('resumes cleanup after stack deletion without running a deregistered retirement task again', async () => {
    const value = fixture(true, true);
    const bootstrap = {
      ArtifactsBucket: 'bucket',
      ListenerArn: 'listener',
      ClusterArn: 'cluster',
      TaskSubnetIds: 'subnet-a,subnet-b',
      TaskSecurityGroupId: 'security',
      RepositoryName: 'images',
    } as AwsBootstrapOutputs;
    const lock = { assertHeld: async () => undefined };
    await expect(retain(value.context, bootstrap, settings, 'current', lock)).rejects.toThrow(
      'temporary image deletion failure',
    );
    expect(value.saved().cacheRetired).toBe(true);
    await retain(value.context, bootstrap, { ...settings, keep: 5 }, 'current', lock);
    expect(value.calls.filter((call) => call === 'retire')).toHaveLength(1);
    expect(value.calls.filter((call) => call === 'delete-stack')).toHaveLength(1);
    expect(value.saved().status).toBe('deleted');
  });

  it('retains the build and reports an explicit cleanup failure if the retirement task definition cannot be recovered', async () => {
    const value = fixture(false);
    await expect(
      retain(
        value.context,
        { ArtifactsBucket: 'bucket', ListenerArn: 'listener' } as AwsBootstrapOutputs,
        settings,
        'current',
        { assertHeld: async () => undefined },
      ),
    ).rejects.toThrow('no retained task definition');
    expect(value.calls).toStrictEqual([]);
    expect(value.saved().status).toBe('staging');
  });
});
