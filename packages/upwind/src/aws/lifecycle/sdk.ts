import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { CloudFrontClient } from '@aws-sdk/client-cloudfront';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ECRClient } from '@aws-sdk/client-ecr';
import { ECSClient } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { S3Client } from '@aws-sdk/client-s3';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { awsCredentialProvider, type AwsCredentials } from '../credentials.ts';

export interface AwsServices {
  readonly stacks: Pick<CloudFormationClient, 'send'>;
  readonly cdn: Pick<CloudFrontClient, 'send'>;
  readonly ec2: Pick<EC2Client, 'send'>;
  readonly ecr: Pick<ECRClient, 'send'>;
  readonly ecs: Pick<ECSClient, 'send'>;
  readonly cache: Pick<ElastiCacheClient, 'send'>;
  readonly loadBalancer: Pick<ElasticLoadBalancingV2Client, 'send'>;
  readonly objects: Pick<S3Client, 'send'>;
  readonly secrets: Pick<SecretsManagerClient, 'send'>;
}

/** Injectable boundaries let CI exercise failures without an AWS account. */
export interface AwsLifecycleIo {
  readonly services?: AwsServices;
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly run?: (command: string, args: readonly string[], input?: string) => Promise<string>;
}

export interface AwsContext {
  readonly services: AwsServices;
  readonly fetch: typeof fetch;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}

export function awsContext(
  region: string,
  credentials?: AwsCredentials,
  io: AwsLifecycleIo = {},
): AwsContext {
  // Do not replay a mutation whose first response was lost. Its outcome must be inspected
  // while exclusion is retained, rather than hidden behind an automatic SDK retry.
  const options = { region, credentials: awsCredentialProvider(credentials), maxAttempts: 1 };
  return {
    services: io.services ?? {
      stacks: new CloudFormationClient(options),
      cdn: new CloudFrontClient({ ...options, region: 'us-east-1' }),
      ec2: new EC2Client(options),
      ecr: new ECRClient(options),
      ecs: new ECSClient(options),
      cache: new ElastiCacheClient(options),
      loadBalancer: new ElasticLoadBalancingV2Client(options),
      objects: new S3Client(options),
      secrets: new SecretsManagerClient(options),
    },
    fetch: io.fetch ?? fetch,
    sleep:
      io.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        })),
    now: io.now ?? Date.now,
  };
}

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? error.name : undefined;
}

/** A request without a definitive rejection may still have changed provider state. */
export class UncertainAwsMutation extends Error {
  constructor(action: string, cause: unknown) {
    super(`${action} has an uncertain outcome; inspect AWS before recovering the project lock`, {
      cause,
    });
    this.name = 'UncertainAwsMutation';
  }
}

export async function mutation<T>(action: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const metadata =
      typeof error === 'object' && error !== null && '$metadata' in error
        ? (error.$metadata as { readonly httpStatusCode?: number })
        : undefined;
    if (metadata?.httpStatusCode !== undefined && metadata.httpStatusCode < 500) throw error;
    throw new UncertainAwsMutation(action, error);
  }
}
