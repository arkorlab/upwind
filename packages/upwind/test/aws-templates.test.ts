import { describe, expect, it } from 'vitest';

import { awsDeploySettings } from '../src/aws/settings.ts';
import { bootstrapTemplate, deploymentTemplate } from '../src/aws/templates.ts';
import type { AwsBootstrapOutputs } from '../src/aws/types.ts';

const bootstrap: AwsBootstrapOutputs = {
  Configuration: '{}',
  ArtifactsBucket: 'artifacts',
  RepositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/app',
  RepositoryName: 'app',
  ClusterArn: 'cluster',
  ListenerArn: 'listener',
  VpcId: 'vpc',
  TaskSubnetIds: 'subnet-one,subnet-two',
  TaskSecurityGroupId: 'task-sg',
  ExecutionRoleArn: 'execution-role',
  TaskRoleArn: 'task-role',
  LogGroupName: 'logs',
  PublicOrigin: 'https://app.cloudfront.net',
  CacheTableName: 'cache',
  ValkeyEndpoint: 'cache.example',
  ValkeySecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:cache',
};

describe('AWS Fargate infrastructure', () => {
  it('keeps durable Valkey metadata on a primary with no eviction and synchronous logging', () => {
    const template = bootstrapTemplate({
      project: 'shop',
      settings: awsDeploySettings({ region: 'us-east-1' }),
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      cloudFrontPrefixListId: 'pl-cloudfront',
      valkeyParameterGroupFamily: 'valkey9',
    });
    expect(template.Resources['Valkey']?.['Properties']).toMatchObject({
      Durability: 'sync',
      ClusterMode: 'enabled',
      MultiAZEnabled: true,
      ReplicasPerNodeGroup: 1,
      TransitEncryptionEnabled: true,
      AtRestEncryptionEnabled: true,
    });
    expect(template.Resources['ValkeyParameters']?.['Properties']).toMatchObject({
      CacheParameterGroupFamily: 'valkey9',
      Properties: { 'maxmemory-policy': 'noeviction' },
    });
    expect(template.Resources).not.toHaveProperty('CacheTable');
    expect(template.Resources['Artifacts']?.['DeletionPolicy']).toBe('Retain');
  });

  it('does not bypass application routing without an explicit static-delivery proof', () => {
    const input = {
      project: 'shop',
      settings: awsDeploySettings({ region: 'us-east-1', cache: { backend: 'dynamodb' } }),
      availabilityZones: ['us-east-1a', 'us-east-1b'],
      cloudFrontPrefixListId: 'pl-cloudfront',
    };
    const normal = bootstrapTemplate(input);
    expect(normal.Resources).not.toHaveProperty('Valkey');
    expect(normal.Resources['Distribution']?.['Properties']).toMatchObject({
      DistributionConfig: {
        CacheBehaviors: [],
        DefaultCacheBehavior: {
          Compress: false,
          OriginRequestPolicyId: { Ref: 'ViewerRequestPolicy' },
        },
      },
    });
    expect(normal.Resources['DynamicCachePolicy']?.['Properties']).toMatchObject({
      CachePolicyConfig: { MinTTL: 0, MaxTTL: 0, DefaultTTL: 0 },
    });
    expect(
      bootstrapTemplate({ ...input, staticBypass: true }).Resources['Distribution']?.['Properties'],
    ).toMatchObject({
      DistributionConfig: {
        CacheBehaviors: [{ PathPattern: '/_next/static/*', TargetOriginId: 'static' }],
      },
    });
    expect(JSON.stringify(normal.Resources)).not.toContain('AWS::Lambda');
  });

  it('provides a direct HTTPS ALB without provisioning CloudFront', () => {
    const template = bootstrapTemplate({
      project: 'shop',
      settings: awsDeploySettings({
        region: 'us-east-1',
        cloudFront: false,
        publicOrigin: 'https://shop.example',
        certificateArn: 'arn:aws:acm:us-east-1:123:certificate/cert',
        cache: { backend: 'dynamodb' },
      }),
      availabilityZones: ['us-east-1a', 'us-east-1b'],
    });
    expect(template.Resources).not.toHaveProperty('Distribution');
    expect(template.Resources).not.toHaveProperty('VpcOrigin');
    expect(template.Resources['Listener']?.['Properties']).toMatchObject({
      Protocol: 'HTTPS',
      Port: 443,
    });
    expect(template.Resources['LoadBalancer']?.['Properties']).toMatchObject({
      Scheme: 'internet-facing',
    });
    expect(template.Outputs['PublicOrigin']).toEqual({ Value: 'https://shop.example' });
  });

  it('attaches the staging target group before ECS starts and never owns production routing', () => {
    const template = deploymentTemplate({
      project: 'shop',
      deploymentId: 'dpl_test',
      settings: awsDeploySettings({ region: 'us-east-1' }),
      image: `${bootstrap.RepositoryUri}@sha256:${'a'.repeat(64)}`,
      bootstrap,
      publicOrigin: bootstrap.PublicOrigin,
      probeToken: 'probe-secret',
      probePriority: 10,
      secrets: [
        {
          name: 'DATABASE_PASSWORD',
          valueFrom: 'arn:aws:secretsmanager:us-east-1:123:secret:upwind/shop/db:password::',
        },
      ],
    });
    expect(template.Resources['Service']?.['DependsOn']).toBe('ProbeRule');
    expect(template.Resources['Service']?.['Properties']).toMatchObject({
      DesiredCount: 2,
      NetworkConfiguration: { AwsvpcConfiguration: { AssignPublicIp: 'DISABLED' } },
    });
    expect(template.Resources['TaskDefinition']?.['Properties']).toMatchObject({
      Cpu: '1024',
      Memory: '2048',
      RuntimePlatform: { OperatingSystemFamily: 'LINUX', CpuArchitecture: 'X86_64' },
      ContainerDefinitions: [
        {
          User: 'node',
          StopTimeout: 60,
          Secrets: expect.arrayContaining([
            expect.objectContaining({ Name: 'DATABASE_PASSWORD' }),
            {
              Name: 'UPWIND_AWS_VALKEY_PASSWORD',
              ValueFrom: `${bootstrap.ValkeySecretArn}:password::`,
            },
          ]),
        },
      ],
    });
    expect(template.Resources).not.toHaveProperty('ProductionRule');
    expect(template.Resources['TargetGroup']?.['Properties']).toMatchObject({
      HealthCheckPath: '/__upwind/health',
      TargetType: 'ip',
      TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '300' }],
    });
  });

  it('rejects mutable images and unsupported network inputs before creating a template', () => {
    expect(() =>
      bootstrapTemplate({
        project: 'shop',
        settings: awsDeploySettings({ region: 'us-east-1' }),
        availabilityZones: ['us-east-1a'],
      }),
    ).toThrow('two distinct');
    expect(() =>
      deploymentTemplate({
        project: 'shop',
        deploymentId: 'test',
        settings: awsDeploySettings({ region: 'us-east-1' }),
        image: `${bootstrap.RepositoryUri}:latest`,
        bootstrap,
        publicOrigin: bootstrap.PublicOrigin,
        probeToken: 'probe',
        probePriority: 10,
      }),
    ).toThrow('immutable image digest');
  });
});
