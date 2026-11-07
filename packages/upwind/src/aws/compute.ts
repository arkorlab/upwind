import type {
  DeploymentsOptions,
  DeployOptions,
  DestroyOptions,
  RollbackOptions,
} from '../deploy/args.ts';
import type { DeploySettings } from '../deploy/config.ts';
import type { AwsCredentials } from './credentials.ts';

/** Command services common to compute drivers; AWS SDK clients remain driver-private. */
export interface AwsCommandIo {
  readonly fetch?: typeof fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
  readonly run?: (command: string, args: readonly string[], input?: string) => Promise<string>;
}

type AwsCommand<Options> = (
  options: Options,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io?: AwsCommandIo,
) => Promise<number>;

/** A driver owns its artifact, provisioning, activation, retained deployments and teardown. */
export interface AwsComputeDriver {
  readonly compute: string;
  readonly deploy: AwsCommand<DeployOptions>;
  readonly deployments: AwsCommand<DeploymentsOptions>;
  readonly rollback: AwsCommand<RollbackOptions>;
  readonly destroy: AwsCommand<DestroyOptions>;
}

const drivers = new Map<string, () => Promise<AwsComputeDriver>>([
  ['fargate', async () => (await import('./drivers/fargate.ts')).fargateDriver],
]);

/** Resolve before any build, credential resolution or resource mutation. */
export async function awsComputeDriver(settings: DeploySettings): Promise<AwsComputeDriver> {
  const compute = settings.aws?.compute;
  const load = compute === undefined ? undefined : drivers.get(compute);
  if (load === undefined)
    throw new Error(`unsupported AWS compute driver: ${compute ?? '(missing)'}`);
  return load();
}
