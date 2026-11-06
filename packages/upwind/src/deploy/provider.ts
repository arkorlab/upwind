import { type AwsCredentials, restoreAwsApplicationEnvironment } from '../aws/credentials.ts';
import type { DeployOptions, DeploymentsOptions, DestroyOptions, RollbackOptions } from './args.ts';
import { readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';

/** Provider selection belongs to the CLI, never to a request's delivery path. */
export async function deployToProvider(
  options: DeployOptions,
  credentials: CloudflareCredentials | undefined,
  aws: AwsCredentials,
): Promise<number> {
  const settings = await readDeploySettings(options.projectDir, { keep: options.keep });
  if (settings.target === 'aws') {
    const { runAwsDeploy } = await import('../aws/provider.ts');
    return runAwsDeploy(options, settings, aws);
  }
  const { runDeploy } = await import('./command.ts');
  restoreAwsApplicationEnvironment(aws);
  return runDeploy(options, credentials, {}, settings);
}

export async function deploymentsOfProvider(
  options: DeploymentsOptions,
  credentials: CloudflareCredentials | undefined,
  aws: AwsCredentials,
): Promise<number> {
  const settings = await readDeploySettings(options.projectDir);
  if (settings.target === 'aws') {
    const { runAwsDeployments } = await import('../aws/provider.ts');
    return runAwsDeployments(options, settings, aws);
  }
  const { runDeployments } = await import('./deployments.ts');
  restoreAwsApplicationEnvironment(aws);
  return runDeployments(options, credentials, {}, settings);
}

export async function rollbackProvider(
  options: RollbackOptions,
  credentials: CloudflareCredentials | undefined,
  aws: AwsCredentials,
): Promise<number> {
  const settings = await readDeploySettings(options.projectDir);
  if (settings.target === 'aws') {
    const { runAwsRollback } = await import('../aws/provider.ts');
    return runAwsRollback(options, settings, aws);
  }
  const { runRollback } = await import('./rollback.ts');
  restoreAwsApplicationEnvironment(aws);
  return runRollback(options, credentials, {}, settings);
}

export async function destroyProvider(
  options: DestroyOptions,
  credentials: CloudflareCredentials | undefined,
  aws: AwsCredentials,
): Promise<number> {
  if (!options.yes) {
    console.error('upwind: destroy deletes the site and its managed resources; run it with --yes');
    return 1;
  }
  const settings = await readDeploySettings(options.projectDir);
  if (settings.target === 'aws') {
    const { runAwsDestroy } = await import('../aws/provider.ts');
    return runAwsDestroy(options, settings, aws);
  }
  const { runDestroy } = await import('./destroy.ts');
  restoreAwsApplicationEnvironment(aws);
  return runDestroy(options, credentials, {}, settings);
}
