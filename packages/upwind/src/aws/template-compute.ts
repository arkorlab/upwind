import { attribute, output, ref, type Resources, substitute, tags } from './template-values.ts';
import type { AwsDeploySettings } from './types.ts';

const taskTrust = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: { Service: 'ecs-tasks.amazonaws.com' },
      Action: 'sts:AssumeRole',
    },
  ],
};

export function computeResources(project: string, settings: AwsDeploySettings): Resources {
  const secretResources: unknown[] = [
    substitute(
      `arn:\${AWS::Partition}:secretsmanager:\${AWS::Region}:\${AWS::AccountId}:secret:upwind/${project}/*`,
    ),
  ];
  if (settings.cache.backend === 'valkey') secretResources.push(ref('ValkeySecret'));
  const cachePolicy: Record<string, unknown>[] = [
    {
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: substitute('${Artifacts.Arn}/aws-cache/*'),
    },
    {
      Effect: 'Allow',
      Action: 's3:GetObject',
      Resource: [
        substitute('${Artifacts.Arn}/static-manifests/*'),
        substitute('${Artifacts.Arn}/static/*'),
      ],
    },
    {
      Effect: 'Allow',
      Action: 's3:ListBucket',
      Resource: attribute('Artifacts', 'Arn'),
      Condition: {
        StringLike: { 's3:prefix': ['static-manifests/', 'static-manifests/*', 'aws-cache/*'] },
      },
    },
  ];
  if (settings.cache.backend === 'dynamodb') {
    cachePolicy.push({
      Effect: 'Allow',
      Action: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:BatchGetItem',
        'dynamodb:BatchWriteItem',
        'dynamodb:ConditionCheckItem',
      ],
      Resource: attribute('CacheTable', 'Arn'),
    });
  }
  return {
    Cluster: {
      Type: 'AWS::ECS::Cluster',
      Properties: {
        ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
        Tags: tags(project),
      },
    },
    Logs: {
      Type: 'AWS::Logs::LogGroup',
      Properties: { RetentionInDays: 30, Tags: tags(project) },
    },
    ExecutionRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: taskTrust,
        Policies: [
          {
            PolicyName: 'launch',
            PolicyDocument: {
              Version: '2012-10-17',
              Statement: [
                { Effect: 'Allow', Action: 'ecr:GetAuthorizationToken', Resource: '*' },
                {
                  Effect: 'Allow',
                  Action: [
                    'ecr:BatchCheckLayerAvailability',
                    'ecr:GetDownloadUrlForLayer',
                    'ecr:BatchGetImage',
                  ],
                  Resource: attribute('Repository', 'Arn'),
                },
                {
                  Effect: 'Allow',
                  Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                  Resource: attribute('Logs', 'Arn'),
                },
                {
                  Effect: 'Allow',
                  Action: 'secretsmanager:GetSecretValue',
                  Resource: secretResources,
                },
              ],
            },
          },
        ],
        Tags: tags(project),
      },
    },
    TaskRole: {
      Type: 'AWS::IAM::Role',
      Properties: {
        AssumeRolePolicyDocument: taskTrust,
        Policies: [
          {
            PolicyName: 'cache',
            PolicyDocument: { Version: '2012-10-17', Statement: cachePolicy },
          },
        ],
        Tags: tags(project),
      },
    },
  };
}

export function computeOutputs(): Record<string, Record<string, unknown>> {
  return {
    ClusterArn: output(attribute('Cluster', 'Arn')),
    ExecutionRoleArn: output(attribute('ExecutionRole', 'Arn')),
    TaskRoleArn: output(attribute('TaskRole', 'Arn')),
    LogGroupName: output(ref('Logs')),
  };
}
