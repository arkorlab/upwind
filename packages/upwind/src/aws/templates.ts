import { cdnOutputs, cdnResources } from './template-cdn.ts';
import { computeOutputs, computeResources } from './template-compute.ts';
import { type NetworkInput, networkOutputs, networkResources } from './template-network.ts';
import { storageOutputs, storageResources } from './template-storage.ts';
import { attribute, output, ref, resourceName, tags } from './template-values.ts';
import type { AwsBootstrapOutputs, AwsDeploySettings, CloudFormationTemplate } from './types.ts';

export { staticCacheBehaviors } from './template-cdn.ts';

export interface BootstrapTemplateInput extends NetworkInput {
  readonly valkeyParameterGroupFamily?: string;
  readonly staticBypass?: boolean;
}

export function bootstrapConfiguration(settings: AwsDeploySettings): string {
  return JSON.stringify({
    cloudFront: settings.cloudFront,
    cacheBackend: settings.cache.backend,
    nodeType: settings.cache.backend === 'valkey' ? settings.cache.nodeType : undefined,
    publicOrigin: settings.publicOrigin,
    certificateArn: settings.certificateArn,
  });
}

/** Shared infrastructure never owns the mutable production routing rule. */
export function bootstrapTemplate(input: BootstrapTemplateInput): CloudFormationTemplate {
  const { project, settings } = input;
  if (
    !settings.cloudFront &&
    (settings.publicOrigin === undefined || settings.certificateArn === undefined)
  ) {
    throw new Error(
      'direct ALB deployment requires publicOrigin and a regional ACM certificateArn',
    );
  }
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'upwind AWS Fargate project infrastructure',
    Resources: {
      ...networkResources(input),
      ...storageResources(project, settings, input.valkeyParameterGroupFamily),
      ...computeResources(project, settings),
      ...cdnResources(project, settings, input.staticBypass ?? false),
    },
    Outputs: {
      Configuration: output(bootstrapConfiguration(settings)),
      ...networkOutputs(),
      ...storageOutputs(settings),
      ...computeOutputs(),
      ...cdnOutputs(settings),
    },
  };
}

export interface DeploymentTemplateInput {
  readonly project: string;
  readonly deploymentId: string;
  readonly settings: AwsDeploySettings;
  readonly image: string;
  readonly bootstrap: AwsBootstrapOutputs;
  readonly publicOrigin: string;
  readonly probeToken: string;
  readonly probePriority: number;
  readonly secrets?: readonly { readonly name: string; readonly valueFrom: string }[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly desiredCount?: number;
}

function taskEnvironment(input: DeploymentTemplateInput): { Name: string; Value: string }[] {
  const { bootstrap, settings } = input;
  return Object.entries({
    ...input.environment,
    NODE_ENV: 'production',
    PORT: '3000',
    AWS_REGION: settings.region,
    UPWIND_NODE_ORIGIN: input.publicOrigin,
    UPWIND_NODE_KEEP_ALIVE_TIMEOUT: '65000',
    UPWIND_NODE_CACHE_DIR: '/tmp/upwind',
    UPWIND_AWS_BUNDLE_ROOT: `/tmp/upwind-bundle/${input.deploymentId}`,
    UPWIND_AWS_CACHE_BACKEND: settings.cache.backend,
    UPWIND_AWS_CACHE_BUCKET: bootstrap.ArtifactsBucket,
    ...(settings.cache.backend === 'dynamodb'
      ? { UPWIND_AWS_CACHE_TABLE: bootstrap.CacheTableName ?? '' }
      : { UPWIND_AWS_VALKEY_URL: `rediss://${bootstrap.ValkeyEndpoint ?? ''}:6379` }),
  }).map(([Name, Value]) => ({ Name, Value }));
}

function taskSecrets(input: DeploymentTemplateInput): { Name: string; ValueFrom: string }[] {
  const secrets = (input.secrets ?? []).map((secret) => ({
    Name: secret.name,
    ValueFrom: secret.valueFrom,
  }));
  if (input.settings.cache.backend === 'valkey') {
    const arn = input.bootstrap.ValkeySecretArn;
    if (arn === undefined) throw new Error('the bootstrap stack returned no Valkey secret');
    secrets.push(
      { Name: 'UPWIND_AWS_VALKEY_USERNAME', ValueFrom: `${arn}:username::` },
      { Name: 'UPWIND_AWS_VALKEY_PASSWORD', ValueFrom: `${arn}:password::` },
    );
  }
  return secrets;
}

/** A target group is attached before ECS registers its first task. */
export function deploymentTemplate(input: DeploymentTemplateInput): CloudFormationTemplate {
  const { project, deploymentId, settings, bootstrap } = input;
  if (!/^[a-zA-Z0-9._/-]+@sha256:[a-f0-9]{64}$/u.test(input.image)) {
    throw new Error('Fargate tasks require an immutable image digest');
  }
  if (
    !Number.isInteger(input.probePriority) ||
    input.probePriority < 1 ||
    input.probePriority >= 50000
  ) {
    throw new Error('probe rule priority must be below the production rule at 50000');
  }
  const name = resourceName(`${project}-${deploymentId}`);
  return {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: 'upwind immutable AWS Fargate deployment',
    Resources: {
      TargetGroup: {
        Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
        Properties: {
          Name: name,
          VpcId: bootstrap.VpcId,
          TargetType: 'ip',
          Protocol: 'HTTP',
          Port: 3000,
          HealthCheckPath: '/__upwind/health',
          HealthCheckProtocol: 'HTTP',
          HealthCheckIntervalSeconds: 10,
          HealthCheckTimeoutSeconds: 5,
          HealthyThresholdCount: 2,
          UnhealthyThresholdCount: 3,
          Matcher: { HttpCode: '200' },
          TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '300' }],
          Tags: [...tags(project), { Key: 'upwind:deployment', Value: deploymentId }],
        },
      },
      ProbeRule: {
        Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
        Properties: {
          ListenerArn: bootstrap.ListenerArn,
          Priority: input.probePriority,
          Conditions: [
            {
              Field: 'http-header',
              HttpHeaderConfig: { HttpHeaderName: 'X-Upwind-Probe', Values: [input.probeToken] },
            },
            { Field: 'path-pattern', PathPatternConfig: { Values: ['/*'] } },
          ],
          Actions: [{ Type: 'forward', TargetGroupArn: ref('TargetGroup') }],
        },
      },
      TaskDefinition: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: name,
          Cpu: String(settings.cpu),
          Memory: String(settings.memoryMiB),
          NetworkMode: 'awsvpc',
          RequiresCompatibilities: ['FARGATE'],
          RuntimePlatform: {
            OperatingSystemFamily: 'LINUX',
            CpuArchitecture: settings.architecture === 'arm64' ? 'ARM64' : 'X86_64',
          },
          ExecutionRoleArn: bootstrap.ExecutionRoleArn,
          TaskRoleArn: bootstrap.TaskRoleArn,
          ContainerDefinitions: [
            {
              Name: 'app',
              Image: input.image,
              Essential: true,
              User: 'node',
              StopTimeout: 60,
              PortMappings: [{ ContainerPort: 3000, Protocol: 'tcp', AppProtocol: 'http' }],
              Environment: taskEnvironment(input),
              Secrets: taskSecrets(input),
              LogConfiguration: {
                LogDriver: 'awslogs',
                Options: {
                  'awslogs-group': bootstrap.LogGroupName,
                  'awslogs-region': settings.region,
                  'awslogs-stream-prefix': deploymentId,
                  mode: 'non-blocking',
                  'max-buffer-size': '25m',
                },
              },
            },
          ],
          Tags: [...tags(project), { Key: 'upwind:deployment', Value: deploymentId }],
        },
      },
      Service: {
        Type: 'AWS::ECS::Service',
        DependsOn: 'ProbeRule',
        Properties: {
          ServiceName: name,
          Cluster: bootstrap.ClusterArn,
          TaskDefinition: ref('TaskDefinition'),
          LaunchType: 'FARGATE',
          PlatformVersion: '1.4.0',
          DesiredCount: input.desiredCount ?? settings.tasks,
          EnableECSManagedTags: true,
          PropagateTags: 'SERVICE',
          AvailabilityZoneRebalancing: 'ENABLED',
          HealthCheckGracePeriodSeconds: 120,
          DeploymentConfiguration: {
            MinimumHealthyPercent: 100,
            MaximumPercent: 200,
            DeploymentCircuitBreaker: { Enable: true, Rollback: true },
          },
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              AssignPublicIp: 'DISABLED',
              Subnets: bootstrap.TaskSubnetIds.split(','),
              SecurityGroups: [bootstrap.TaskSecurityGroupId],
            },
          },
          LoadBalancers: [
            { ContainerName: 'app', ContainerPort: 3000, TargetGroupArn: ref('TargetGroup') },
          ],
          Tags: [...tags(project), { Key: 'upwind:deployment', Value: deploymentId }],
        },
      },
    },
    Outputs: {
      ServiceName: output(attribute('Service', 'Name')),
      TargetGroupArn: output(ref('TargetGroup')),
      TaskDefinitionArn: output(ref('TaskDefinition')),
      ProbeRuleArn: output(ref('ProbeRule')),
    },
  };
}
