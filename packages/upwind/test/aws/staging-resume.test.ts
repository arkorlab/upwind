import {
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { stageRecord } from '../../src/aws/lifecycle/operations.ts';
import type { AwsContext, AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import { deploymentStackName } from '../../src/aws/lifecycle/stacks.ts';
import type { DeploymentRecord } from '../../src/aws/lifecycle/state.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import type { AwsBootstrapOutputs, FargateBuildReceipt } from '../../src/aws/types.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';

const aws = awsDeploySettings({ region: 'ap-northeast-1', cache: { backend: 'dynamodb' } });
const record: DeploymentRecord = {
  v: 1,
  compute: 'fargate',
  deploymentId: 'candidate',
  stackName: deploymentStackName('shop', 'candidate'),
  createdAt: '2026-11-07T00:00:00Z',
  image: 'immutable-image',
  imageTag: 'candidate',
  archiveSha256: 'archive',
  template: JSON.stringify({
    Resources: { Service: { Type: 'AWS::ECS::Service', Properties: { DesiredCount: 2 } } },
  }),
  probeToken: 'probe',
  probePriority: 10,
  settings: aws,
  publicOrigin: 'https://app.example',
  status: 'staging',
};
const receipt = { deploymentId: 'candidate', archiveSha256: 'archive' } as FargateBuildReceipt;
const settings = { project: 'shop', aws } as DeploySettings;
const bootstrap = { ArtifactsBucket: 'bucket', ListenerArn: 'listener' } as AwsBootstrapOutputs;

function fixture(initial: 'CREATE_COMPLETE' | 'ROLLBACK_COMPLETE' | undefined) {
  let status = initial;
  let body = JSON.stringify(record);
  let etag = 1;
  const calls: string[] = [];
  const send = async (command: unknown): Promise<unknown> => {
    if (command instanceof GetObjectCommand)
      return { ETag: String(etag), Body: { transformToString: () => Promise.resolve(body) } };
    if (command instanceof PutObjectCommand) {
      body = String(command.input.Body);
      return { ETag: String(++etag) };
    }
    if (command instanceof DescribeStacksCommand) {
      if (status === undefined)
        throw Object.assign(new Error('stack does not exist'), { name: 'ValidationError' });
      return {
        Stacks: [
          {
            StackName: record.stackName,
            StackStatus: status,
            Tags: [{ Key: 'upwind:project', Value: 'shop' }],
            Outputs:
              status === 'ROLLBACK_COMPLETE'
                ? []
                : [
                    { OutputKey: 'TargetGroupArn', OutputValue: 'target' },
                    { OutputKey: 'TaskDefinitionArn', OutputValue: 'definition' },
                  ],
          },
        ],
      };
    }
    if (command instanceof CreateStackCommand) {
      calls.push('create');
      status = 'CREATE_COMPLETE';
      return {};
    }
    if (command instanceof DeleteStackCommand) {
      calls.push('delete');
      status = undefined;
      return {};
    }
    if (command instanceof UpdateStackCommand) {
      calls.push('scale');
      return {};
    }
    return { Rules: [] };
  };
  const context: AwsContext = {
    services: {
      stacks: { send },
      objects: { send },
      loadBalancer: { send },
    } as unknown as AwsServices,
    now: Date.now,
    sleep: async () => undefined,
    fetch,
  };
  return { context, calls, saved: () => JSON.parse(body) as DeploymentRecord };
}

describe('AWS staging resume', () => {
  it('recovers outputs when stack creation completed before its record was updated', async () => {
    const value = fixture('CREATE_COMPLETE');
    const resumed = await stageRecord(
      value.context,
      bootstrap,
      settings,
      receipt,
      new Map(),
      undefined,
      {},
    );
    expect(resumed.targetGroupArn).toBe('target');
    expect(resumed.taskDefinitionArn).toBe('definition');
    expect(value.saved().targetGroupArn).toBe('target');
    expect(value.calls).toStrictEqual(['scale']);
  });

  it('creates the immutable stack if a previous run stopped after saving its staging record', async () => {
    const value = fixture(undefined);
    await stageRecord(value.context, bootstrap, settings, receipt, new Map(), undefined, {});
    expect(value.saved().taskDefinitionArn).toBe('definition');
    expect(value.calls).toStrictEqual(['create', 'scale']);
  });

  it('recreates a fully rolled-back failed staging stack before recovering its outputs', async () => {
    const value = fixture('ROLLBACK_COMPLETE');
    await stageRecord(value.context, bootstrap, settings, receipt, new Map(), undefined, {});
    expect(value.saved().targetGroupArn).toBe('target');
    expect(value.calls).toStrictEqual(['delete', 'create', 'scale']);
  });
});
