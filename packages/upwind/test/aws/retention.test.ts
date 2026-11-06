import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import { BatchDeleteImageCommand } from '@aws-sdk/client-ecr';
import {
  RunTaskCommand,
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
} from '@aws-sdk/client-ecs';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { retain } from '../../src/aws/lifecycle/operations.ts';
import {
  type AwsContext,
  type AwsServices,
  UncertainAwsMutation,
} from '../../src/aws/lifecycle/sdk.ts';
import { deploymentStackName } from '../../src/aws/lifecycle/stacks.ts';
import { recordKey, type DeploymentRecord } from '../../src/aws/lifecycle/state.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import type { AwsBootstrapOutputs } from '../../src/aws/types.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';

const aws = awsDeploySettings({ region: 'ap-northeast-1', cache: { backend: 'dynamodb' } });
const settings = { project: 'shop', keep: 0, aws } as DeploySettings;
const bootstrap = {
  ArtifactsBucket: 'bucket',
  ListenerArn: 'listener',
  ClusterArn: 'cluster',
  TaskSubnetIds: 'subnet-a,subnet-b',
  TaskSecurityGroupId: 'security',
  RepositoryName: 'images',
} as AwsBootstrapOutputs;
const lock = { assertHeld: async () => undefined };

function candidate(id: string, taskDefinition = true): DeploymentRecord {
  return {
    v: 1,
    compute: 'fargate',
    deploymentId: id,
    stackName: deploymentStackName('shop', id),
    createdAt: new Date(0).toISOString(),
    image: 'image',
    imageTag: id,
    archiveSha256: 'archive',
    template: JSON.stringify({
      Resources: {
        Service: { Type: 'AWS::ECS::Service', Properties: { DesiredCount: 2 } },
        TaskDefinition: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            Family: 'shop',
            ContainerDefinitions: [
              {
                Name: 'app',
                Image: 'image',
                Secrets: [{ Name: 'AUTH_SECRET', ValueFrom: 'application-secret' }],
              },
            ],
          },
        },
      },
    }),
    probeToken: 'probe',
    probePriority: 10,
    settings: aws,
    publicOrigin: 'https://app.example',
    targetGroupArn: `target-${id}`,
    status: 'staging',
    ...(taskDefinition ? { taskDefinitionArn: 'definition' } : {}),
  };
}

function fixture(
  initial: DeploymentRecord[],
  options: {
    failImageOnce?: boolean;
    missingAppStack?: boolean;
    uncertainRetirement?: boolean;
  } = {},
) {
  const values = new Map(
    initial.map((record) => [recordKey(record.deploymentId), JSON.stringify(record)]),
  );
  const stacks = new Map<string, string>();
  if (!options.missingAppStack)
    for (const record of initial) stacks.set(record.stackName, 'definition');
  let failImage = options.failImageOnce === true;
  const calls: string[] = [];
  const deletedImages: string[] = [];
  let recoveredTemplate: string | undefined;
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof ListObjectsV2Command)
      return { Contents: [...values.keys()].map((Key) => ({ Key })) };
    if (command instanceof GetObjectCommand)
      return {
        ETag: 'record',
        Body: {
          transformToString: () => Promise.resolve(values.get(command.input.Key ?? '') ?? ''),
        },
      };
    if (command instanceof PutObjectCommand) {
      values.set(command.input.Key ?? '', String(command.input.Body));
      return { ETag: 'updated' };
    }
    if (command instanceof DescribeStacksCommand) {
      const name = command.input.StackName ?? '';
      const task = stacks.get(name);
      if (task === undefined)
        throw Object.assign(new Error('stack does not exist'), { name: 'ValidationError' });
      return {
        Stacks: [
          {
            StackName: name,
            StackStatus: 'CREATE_COMPLETE',
            Tags: [{ Key: 'upwind:project', Value: 'shop' }],
            Outputs: [{ OutputKey: 'TaskDefinitionArn', OutputValue: task }],
          },
        ],
      };
    }
    if (command instanceof ListStackResourcesCommand) return { StackResourceSummaries: [] };
    if (command instanceof UpdateStackCommand) {
      calls.push('drain');
      return {};
    }
    if (command instanceof CreateStackCommand) {
      calls.push('recover-definition');
      stacks.set(command.input.StackName ?? '', 'recovered-definition');
      recoveredTemplate = command.input.TemplateBody;
      return {};
    }
    if (command instanceof DescribeTaskDefinitionCommand)
      return { taskDefinition: { status: 'ACTIVE' } };
    if (command instanceof RunTaskCommand) {
      calls.push(`retire:${command.input.taskDefinition}`);
      if (options.uncertainRetirement) throw new Error('retirement response was lost');
      return { tasks: [{ taskArn: 'retirement' }] };
    }
    if (command instanceof DescribeTasksCommand)
      return { tasks: [{ lastStatus: 'STOPPED', containers: [{ name: 'app', exitCode: 0 }] }] };
    if (command instanceof DeleteStackCommand) {
      const name = command.input.StackName ?? '';
      calls.push(name.endsWith('-cache-retire') ? 'delete-definition' : 'delete-stack');
      stacks.delete(name);
      return {};
    }
    if (command instanceof BatchDeleteImageCommand) {
      calls.push('delete-image');
      if (failImage) {
        failImage = false;
        throw Object.assign(new Error('temporary image deletion failure'), {
          $metadata: { httpStatusCode: 400 },
        });
      }
      deletedImages.push(command.input.imageIds?.[0]?.imageTag ?? '');
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
  return {
    context,
    calls,
    deletedImages,
    saved: (id = initial[0]?.deploymentId ?? '') =>
      JSON.parse(values.get(recordKey(id)) ?? '{}') as DeploymentRecord,
    recoveredTemplate: () =>
      JSON.parse(recoveredTemplate ?? '{}') as {
        Resources: Record<string, { Properties: { ContainerDefinitions: unknown[] } }>;
      },
  };
}

describe('AWS failed-candidate cache retirement', () => {
  it('drains and retires an initialized staging cache before deleting the stack or image', async () => {
    const value = fixture([candidate('failed-candidate')]);
    await retain(value.context, bootstrap, settings, 'current', lock);
    expect(value.calls).toStrictEqual([
      'drain',
      'retire:definition',
      'delete-stack',
      'delete-image',
    ]);
    expect(value.saved().status).toBe('deleted');
  });

  it('resumes cleanup after stack deletion without running a deregistered retirement task again', async () => {
    const value = fixture([candidate('failed-candidate')], { failImageOnce: true });
    await expect(retain(value.context, bootstrap, settings, 'current', lock)).rejects.toThrow(
      'temporary image deletion failure',
    );
    expect(value.saved().cacheRetired).toBe(true);
    await retain(value.context, bootstrap, { ...settings, keep: 5 }, 'current', lock);
    expect(value.calls.filter((call) => call.startsWith('retire:'))).toHaveLength(1);
    expect(value.calls.filter((call) => call === 'delete-stack')).toHaveLength(1);
    expect(value.saved().status).toBe('deleted');
  });

  it('recovers a definition-only retirement job for a candidate whose app stack never started', async () => {
    const value = fixture([candidate('never-started', false)], { missingAppStack: true });
    await retain(value.context, bootstrap, settings, 'current', lock);
    expect(value.calls).toStrictEqual([
      'recover-definition',
      'retire:recovered-definition',
      'delete-definition',
      'delete-image',
    ]);
    expect(Object.keys(value.recoveredTemplate().Resources)).toStrictEqual([
      'RetirementTaskDefinition',
    ]);
    expect(
      value.recoveredTemplate().Resources['RetirementTaskDefinition']?.Properties
        .ContainerDefinitions,
    ).toStrictEqual([
      {
        Name: 'app',
        Image: 'image',
        Secrets: [{ Name: 'AUTH_SECRET', ValueFrom: 'application-secret' }],
      },
    ]);
    expect(value.saved().cacheRetired).toBe(true);
    expect(value.saved().status).toBe('deleted');
  });

  it('aborts immediately if a retirement mutation has an uncertain outcome', async () => {
    const value = fixture([candidate('uncertain'), candidate('other')], {
      uncertainRetirement: true,
    });
    await expect(
      retain(value.context, bootstrap, settings, 'current', lock),
    ).rejects.toBeInstanceOf(UncertainAwsMutation);
    expect(value.saved('other').retiring).not.toBe(true);
    expect(value.deletedImages).toStrictEqual([]);
  });

  it('continues cleaning unrelated records after a known per-record recovery failure', async () => {
    const broken = { ...candidate('broken', false), template: '{}' };
    const value = fixture([broken, candidate('other')], { missingAppStack: true });
    await expect(retain(value.context, bootstrap, settings, 'current', lock)).rejects.toThrow(
      'recorded task definition is missing',
    );
    expect(value.saved('broken').status).toBe('staging');
    expect(value.saved('other').status).toBe('deleted');
    expect(value.deletedImages).toStrictEqual(['other']);
  });
});
