import type { DeploySettings } from '../../deploy/config.ts';
import { deploymentTemplate } from '../templates.ts';
import type { AwsBootstrapOutputs, AwsDeploySettings, FargateBuildReceipt } from '../types.ts';
import { verifyCacheDurability } from './bootstrap.ts';
import { pushImage, uploadStatic } from './images.ts';
import {
  checkDeployment,
  listenerRules,
  probeIdentity,
  productionRule,
  removeProduction,
  switchProduction,
  targetOf,
} from './routes.ts';
import type { AwsContext, AwsLifecycleIo } from './sdk.ts';
import { UncertainAwsMutation } from './sdk.ts';
import { deploymentSecret } from './secrets.ts';
import {
  createStack,
  deleteStack,
  deploymentStackName,
  outputs,
  owned,
  stack,
  scaleDeployment as scale,
  updateStack,
  waitStack,
  withDesiredCount,
} from './stacks.ts';
import {
  readJson,
  recordKey,
  records,
  saveRecord,
  STATE_KEY,
  type DeploymentRecord,
  type ProjectLock,
  type ProjectState,
  writeJson,
} from './state.ts';

export function settingsOf(settings: DeploySettings): AwsDeploySettings {
  if (settings.aws === undefined)
    throw new Error('deploy.aws is required for an AWS Fargate deployment');
  if (settings.aws.compute !== 'fargate')
    throw new Error('this lifecycle only serves the AWS Fargate compute driver');
  return settings.aws;
}

export function say(message: string): void {
  console.log(`upwind: ${message}`);
}

export async function stateOf(context: AwsContext, bucket: string): Promise<ProjectState> {
  return (await readJson<ProjectState>(context, bucket, STATE_KEY))?.value ?? { v: 1 };
}

async function saveState(context: AwsContext, bucket: string, value: ProjectState): Promise<void> {
  const held = await readJson<ProjectState>(context, bucket, STATE_KEY);
  await writeJson(context, bucket, STATE_KEY, value, held?.etag);
}

export async function recordOf(
  context: AwsContext,
  bucket: string,
  id: string,
): Promise<DeploymentRecord> {
  const stored = await readJson<DeploymentRecord>(context, bucket, recordKey(id));
  if (
    stored === undefined ||
    stored.value.v !== 1 ||
    stored.value.compute !== 'fargate' ||
    stored.value.deploymentId !== id
  )
    throw new Error(`AWS deployment ${id} has no valid retained record`);
  return stored.value;
}

/** Reconcile a crash after a confirmed ALB write but before its S3 control record was committed. */
export async function reconcile(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  project: string,
  lock: ProjectLock,
): Promise<ProjectState> {
  const state = await stateOf(context, bootstrap.ArtifactsBucket);
  if (state.destroying)
    throw new Error('this AWS project is being destroyed; finish destroy before deploying again');
  const route = await productionRule(context, bootstrap.ListenerArn, project);
  const target = targetOf(route);
  if (target === undefined) {
    if (state.current !== undefined)
      throw new Error(
        'AWS production routing disappeared; restore the listener rule before deploying',
      );
    return state;
  }
  const candidates = (await records(context, bootstrap.ArtifactsBucket)).filter(
    (record) => record.targetGroupArn === target && record.status !== 'deleted',
  );
  if (candidates.length !== 1 || candidates[0] === undefined || route?.RuleArn === undefined)
    throw new Error(
      'AWS production routing names no unique retained deployment; nothing was changed',
    );
  const live = candidates[0];
  if (state.current === live.deploymentId && state.productionRuleArn === route.RuleArn)
    return state;
  await lock.assertHeld();
  const next: ProjectState = { v: 1, current: live.deploymentId, productionRuleArn: route.RuleArn };
  await saveRecord(context, bootstrap.ArtifactsBucket, {
    ...live,
    status: 'live',
    lastServed: new Date(context.now()).toISOString(),
  });
  await saveState(context, bootstrap.ArtifactsBucket, next);
  return next;
}

async function markLive(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  record: DeploymentRecord,
  rule: string,
): Promise<void> {
  await saveRecord(context, bootstrap.ArtifactsBucket, {
    ...record,
    status: 'live',
    lastServed: new Date(context.now()).toISOString(),
  });
  await saveState(context, bootstrap.ArtifactsBucket, {
    v: 1,
    current: record.deploymentId,
    productionRuleArn: rule,
  });
}

export async function activateRecord(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  settings: DeploySettings,
  record: DeploymentRecord,
  state: ProjectState,
  lock: ProjectLock,
): Promise<void> {
  await verifyCacheDurability(context, bootstrap);
  const target = record.targetGroupArn;
  if (target === undefined) throw new Error('deployment has no target group');
  await checkDeployment(context, {
    target,
    tasks: record.settings.tasks,
    origin: record.publicOrigin,
    ...(!bootstrap.DistributionId && bootstrap.LoadBalancerDnsName !== undefined
      ? { loadBalancerDnsName: bootstrap.LoadBalancerDnsName }
      : {}),
    token: record.probeToken,
    deploymentId: record.deploymentId,
    checks: settings.checks,
  });
  const previous =
    state.current === undefined
      ? undefined
      : await recordOf(context, bootstrap.ArtifactsBucket, state.current);
  const rule = await switchProduction(context, {
    listener: bootstrap.ListenerArn,
    project: settings.project,
    target,
    lock,
    ...(previous?.targetGroupArn === undefined ? {} : { expectedTarget: previous.targetGroupArn }),
  });
  try {
    await checkDeployment(context, {
      target,
      tasks: record.settings.tasks,
      origin: record.publicOrigin,
      ...(!bootstrap.DistributionId && bootstrap.LoadBalancerDnsName !== undefined
        ? { loadBalancerDnsName: bootstrap.LoadBalancerDnsName }
        : {}),
      deploymentId: record.deploymentId,
      checks: settings.checks,
    });
  } catch (error) {
    // No old task is scaled down before this check. Restore only the route this operation set.
    if (previous?.targetGroupArn !== undefined) {
      await switchProduction(context, {
        listener: bootstrap.ListenerArn,
        project: settings.project,
        target: previous.targetGroupArn,
        expectedTarget: target,
        lock,
      });
    } else if (
      targetOf(await productionRule(context, bootstrap.ListenerArn, settings.project)) === target
    ) {
      await removeProduction(context, bootstrap.ListenerArn, settings.project, lock);
    }
    throw error;
  }
  await markLive(context, bootstrap, record, rule);
  say(`${record.deploymentId} is live at ${record.publicOrigin}`);
}

export async function stageRecord(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  settings: DeploySettings,
  receipt: FargateBuildReceipt,
  secrets: ReadonlyMap<string, string>,
  message: string | undefined,
  io: AwsLifecycleIo,
): Promise<DeploymentRecord> {
  const aws = settingsOf(settings);
  const bucket = bootstrap.ArtifactsBucket;
  const held = await readJson<DeploymentRecord>(context, bucket, recordKey(receipt.deploymentId));
  if (held !== undefined) {
    if (held.value.compute !== 'fargate')
      throw new Error('the retained deployment belongs to another AWS compute driver');
    if (held.value.archiveSha256 !== receipt.archiveSha256)
      throw new Error('a different image archive already owns this immutable deployment ID');
    if (
      held.value.status === 'deleted' ||
      held.value.cacheRetired === true ||
      held.value.retiring === true
    )
      throw new Error(
        'this prebuilt deployment has been retired; build a new immutable deployment',
      );
    if (
      held.value.settings.region !== aws.region ||
      held.value.settings.architecture !== aws.architecture
    )
      throw new Error('the prebuilt deployment belongs to different AWS settings');
    if (held.value.status === 'staging')
      return resumeStaging(context, bootstrap, settings, held.value);
    await scale(context, settings.project, held.value, held.value.settings.tasks);
    return held.value;
  }
  const image = await pushImage(context, bootstrap, receipt, io);
  await uploadStatic(context, bucket, receipt);
  const secretArn = await deploymentSecret(
    context,
    settings.project,
    receipt.deploymentId,
    secrets,
  );
  const probe = probeIdentity(await listenerRules(context, bootstrap.ListenerArn));
  const publicOrigin = bootstrap.PublicOrigin;
  const template = JSON.stringify(
    deploymentTemplate({
      project: settings.project,
      deploymentId: receipt.deploymentId,
      settings: aws,
      image,
      bootstrap,
      publicOrigin,
      probeToken: probe.token,
      probePriority: probe.priority,
      secrets:
        secretArn === undefined
          ? []
          : [...secrets.keys()].map((name) => ({ name, valueFrom: `${secretArn}:${name}::` })),
    }),
  );
  const record: DeploymentRecord = {
    v: 1,
    compute: 'fargate',
    deploymentId: receipt.deploymentId,
    stackName: deploymentStackName(settings.project, receipt.deploymentId),
    createdAt: new Date(context.now()).toISOString(),
    image,
    imageTag: receipt.deploymentId,
    archiveSha256: receipt.archiveSha256,
    safeStaticBypass: receipt.safeStaticBypass,
    template,
    probeToken: probe.token,
    probePriority: probe.priority,
    settings: aws,
    publicOrigin,
    ...(secretArn === undefined ? {} : { secretArn }),
    ...(message === undefined ? {} : { message }),
    status: 'staging',
  };
  await saveRecord(context, bucket, record);
  const deployment = await createStack(context, settings.project, record.stackName, template);
  const targetGroupArn = outputs(deployment)['TargetGroupArn'];
  if (targetGroupArn === undefined)
    throw new Error('the AWS deployment stack returned no target group');
  const taskDefinitionArn = outputs(deployment)['TaskDefinitionArn'];
  if (taskDefinitionArn === undefined)
    throw new Error('the AWS deployment stack returned no task definition');
  const staged = { ...record, targetGroupArn, taskDefinitionArn };
  await saveRecord(context, bucket, staged);
  return staged;
}

/** Recover a stopped run both before stack creation and before its outputs were persisted. */
async function resumeStaging(
  context: AwsContext,
  bootstrap: AwsBootstrapOutputs,
  settings: DeploySettings,
  initial: DeploymentRecord,
): Promise<DeploymentRecord> {
  let record = initial;
  if (record.stackName !== deploymentStackName(settings.project, record.deploymentId))
    throw new Error('deployment stack does not match its identity');
  let existing = await stack(context, record.stackName);
  if (existing !== undefined) owned(existing, settings.project);
  if (existing?.StackStatus?.endsWith('_IN_PROGRESS')) {
    try {
      existing = await waitStack(context, record.stackName);
    } catch (error) {
      if (error instanceof UncertainAwsMutation) throw error;
      existing = await stack(context, record.stackName);
      if (existing?.StackStatus !== 'ROLLBACK_COMPLETE') throw error;
    }
  }
  if (existing?.StackStatus === 'ROLLBACK_COMPLETE') {
    const target = outputs(existing)['TargetGroupArn'] ?? record.targetGroupArn;
    if (
      target !== undefined &&
      targetOf(await productionRule(context, bootstrap.ListenerArn, settings.project)) === target
    )
      throw new Error(
        'the failed staging stack still receives production traffic; refusing to recreate it',
      );
    await deleteStack(context, settings.project, record.stackName);
    existing = undefined;
  }
  if (existing === undefined) {
    const rules = await listenerRules(context, bootstrap.ListenerArn);
    if (rules.some((rule) => Number(rule.Priority) === record.probePriority)) {
      const probe = probeIdentity(rules);
      const template = JSON.parse(record.template) as {
        Resources: Record<string, { Properties: Record<string, unknown> }>;
      };
      const properties = template.Resources['ProbeRule']?.Properties;
      if (properties === undefined)
        throw new Error('the staging template has no managed probe rule');
      properties['Priority'] = probe.priority;
      properties['Conditions'] = [
        {
          Field: 'http-header',
          HttpHeaderConfig: { HttpHeaderName: 'X-Upwind-Probe', Values: [probe.token] },
        },
        { Field: 'path-pattern', PathPatternConfig: { Values: ['/*'] } },
      ];
      record = {
        ...record,
        probePriority: probe.priority,
        probeToken: probe.token,
        template: JSON.stringify(template),
      };
      await saveRecord(context, bootstrap.ArtifactsBucket, record);
    }
  }
  if (existing?.StackStatus === 'UPDATE_ROLLBACK_COMPLETE') {
    await updateStack(
      context,
      settings.project,
      record.stackName,
      withDesiredCount(record.template, record.settings.tasks),
    );
    existing = await stack(context, record.stackName);
  } else {
    existing = await createStack(context, settings.project, record.stackName, record.template);
    await scale(context, settings.project, record, record.settings.tasks);
  }
  if (existing === undefined) throw new Error('the resumed staging stack disappeared');
  const values = outputs(existing);
  const targetGroupArn = values['TargetGroupArn'];
  const taskDefinitionArn = values['TaskDefinitionArn'];
  if (targetGroupArn === undefined || taskDefinitionArn === undefined)
    throw new Error('the resumed staging stack returned no target group or task definition');
  const resumed = { ...record, targetGroupArn, taskDefinitionArn };
  await saveRecord(context, bootstrap.ArtifactsBucket, resumed);
  return resumed;
}

export { scaleDeployment as scale } from './stacks.ts';
export { retain, finishRetention } from './retention.ts';
