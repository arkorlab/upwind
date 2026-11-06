import type { AwsDeploySettings } from './types.ts';

export interface AwsDeployInput {
  readonly region: string;
  readonly compute?: 'fargate' | undefined;
  readonly tasks?: number | undefined;
  readonly cloudFront?: boolean | undefined;
  readonly cache?:
    | { readonly backend: 'valkey' | 'dynamodb'; readonly nodeType?: string | undefined }
    | undefined;
  readonly cpu?: number | undefined;
  readonly memoryMiB?: number | undefined;
  readonly architecture?: 'x86_64' | 'arm64' | undefined;
  readonly publicOrigin?: string | undefined;
  readonly certificateArn?: string | undefined;
  readonly build?:
    | {
        readonly context?: string | undefined;
        readonly prepare?: readonly string[] | undefined;
        readonly env?: readonly string[] | undefined;
      }
    | undefined;
}

function validMemory(cpu: number, memory: number): boolean {
  if (cpu === 256) return [512, 1024, 2048].includes(memory);
  const limits: Readonly<Record<number, readonly [number, number, number]>> = {
    256: [512, 2048, 512],
    512: [1024, 4096, 1024],
    1024: [2048, 8192, 1024],
    2048: [4096, 16384, 1024],
    4096: [8192, 30720, 1024],
    8192: [16384, 61440, 4096],
    16384: [32768, 122880, 8192],
  };
  const range = limits[cpu];
  return (
    range !== undefined &&
    memory >= range[0] &&
    memory <= range[1] &&
    (memory - range[0]) % range[2] === 0
  );
}

export function awsDeploySettings(input: AwsDeployInput): AwsDeploySettings {
  const cpu = input.cpu ?? 1024;
  const memoryMiB = input.memoryMiB ?? 2048;
  if (!validMemory(cpu, memoryMiB))
    throw new Error(
      'deploy.aws.cpu and memoryMiB must be a supported Fargate Linux CPU/memory pair',
    );
  let publicOrigin: string | undefined;
  if (input.publicOrigin !== undefined) {
    const url = new URL(input.publicOrigin);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.port !== ''
    ) {
      throw new Error(
        'deploy.aws.publicOrigin must be an HTTPS origin without a path, credentials, or custom port',
      );
    }
    publicOrigin = url.origin;
  }
  const cloudFront = input.cloudFront ?? true;
  if (!cloudFront && (publicOrigin === undefined || input.certificateArn === undefined)) {
    throw new Error(
      'CloudFront disabled: set deploy.aws.publicOrigin and a regional ACM certificateArn for the HTTPS ALB',
    );
  }
  if (cloudFront && (publicOrigin !== undefined || input.certificateArn !== undefined)) {
    throw new Error(
      'CloudFront uses its generated HTTPS domain; publicOrigin and certificateArn are for direct ALB deployments',
    );
  }
  if (input.certificateArn !== undefined && input.certificateArn.split(':')[3] !== input.region) {
    throw new Error('deploy.aws.certificateArn must belong to deploy.aws.region');
  }
  const backend = input.cache?.backend ?? 'valkey';
  const nodeType = input.cache?.nodeType ?? 'cache.m7g.large';
  if (backend === 'dynamodb' && input.cache?.nodeType !== undefined)
    throw new Error('deploy.aws.cache.nodeType applies only to Valkey');
  if (backend === 'valkey' && !/^cache\.(?:[rm][678]g|c7gn|c8gn)\./u.test(nodeType))
    throw new Error('Valkey synchronous durability requires a supported Graviton node family');
  const buildEnv = input.build?.env ?? [];
  for (const name of buildEnv) {
    if (/^(?:AWS_|AMAZON_|CF_|CLOUDFLARE_|UPWIND_|ARKOR_)/iu.test(name))
      throw new Error(
        `deploy.aws.build.env cannot expose deployment credentials or platform configuration: ${name}`,
      );
  }
  return {
    region: input.region,
    compute: input.compute ?? 'fargate',
    tasks: input.tasks ?? 2,
    cloudFront,
    cache: { backend, nodeType },
    cpu,
    memoryMiB,
    architecture: input.architecture ?? 'x86_64',
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    ...(input.certificateArn === undefined ? {} : { certificateArn: input.certificateArn }),
    build: {
      context: input.build?.context ?? '.',
      ...(input.build?.prepare === undefined ? {} : { prepare: input.build.prepare }),
      env: buildEnv,
    },
  };
}
