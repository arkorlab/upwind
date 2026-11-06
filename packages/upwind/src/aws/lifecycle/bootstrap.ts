import {
  DescribeAvailabilityZonesCommand,
  DescribeManagedPrefixListsCommand,
} from '@aws-sdk/client-ec2';
import {
  DescribeCacheEngineVersionsCommand,
  DescribeReplicationGroupsCommand,
} from '@aws-sdk/client-elasticache';

import { bootstrapConfiguration, bootstrapTemplate } from '../templates.ts';
import type { AwsBootstrapOutputs, AwsDeploySettings } from '../types.ts';
import type { AwsContext } from './sdk.ts';
import { bootstrapName, createStack, outputs, owned, stack, waitStack } from './stacks.ts';

const REQUIRED = [
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
] as const;

export function bootstrapOutputs(raw: Readonly<Record<string, string>>): AwsBootstrapOutputs {
  for (const key of REQUIRED) if (!raw[key]) throw new Error(`AWS bootstrap has no ${key} output`);
  return raw as unknown as AwsBootstrapOutputs;
}

/** A configured durability setting alone is not proof of the service's effective guarantee. */
export async function verifyCacheDurability(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
): Promise<void> {
  if (bootstrap.CacheTableName !== undefined && bootstrap.CacheTableName !== '') return;
  const id = bootstrap.ValkeyReplicationGroupId;
  if (id === undefined || id === '')
    throw new Error('the AWS bootstrap has no Valkey replication group identity');
  const response = await context.services.cache.send(
    new DescribeReplicationGroupsCommand({ ReplicationGroupId: id }),
  );
  const group = response.ReplicationGroups?.find(
    (candidate) => candidate.ReplicationGroupId === id,
  );
  if (group?.EffectiveDurability !== 'sync')
    throw new Error(
      'the AWS Valkey cache does not report EffectiveDurability=sync; refusing activation without synchronous durability',
    );
}

export async function existingBootstrap(
  context: AwsContext,
  project: string,
): Promise<AwsBootstrapOutputs | undefined> {
  const current = await stack(context, bootstrapName(project));
  if (current === undefined) return undefined;
  owned(current, project);
  const ready = current.StackStatus?.endsWith('_IN_PROGRESS')
    ? await waitStack(context, bootstrapName(project))
    : current;
  if (ready === undefined) return undefined;
  return bootstrapOutputs(outputs(ready));
}

export async function ensureBootstrap(
  context: AwsContext,
  project: string,
  settings: AwsDeploySettings,
): Promise<AwsBootstrapOutputs> {
  const present = await existingBootstrap(context, project);
  if (present !== undefined) {
    if (present.Configuration !== bootstrapConfiguration(settings))
      throw new Error(
        'the AWS project uses different shared infrastructure settings; restore its existing configuration or use a new deploy.name',
      );
    if (
      Boolean(present.DistributionId) !== settings.cloudFront ||
      Boolean(present.CacheTableName) !== (settings.cache.backend === 'dynamodb')
    ) {
      throw new Error(
        'the AWS project already uses another CDN or cache backend; use its existing settings or a new deploy.name',
      );
    }
    if (!settings.cloudFront && present.PublicOrigin !== settings.publicOrigin)
      throw new Error(
        'the AWS project public origin differs from its bootstrap; restore its existing publicOrigin',
      );
    await verifyCacheDurability(context, present);
    return present;
  }
  const zones = await context.services.ec2.send(
    new DescribeAvailabilityZonesCommand({
      Filters: [
        { Name: 'state', Values: ['available'] },
        { Name: 'zone-type', Values: ['availability-zone'] },
      ],
    }),
  );
  const availabilityZones = (zones.AvailabilityZones ?? [])
    .filter(
      (zone) =>
        !settings.cloudFront ||
        !new Set(['apne1-az3', 'use1-az3', 'usw1-az2', 'cac1-az3']).has(zone.ZoneId ?? ''),
    )
    .flatMap((zone) => (zone.ZoneName === undefined ? [] : [zone.ZoneName]))
    .sort()
    .slice(0, 2);
  let cloudFrontPrefixListId: string | undefined;
  if (settings.cloudFront) {
    const lists = await context.services.ec2.send(
      new DescribeManagedPrefixListsCommand({
        Filters: [
          { Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] },
        ],
      }),
    );
    cloudFrontPrefixListId = lists.PrefixLists?.[0]?.PrefixListId;
    if (cloudFrontPrefixListId === undefined)
      throw new Error('this AWS region has no CloudFront origin-facing managed prefix list');
  }
  let family: string | undefined;
  if (settings.cache.backend === 'valkey') {
    const versions = await context.services.cache.send(
      new DescribeCacheEngineVersionsCommand({ Engine: 'valkey', EngineVersion: '9.0' }),
    );
    family = versions.CacheEngineVersions?.[0]?.CacheParameterGroupFamily;
    if (family === undefined)
      throw new Error(
        'this AWS region does not provide the Valkey 9 synchronous durability engine required by upwind',
      );
  }
  const template = bootstrapTemplate({
    project,
    settings,
    availabilityZones,
    ...(cloudFrontPrefixListId === undefined ? {} : { cloudFrontPrefixListId }),
    ...(family === undefined ? {} : { valkeyParameterGroupFamily: family }),
  });
  const created = await createStack(
    context,
    project,
    bootstrapName(project),
    JSON.stringify(template),
  );
  const result = bootstrapOutputs(outputs(created));
  await verifyCacheDurability(context, result);
  return result;
}
