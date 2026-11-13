import { DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { runAwsDeployments } from '../../src/aws/lifecycle/index.ts';
import type { AwsServices } from '../../src/aws/lifecycle/sdk.ts';
import { STATE_KEY } from '../../src/aws/lifecycle/state.ts';
import { awsDeploySettings } from '../../src/aws/settings.ts';
import type { DeploySettings } from '../../src/deploy/config.ts';

const keys = [
  'ArtifactsBucket',
  'RepositoryUri',
  'RepositoryName',
  'ClusterArn',
  'ListenerArn',
  'VpcId',
  'TaskSubnetIds',
  'TaskSecurityGroupId',
  'ExecutionRoleArn',
  'TaskRoleArn',
  'LogGroupName',
  'PublicOrigin',
];

describe('AWS deployment listing after cleanup', () => {
  it('labels a deleted deployment as deleted even when its retirement checkpoint is present', async () => {
    const aws = awsDeploySettings({ region: 'ap-northeast-1', cache: { backend: 'dynamodb' } });
    const record = {
      v: 1,
      compute: 'fargate',
      deploymentId: 'deleted-candidate',
      createdAt: new Date(0).toISOString(),
      status: 'deleted',
      cacheRetired: true,
      retiring: true,
    };
    const send = async (command: unknown): Promise<unknown> => {
      if (command instanceof DescribeStacksCommand)
        return {
          Stacks: [
            {
              StackStatus: 'CREATE_COMPLETE',
              Tags: [{ Key: 'upwind:project', Value: 'shop' }],
              Outputs: keys.map((OutputKey) => ({ OutputKey, OutputValue: OutputKey })),
            },
          ],
        };
      if (command instanceof ListObjectsV2Command)
        return { Contents: [{ Key: 'upwind/deployments/deleted-candidate.json' }] };
      if (command instanceof GetObjectCommand) {
        if (command.input.Key === STATE_KEY)
          throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
        return {
          ETag: 'record',
          Body: { transformToString: () => Promise.resolve(JSON.stringify(record)) },
        };
      }
      return { Rules: [] };
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runAwsDeployments(
        { projectDir: '/app' },
        { project: 'shop', aws } as DeploySettings,
        undefined,
        {
          services: {
            stacks: { send },
            loadBalancer: { send },
            objects: { send },
          } as unknown as AwsServices,
        },
      );
      expect(log).toHaveBeenCalledWith(expect.stringMatching(/deleted-candidate\s+deleted\s/u));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining('retiring'));
    } finally {
      vi.restoreAllMocks();
    }
  });
});
