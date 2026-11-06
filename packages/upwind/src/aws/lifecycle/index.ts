import type { DeploymentsOptions, DeployOptions, RollbackOptions } from '../../deploy/args.ts';
import type { DeploySettings } from '../../deploy/config.ts';
import { buildFargate, readFargateBuild } from '../build.ts';
import type { AwsCredentials } from '../credentials.ts';
import { readAwsSecrets } from '../secrets.ts';
import { ensureBootstrap, existingBootstrap } from './bootstrap.ts';
import { configureStaticBypass } from './cdn.ts';
import { validateImage } from './images.ts';
import {
  activateRecord,
  finishRetention,
  reconcile,
  recordOf,
  say,
  scale,
  settingsOf,
  stageRecord,
  stateOf,
} from './operations.ts';
import { checkDeployment, productionRule, targetOf } from './routes.ts';
import { awsContext, type AwsLifecycleIo, UncertainAwsMutation } from './sdk.ts';
import { records, withProjectLock } from './state.ts';

export { runAwsDestroy } from './destroy.ts';
export type { AwsLifecycleIo } from './sdk.ts';

export async function runAwsDeploy(
  options: DeployOptions,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io: AwsLifecycleIo = {},
): Promise<number> {
  const aws = settingsOf(settings);
  if (options.resetCacheKey)
    throw new Error(
      '--reset-cache-key is a Cloudflare option; AWS caches use task-role credentials',
    );
  if (options.dryRun) {
    say(
      `${settings.project}: AWS Fargate in ${aws.region}, ${String(aws.tasks)} tasks, ${aws.cache.backend} shared cache${aws.cloudFront ? ', CloudFront' : ''}`,
    );
    say(
      `build context ${aws.build.context}; ${aws.architecture}; no build or AWS mutation performed`,
    );
    return 0;
  }
  const receipt = options.prebuilt
    ? await readFargateBuild({ projectDir: options.projectDir, settings: aws })
    : await buildFargate({ projectDir: options.projectDir, settings: aws });
  if (options.buildOnly) {
    say(`built ${receipt.deploymentId}; deploy this portable image with upwind deploy --prebuilt`);
    return 0;
  }
  await validateImage(receipt, io);
  const secrets = await readAwsSecrets({
    files: options.envFiles,
    names: settings.secrets,
    env: process.env,
    reserved: new Set(),
  });
  const context = awsContext(aws.region, credentials, io);
  const bootstrap = await ensureBootstrap(context, settings.project, aws);
  return withProjectLock(context, bootstrap.ArtifactsBucket, async (lock) => {
    const state = await reconcile(context, bootstrap, settings.project, lock);
    if (state.current === receipt.deploymentId) {
      const live = await recordOf(context, bootstrap.ArtifactsBucket, receipt.deploymentId);
      if (live.targetGroupArn === undefined)
        throw new Error('live deployment has no retained target group');
      await checkDeployment(context, {
        target: live.targetGroupArn,
        tasks: live.settings.tasks,
        origin: live.publicOrigin,
        deploymentId: live.deploymentId,
        checks: settings.checks,
      });
      await configureStaticBypass(
        context,
        settings.project,
        bootstrap,
        live.safeStaticBypass === true,
        lock,
      );
      await finishRetention(context, bootstrap, settings, live.deploymentId, lock);
      say(`${live.deploymentId} is live already at ${live.publicOrigin}`);
      return 0;
    }
    const candidate = await stageRecord(
      context,
      bootstrap,
      settings,
      receipt,
      secrets,
      options.message,
      io,
    );
    if (candidate.safeStaticBypass !== true)
      await configureStaticBypass(context, settings.project, bootstrap, false, lock);
    try {
      await activateRecord(context, bootstrap, settings, candidate, state, lock);
    } catch (error) {
      if (error instanceof UncertainAwsMutation) throw error;
      const route = await productionRule(context, bootstrap.ListenerArn, settings.project);
      if (candidate.targetGroupArn !== targetOf(route)) {
        try {
          await scale(context, settings.project, candidate, 0);
        } catch (cleanup) {
          if (cleanup instanceof UncertainAwsMutation) throw cleanup;
          console.warn(
            `upwind: candidate ${candidate.deploymentId} could not be stopped; inspect stack ${candidate.stackName}`,
          );
        }
      }
      throw error;
    }
    if (candidate.safeStaticBypass === true)
      await configureStaticBypass(context, settings.project, bootstrap, true, lock);
    await finishRetention(context, bootstrap, settings, candidate.deploymentId, lock);
    return 0;
  });
}

export async function runAwsDeployments(
  _options: DeploymentsOptions,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io: AwsLifecycleIo = {},
): Promise<number> {
  const aws = settingsOf(settings);
  const context = awsContext(aws.region, credentials, io);
  const bootstrap = await existingBootstrap(context, settings.project);
  if (bootstrap === undefined) {
    say(`${settings.project} has no managed AWS deployments`);
    return 0;
  }
  const current = await stateOf(context, bootstrap.ArtifactsBucket);
  const route = await productionRule(context, bootstrap.ListenerArn, settings.project);
  const all = (await records(context, bootstrap.ArtifactsBucket)).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  for (const record of all) {
    const live = record.targetGroupArn !== undefined && record.targetGroupArn === targetOf(route);
    const status = live
      ? 'live'
      : record.status === 'live' || record.status === 'kept'
        ? 'kept (stopped)'
        : record.status;
    console.log(
      `  ${record.deploymentId}  ${status}  ${record.createdAt}${record.message === undefined ? '' : `  ${record.message}`}`,
    );
  }
  if (
    current.current !== undefined &&
    !all.some((record) => record.deploymentId === current.current)
  )
    throw new Error('the AWS live control record names a deployment whose history is missing');
  return 0;
}

export async function runAwsRollback(
  options: RollbackOptions,
  settings: DeploySettings,
  credentials?: AwsCredentials,
  io: AwsLifecycleIo = {},
): Promise<number> {
  const aws = settingsOf(settings);
  const context = awsContext(aws.region, credentials, io);
  const bootstrap = await existingBootstrap(context, settings.project);
  if (bootstrap === undefined) throw new Error('this project has no AWS deployment to roll back');
  return withProjectLock(context, bootstrap.ArtifactsBucket, async (lock) => {
    const state = await reconcile(context, bootstrap, settings.project, lock);
    const candidates = (await records(context, bootstrap.ArtifactsBucket))
      .filter(
        (record) =>
          record.status !== 'deleted' &&
          record.status !== 'staging' &&
          record.deploymentId !== state.current,
      )
      .sort((a, b) => (b.lastServed ?? b.createdAt).localeCompare(a.lastServed ?? a.createdAt));
    const chosen =
      options.to === undefined
        ? candidates[0]
        : candidates.find((record) => record.deploymentId === options.to);
    if (chosen === undefined) throw new Error('no retained AWS deployment matches this rollback');
    await scale(context, settings.project, chosen, chosen.settings.tasks);
    if (chosen.safeStaticBypass !== true)
      await configureStaticBypass(context, settings.project, bootstrap, false, lock);
    try {
      await activateRecord(context, bootstrap, settings, chosen, state, lock);
    } catch (error) {
      if (error instanceof UncertainAwsMutation) throw error;
      const route = await productionRule(context, bootstrap.ListenerArn, settings.project);
      if (chosen.targetGroupArn !== targetOf(route))
        await scale(context, settings.project, chosen, 0);
      throw error;
    }
    if (chosen.safeStaticBypass === true)
      await configureStaticBypass(context, settings.project, bootstrap, true, lock);
    await finishRetention(context, bootstrap, settings, chosen.deploymentId, lock);
    return 0;
  });
}
