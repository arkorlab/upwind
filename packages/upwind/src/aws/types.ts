/** Settings resolved by the CLI before any AWS resource is changed. */
export interface AwsDeploySettings {
  readonly compute: 'fargate';
  readonly region: string;
  readonly tasks: number;
  readonly cloudFront: boolean;
  readonly cache: {
    readonly backend: 'valkey' | 'dynamodb';
    readonly nodeType: string;
  };
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly architecture: 'x86_64' | 'arm64';
  readonly publicOrigin?: string;
  readonly certificateArn?: string;
  readonly build: {
    readonly context: string;
    /** An argument vector, executed without a shell after installing dependencies. */
    readonly prepare?: readonly string[];
    /** Only these environment variables are made available to the build. */
    readonly env: readonly string[];
  };
}

export interface AwsStaticFile {
  readonly path: string;
  readonly file: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly contentType: string;
  readonly cacheControl?: string;
}

/** The portable, credential-free result of a Linux image build. */
export interface FargateBuildReceipt {
  readonly compute: 'fargate';
  readonly format: 'upwind-fargate';
  readonly version: 1;
  readonly deploymentId: string;
  readonly upwind: string;
  readonly builtAt: string;
  readonly platform: 'linux/amd64' | 'linux/arm64';
  readonly imageId: string;
  readonly baseImageDigest: string;
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly archivePath: string;
  readonly archiveSha256: string;
  readonly nativeDirectory: string;
  readonly nativeSha256: string;
  readonly staticFiles: readonly AwsStaticFile[];
  readonly safeStaticBypass: boolean;
}

/** CloudFormation values consumed by deployment-specific stacks and lifecycle calls. */
export interface AwsBootstrapOutputs {
  readonly Configuration: string;
  readonly ArtifactsBucket: string;
  readonly RepositoryUri: string;
  readonly RepositoryName: string;
  readonly ClusterArn: string;
  readonly ListenerArn: string;
  readonly LoadBalancerDnsName?: string;
  readonly VpcId: string;
  readonly TaskSubnetIds: string;
  readonly TaskSecurityGroupId: string;
  readonly ExecutionRoleArn: string;
  readonly TaskRoleArn: string;
  readonly LogGroupName: string;
  readonly PublicOrigin: string;
  readonly DistributionId?: string;
  readonly CacheTableName?: string;
  readonly ValkeyEndpoint?: string;
  readonly ValkeySecretArn?: string;
  readonly ValkeyReplicationGroupId?: string;
}

export interface CloudFormationTemplate {
  readonly AWSTemplateFormatVersion: '2010-09-09';
  readonly Description: string;
  readonly Resources: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly Outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}
