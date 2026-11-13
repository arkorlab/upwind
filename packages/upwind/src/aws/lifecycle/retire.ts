import { randomUUID } from 'node:crypto';

import { DescribeTasksCommand, RunTaskCommand } from '@aws-sdk/client-ecs';

import type { AwsBootstrapOutputs } from '../types.ts';
import { mutation, type AwsContext, UncertainAwsMutation } from './sdk.ts';
import type { DeploymentRecord } from './state.ts';

/** The cache is private to the VPC; retirement executes with the same scoped task role. */
export async function retireCache(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  record: DeploymentRecord,
): Promise<void> {
  if (record.taskDefinitionArn === undefined)
    throw new Error('deployment has no task definition for cache retirement');
  const run = await mutation('start cache retirement task', () =>
    context.services.ecs.send(
      new RunTaskCommand({
        cluster: bootstrap.ClusterArn,
        taskDefinition: record.taskDefinitionArn,
        launchType: 'FARGATE',
        count: 1,
        clientToken: randomUUID(),
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: bootstrap.TaskSubnetIds.split(','),
            securityGroups: [bootstrap.TaskSecurityGroupId],
            assignPublicIp: 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [
            { name: 'app', environment: [{ name: 'UPWIND_AWS_CACHE_RETIRE', value: '1' }] },
          ],
        },
        tags: [{ key: 'upwind:deployment', value: record.deploymentId }],
      }),
    ),
  );
  const arn = run.tasks?.[0]?.taskArn;
  if (arn === undefined || (run.failures?.length ?? 0) > 0)
    throw new Error('ECS could not start the cache retirement task');
  const deadline = context.now() + 900_000;
  while (context.now() < deadline) {
    const status = await context.services.ecs.send(
      new DescribeTasksCommand({ cluster: bootstrap.ClusterArn, tasks: [arn] }),
    );
    const task = status.tasks?.[0];
    if (task?.lastStatus === 'STOPPED') {
      if (task.containers?.find((container) => container.name === 'app')?.exitCode !== 0)
        throw new Error(
          `cache retirement failed for ${record.deploymentId}; the deployment stack was retained`,
        );
      return;
    }
    await context.sleep(5000);
  }
  throw new UncertainAwsMutation(`cache retirement task ${arn} is still running`, undefined);
}
