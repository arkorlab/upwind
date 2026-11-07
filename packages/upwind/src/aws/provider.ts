import type {
  DeploymentsOptions,
  DeployOptions,
  DestroyOptions,
  RollbackOptions,
} from '../deploy/args.ts';
import type { DeploySettings } from '../deploy/config.ts';
import { awsComputeDriver, type AwsCommandIo } from './compute.ts';
import type { AwsCredentials } from './credentials.ts';

export async function runAwsDeploy(
  options: DeployOptions,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io?: AwsCommandIo,
): Promise<number> {
  return (await awsComputeDriver(settings)).deploy(options, settings, credentials, io);
}

export async function runAwsDeployments(
  options: DeploymentsOptions,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io?: AwsCommandIo,
): Promise<number> {
  return (await awsComputeDriver(settings)).deployments(options, settings, credentials, io);
}

export async function runAwsRollback(
  options: RollbackOptions,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io?: AwsCommandIo,
): Promise<number> {
  return (await awsComputeDriver(settings)).rollback(options, settings, credentials, io);
}

export async function runAwsDestroy(
  options: DestroyOptions,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io?: AwsCommandIo,
): Promise<number> {
  return (await awsComputeDriver(settings)).destroy(options, settings, credentials, io);
}
