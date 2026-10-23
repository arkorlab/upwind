import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { type StagedDeployment, stageDeployment } from '@stayingupwind/deploy/deploy';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';
import { bundleObjectKey } from '@stayingupwind/host/storage';

import type { AgentClient } from './agent-client.ts';
import { appRuntimeOf } from './names.ts';
import { remoteTarget, uploadBuildBlobs } from './target.ts';

/**
 * A build staged on the account (`stageDeployment`), through the agent: its blobs in the bucket,
 * its shells and artifacts where the edge reads them, its scope of the runtime cache seeded — and
 * the bundle itself kept beside them, under the deployment's id, for the next deployment to stage
 * against and for a rollback to know what it rolls back to.
 *
 * The deployment live before this one is staged against (`previous`): its static files stay
 * served beside this one's, for the pages of it still open in a browser.
 */

export interface StageInput {
  readonly agent: AgentClient;
  readonly bundleDir: string;
  readonly bundle: DeploymentBundle;
  /** The bundle as the build wrote it, which the deployment's fingerprint is the digest of. */
  readonly json: string;
  readonly project: string;
  /** Whose the deployment is: the account's id. */
  readonly owner: string;
  readonly originHost: string;
  /** The deployment live before this one, if one is. */
  readonly previous: string | undefined;
  readonly now?: (() => number) | undefined;
}

/** The bundle a deployment was staged from, as the bucket keeps it; nothing where it keeps none. */
async function previousBundle(input: StageInput): Promise<DeploymentBundle | undefined> {
  if (input.previous === undefined || input.previous === input.bundle.deploymentId) {
    return undefined;
  }
  const target = remoteTarget(input.agent, input.bundleDir);
  const bytes = await target.bucket.get(bundleObjectKey(input.project, input.previous));
  if (bytes === undefined) {
    return undefined;
  }
  return deploymentBundleSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}

/** Stage the build, and keep its bundle beside what was staged. */
export async function stageBuild(input: StageInput): Promise<StagedDeployment> {
  const { agent, bundleDir, bundle, project } = input;
  const previous = await previousBundle(input);
  await uploadBuildBlobs(agent, bundleDir, bundle);
  const target = remoteTarget(agent, bundleDir);
  const staged = await stageDeployment(target, {
    bundle,
    json: input.json,
    ...(previous !== undefined && { previous }),
    projectId: project,
    runId: createId('run'),
    originHost: input.originHost,
    environment: 'production',
    owner: input.owner,
    app: appRuntimeOf(project, bundle),
    recoverySource: await recoveryScriptCspSource(),
    now: input.now ?? Date.now,
  });
  await target.bucket.put(bundleObjectKey(project, bundle.deploymentId), input.json, {
    contentType: 'application/json',
  });
  return staged;
}
