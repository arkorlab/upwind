import { DescribeTaskDefinitionCommand } from '@aws-sdk/client-ecs';

import type { DeploySettings } from '../../deploy/config.ts';
import type { AwsBootstrapOutputs } from '../types.ts';
import { deleteStaticManifest } from './asset-retention.ts';
import { deleteImage } from './images.ts';
import { retireCache } from './retire.ts';
import { productionRule, targetOf } from './routes.ts';
import { errorCode, type AwsContext, UncertainAwsMutation } from './sdk.ts';
import { deleteSecret } from './secrets.ts';
import {
  createStack,
  deleteStack,
  deploymentStackName,
  outputs,
  owned,
  scaleDeployment,
  stack,
  stackResources,
  waitStack,
} from './stacks.ts';
import { records, saveRecord, type DeploymentRecord, type ProjectLock } from './state.ts';

const ORPHAN_AGE_MS = 3_600_000;

async function activeTaskDefinition(context: AwsContext, arn: string): Promise<boolean> {
  try {
    const result = await context.services.ecs.send(
      new DescribeTaskDefinitionCommand({ taskDefinition: arn }),
    );
    return result.taskDefinition?.status === 'ACTIVE';
  } catch (error) {
    if (errorCode(error) === 'ClientException') return false;
    throw error;
  }
}

/** A definition-only stack recovers a cleanup job without ever recreating an app service. */
export function retirementTemplate(record: DeploymentRecord): string {
  const template = JSON.parse(record.template) as {
    Resources?: Record<string, { Type?: unknown; Properties?: Record<string, unknown> }>;
  };
  const definition = template.Resources?.['TaskDefinition'];
  const properties = definition?.Properties;
  const containers = properties?.['ContainerDefinitions'];
  if (
    definition?.Type !== 'AWS::ECS::TaskDefinition' ||
    properties === undefined ||
    !Array.isArray(containers) ||
    !containers.some(
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        'Name' in value &&
        value.Name === 'app' &&
        'Image' in value &&
        value.Image === record.image,
    )
  )
    throw new Error(
      `cannot recover cache retirement for ${record.deploymentId}: the recorded task definition is missing or differs from its image`,
    );
  return JSON.stringify({
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'upwind recovered cache retirement task definition',
    Resources: {
      RetirementTaskDefinition: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          ...properties,
          ...(typeof properties['Family'] === 'string'
            ? { Family: `${properties['Family'].slice(0, 240)}-cache-retire` }
            : {}),
        },
      },
    },
    Outputs: { TaskDefinitionArn: { Value: { Ref: 'RetirementTaskDefinition' } } },
  });
}

async function retirementDefinition(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  project: string,
  record: DeploymentRecord,
): Promise<{ record: DeploymentRecord; task: string }> {
  const current = await stack(context, record.stackName);
  if (current !== undefined) owned(current, project);
  let arn =
    record.taskDefinitionArn ??
    (current === undefined ? undefined : outputs(current)['TaskDefinitionArn']);
  if (arn === undefined && current !== undefined) {
    arn = (await stackResources(context, record.stackName)).find(
      (resource) =>
        resource.ResourceType === 'AWS::ECS::TaskDefinition' &&
        resource.ResourceStatus !== 'DELETE_COMPLETE',
    )?.PhysicalResourceId;
  }
  if (arn !== undefined && (await activeTaskDefinition(context, arn)))
    return { record: { ...record, taskDefinitionArn: arn }, task: arn };
  const name = `${record.stackName}-cache-retire`;
  if (record.retirementStackName !== undefined && record.retirementStackName !== name)
    throw new Error('retirement stack does not match its deployment identity');
  const recovered = await createStack(context, project, name, retirementTemplate(record));
  const task = outputs(recovered)['TaskDefinitionArn'];
  if (task === undefined)
    throw new Error(`cache retirement stack ${name} returned no task definition`);
  const saved = { ...record, retirementStackName: name, retirementTaskDefinitionArn: task };
  await saveRecord(context, bootstrap.ArtifactsBucket, saved);
  return { record: saved, task };
}

async function drain(
  context: AwsContext,
  project: string,
  record: DeploymentRecord,
): Promise<void> {
  let current = await stack(context, record.stackName);
  if (current === undefined) return;
  owned(current, project);
  if (current.StackStatus?.endsWith('_IN_PROGRESS')) {
    try {
      current = await waitStack(context, record.stackName);
    } catch (error) {
      if (error instanceof UncertainAwsMutation) throw error;
      current = await stack(context, record.stackName);
      if (current?.StackStatus !== 'ROLLBACK_COMPLETE') throw error;
    }
  }
  // A completed initial rollback has already removed and drained its ECS service.
  if (current === undefined || current.StackStatus === 'ROLLBACK_COMPLETE') return;
  await scaleDeployment(context, project, record, 0);
}

async function remove(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  project: string,
  original: DeploymentRecord,
  lock: ProjectLock,
): Promise<void> {
  let record = original;
  if (record.cacheRetired !== true) {
    record = { ...record, retiring: true };
    await saveRecord(context, bootstrap.ArtifactsBucket, record);
    await drain(context, project, record);
    const prepared = await retirementDefinition(context, bootstrap, project, record);
    await lock.assertHeld();
    // The job also handles an absent scope by creating an irreversible retired tombstone.
    await retireCache(context, bootstrap, { ...prepared.record, taskDefinitionArn: prepared.task });
    record = { ...prepared.record, cacheRetired: true };
    await saveRecord(context, bootstrap.ArtifactsBucket, record);
  }
  await lock.assertHeld();
  await deleteStack(context, project, record.stackName);
  if (record.retirementStackName !== undefined) {
    if (record.retirementStackName !== `${record.stackName}-cache-retire`)
      throw new Error('retirement stack does not match its deployment identity');
    await deleteStack(context, project, record.retirementStackName);
  }
  if (record.secretArn !== undefined) await deleteSecret(context, project, record.secretArn);
  await deleteImage(context, bootstrap.RepositoryName, record.imageTag);
  await saveRecord(context, bootstrap.ArtifactsBucket, { ...record, status: 'deleted' });
  await deleteStaticManifest(context, bootstrap.ArtifactsBucket, record.deploymentId, lock);
}

export async function retain(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  settings: DeploySettings,
  current: string,
  lock: ProjectLock,
): Promise<void> {
  const all = (await records(context, bootstrap.ArtifactsBucket)).filter(
    (record) => record.status !== 'deleted' && record.deploymentId !== current,
  );
  const candidates = all
    .filter(
      (record) =>
        record.status !== 'staging' && record.cacheRetired !== true && record.retiring !== true,
    )
    .sort((a, b) => (b.lastServed ?? b.createdAt).localeCompare(a.lastServed ?? a.createdAt));
  const kept = new Set(candidates.slice(0, settings.keep).map((record) => record.deploymentId));
  const failures: string[] = [];
  for (const record of all) {
    await lock.assertHeld();
    try {
      const route = await productionRule(context, bootstrap.ListenerArn, settings.project);
      if (record.targetGroupArn !== undefined && targetOf(route) === record.targetGroupArn)
        throw new Error('deployment still receives production traffic');
      if (kept.has(record.deploymentId)) {
        await scaleDeployment(context, settings.project, record, 0);
        await saveRecord(context, bootstrap.ArtifactsBucket, { ...record, status: 'kept' });
      } else if (
        record.status !== 'staging' ||
        context.now() - Date.parse(record.createdAt) >= ORPHAN_AGE_MS
      ) {
        if (record.stackName !== deploymentStackName(settings.project, record.deploymentId))
          throw new Error('deployment stack does not match its identity');
        await remove(context, bootstrap, settings.project, record, lock);
      }
    } catch (error) {
      if (error instanceof UncertainAwsMutation) throw error;
      await lock.assertHeld();
      failures.push(
        `${record.deploymentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (failures.length > 0) throw new Error(`AWS retention incomplete: ${failures.join('; ')}`);
}

export async function finishRetention(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  settings: DeploySettings,
  current: string,
  lock: ProjectLock,
): Promise<void> {
  try {
    await retain(context, bootstrap, settings, current, lock);
  } catch (error) {
    if (error instanceof UncertainAwsMutation) throw error;
    console.warn(
      `upwind: deployment is live; retention will be retried on the next deploy: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
