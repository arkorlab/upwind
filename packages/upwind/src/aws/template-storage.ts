import {
  attribute,
  output,
  ref,
  resourceName,
  type Resources,
  substitute,
  tags,
} from './template-values.ts';
import type { AwsDeploySettings } from './types.ts';

export function storageResources(
  project: string,
  settings: AwsDeploySettings,
  valkeyParameterGroupFamily?: string,
): Resources {
  const resources: Resources = {
    Artifacts: {
      Type: 'AWS::S3::Bucket',
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
          ],
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
        Tags: tags(project),
      },
    },
    Repository: {
      Type: 'AWS::ECR::Repository',
      Properties: {
        ImageTagMutability: 'IMMUTABLE',
        ImageScanningConfiguration: { ScanOnPush: true },
        EmptyOnDelete: true,
        EncryptionConfiguration: { EncryptionType: 'AES256' },
        Tags: tags(project),
      },
    },
  };
  if (settings.cache.backend === 'dynamodb') {
    resources['CacheTable'] = {
      Type: 'AWS::DynamoDB::Table',
      Properties: {
        BillingMode: 'PAY_PER_REQUEST',
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        SSESpecification: { SSEEnabled: true },
        Tags: tags(project),
      },
    };
    return resources;
  }
  if (valkeyParameterGroupFamily === undefined || valkeyParameterGroupFamily === '') {
    throw new Error('resolve the Valkey 9 engine parameter-group family before provisioning');
  }
  const name = resourceName(project);
  Object.assign(resources, {
    ValkeySecret: {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Description: 'upwind runtime cache credentials',
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: 'upwind' }),
          GenerateStringKey: 'password',
          PasswordLength: 48,
          ExcludePunctuation: true,
        },
        Tags: tags(project),
      },
    },
    ValkeySecurityGroup: {
      Type: 'AWS::EC2::SecurityGroup',
      Properties: {
        GroupDescription: 'upwind runtime cache accepts only application tasks',
        VpcId: ref('Vpc'),
        SecurityGroupIngress: [
          {
            IpProtocol: 'tcp',
            FromPort: 6379,
            ToPort: 6379,
            SourceSecurityGroupId: ref('TaskSecurityGroup'),
          },
        ],
        Tags: tags(project),
      },
    },
    ValkeySubnets: {
      Type: 'AWS::ElastiCache::SubnetGroup',
      Properties: {
        Description: 'upwind runtime cache subnets',
        SubnetIds: [ref('PrivateSubnet1'), ref('PrivateSubnet2')],
      },
    },
    ValkeyParameters: {
      Type: 'AWS::ElastiCache::ParameterGroup',
      Properties: {
        CacheParameterGroupFamily: valkeyParameterGroupFamily,
        Description: 'Cache authority state must never be evicted',
        Properties: { 'maxmemory-policy': 'noeviction' },
      },
    },
    ValkeyUser: {
      Type: 'AWS::ElastiCache::User',
      Properties: {
        Engine: 'valkey',
        UserId: `${name}-user`,
        UserName: 'upwind',
        AccessString: 'on ~upwind:* +@all -@dangerous +eval +evalsha +script|load',
        AuthenticationMode: {
          Type: 'password',
          Passwords: [
            substitute('{{resolve:secretsmanager:${ValkeySecret}:SecretString:password}}'),
          ],
        },
      },
    },
    ValkeyUserGroup: {
      Type: 'AWS::ElastiCache::UserGroup',
      Properties: { Engine: 'valkey', UserGroupId: `${name}-users`, UserIds: [ref('ValkeyUser')] },
    },
    Valkey: {
      Type: 'AWS::ElastiCache::ReplicationGroup',
      Properties: {
        ReplicationGroupId: name,
        ReplicationGroupDescription: 'upwind durable runtime cache',
        Engine: 'valkey',
        EngineVersion: '9.0',
        ClusterMode: 'enabled',
        NumNodeGroups: 1,
        ReplicasPerNodeGroup: 1,
        CacheNodeType: settings.cache.nodeType,
        CacheSubnetGroupName: ref('ValkeySubnets'),
        CacheParameterGroupName: ref('ValkeyParameters'),
        SecurityGroupIds: [ref('ValkeySecurityGroup')],
        AutomaticFailoverEnabled: true,
        MultiAZEnabled: true,
        Durability: 'sync',
        TransitEncryptionEnabled: true,
        AtRestEncryptionEnabled: true,
        SnapshotRetentionLimit: 7,
        UserGroupIds: [ref('ValkeyUserGroup')],
        Tags: tags(project),
      },
    },
  } satisfies Resources);
  return resources;
}

export function storageOutputs(
  settings: AwsDeploySettings,
): Record<string, Record<string, unknown>> {
  return {
    ArtifactsBucket: output(ref('Artifacts')),
    RepositoryUri: output(attribute('Repository', 'RepositoryUri')),
    RepositoryName: output(ref('Repository')),
    ...(settings.cache.backend === 'dynamodb'
      ? { CacheTableName: output(ref('CacheTable')) }
      : {
          ValkeyEndpoint: output(attribute('Valkey', 'ConfigurationEndPoint.Address')),
          ValkeySecretArn: output(ref('ValkeySecret')),
          ValkeyReplicationGroupId: output(ref('Valkey')),
          ValkeyEffectiveDurability: output(attribute('Valkey', 'EffectiveDurability')),
        }),
  };
}
