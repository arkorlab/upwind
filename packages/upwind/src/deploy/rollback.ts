import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { stageDeployment } from '@stayingupwind/deploy/deploy';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';
import { bundleObjectKey } from '@stayingupwind/host/storage';

import { type AccountView, bucketRefusal, readAccount, resolveAccount } from './account.ts';
import { activate, liveVersionOf } from './activate.ts';
import { openAgent } from './agent-session.ts';
import type { RollbackOptions } from './args.ts';
import { createCloudflareClient } from './cloudflare/client.ts';
import type { AccountScope, ScriptSubdomain } from './cloudflare/workers.ts';
import { type DeploySettings, readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';
import { narrowReach, report, siteOf } from './deploy-run.ts';
import { uploadEdgeVersion } from './edge-version.ts';
import {
  type DeploymentRecord,
  type EdgeHistory,
  functionsRemain,
  pointerOf,
  readHistory,
} from './history.ts';
import { appRuntimeOf, type ProjectNames, projectNames } from './names.ts';
import { publishPointer } from './pointer.ts';
import { shippedWorkers } from './shipped.ts';
import type { ProjectStores } from './stores.ts';
import { type RemoteTarget, storedTarget } from './target.ts';

/**
 * `upwind rollback`: the edge's traffic given back to an older deployment.
 *
 * The deployment is published again, against the one live now, as a deploy publishes a new one
 * against the one before it: its bundle, kept in the bucket since it was deployed, is staged again
 * with the live deployment's as `previous`, so the files the live deployment's pages still ask for
 * stay served beside it — a page of the live deployment open in a browser keeps loading its own
 * scripts after the rollback. Its Functions are the ones it has had since it was deployed; nothing
 * of it is built or uploaded but a version of the edge, with the new pointer fixed in it.
 *
 * It is staged through the deploy agent, uploaded with a key of the rollback's own as a deploy
 * uploads it: a deploy of the project running at the same time loses the agent, and stops. One
 * deploy or rollback of a project runs at a time.
 *
 * Then the same check-then-switch a deploy makes (`activate.ts`): the version given a share of none
 * beside the live one, asked by name whether it answers as its deployment, each of the project's
 * checks asked through it, and only then given all of the traffic. One that fails is given none.
 *
 * Where the bucket keeps no bundle of the deployment, its own version of the edge is switched to as
 * it stands — whose manifest carries none of the live deployment's files — and the run says so.
 *
 * Which deployment: the one named (`--to`), or the newest before the live one that can be rolled
 * back to — whose edge version a deployment of the edge can still choose, and whose Functions are
 * all on the account still.
 */

export interface RollbackIo {
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

/** A deployment to go back to, with the manifest its pointer names. */
interface Target {
  readonly record: DeploymentRecord;
  readonly manifestId: string;
}

/** What a version of the edge serves: its deployment and its manifest, by the version's id. */
interface Served {
  readonly versionId: string;
  readonly manifestId: string;
}

function warn(text: string): void {
  console.warn(`upwind: warning: ${text}`);
}

/** Why the deployment cannot be rolled back to; nothing where it can, and its manifest. */
async function targetOf(
  scope: AccountScope,
  names: ProjectNames,
  history: EdgeHistory,
  record: DeploymentRecord,
): Promise<Target | string> {
  if (!record.reachable) {
    return `${record.deploymentId}'s edge version is older than the 100 a deployment of the edge can choose from`;
  }
  const pointer = await pointerOf(scope, names.edge, record.versionId);
  if (pointer?.manifestId === undefined) {
    return `${record.deploymentId}'s edge version has no pointer to a manifest`;
  }
  if (!functionsRemain(history, pointer)) {
    return `${record.deploymentId}'s Functions are no longer on the account`;
  }
  return { record, manifestId: pointer.manifestId };
}

/** The deployment to roll back to, or why there is none. */
async function chosen(
  scope: AccountScope,
  names: ProjectNames,
  history: EdgeHistory,
  to: string | undefined,
): Promise<Target | string> {
  const liveVersion = liveVersionOf(history.current);
  if (to !== undefined) {
    const named = history.deployments.find((record) => record.deploymentId === to);
    if (named === undefined) {
      return `no version of ${names.edge} serves ${to}`;
    }
    return named.versionId === liveVersion
      ? `${to} is the deployment the edge serves`
      : targetOf(scope, names, history, named);
  }
  const at = history.deployments.findIndex((record) => record.versionId === liveVersion);
  if (at === -1) {
    // Nothing says which deployments came before a version no deploy tagged.
    return `${names.edge}'s live version ${liveVersion} is not one upwind deploy made, so which deployment came before it is not known; name one with --to`;
  }
  // Newest first, so what follows the live one is older than it.
  const older = history.deployments.slice(at + 1);
  for (const record of older) {
    const target = await targetOf(scope, names, history, record);
    if (typeof target !== 'string') {
      return target;
    }
  }
  return 'no deployment before the live one can be rolled back to';
}

/** The deployment the edge serves now, as the deploy that made its version tagged it. */
function liveDeploymentOf(history: EdgeHistory): string | undefined {
  const liveVersion = liveVersionOf(history.current);
  return history.deployments.find((record) => record.versionId === liveVersion)?.deploymentId;
}

/** A deployment's bundle as the bucket keeps it, and the bytes it was kept as. */
async function bundleIn(
  target: RemoteTarget,
  project: string,
  deploymentId: string,
): Promise<{ readonly bundle: DeploymentBundle; readonly json: string } | undefined> {
  const bytes = await target.bucket.get(bundleObjectKey(project, deploymentId));
  if (bytes === undefined) {
    return undefined;
  }
  const json = new TextDecoder().decode(bytes);
  return { bundle: deploymentBundleSchema.parse(JSON.parse(json)), json };
}

/** The project's stores, as the owner mark records them; or why a rollback cannot use them. */
function storesOf(
  names: ProjectNames,
  account: AccountView,
): { readonly stores?: ProjectStores; readonly refused?: string } {
  const refused = bucketRefusal(names, account.owner);
  if (refused !== undefined) {
    return { refused };
  }
  const edgeState = account.owner?.made[names.edgeStateTitle];
  const cacheState = account.owner?.made[names.cacheStateTitle];
  if (edgeState === undefined || cacheState === undefined) {
    return {
      refused: `the owner mark in ${names.artifactsBucket} records none of the project's namespaces; deploy again before rolling back`,
    };
  }
  return { stores: { edgeState, cacheState, bucket: names.artifactsBucket, storage: [] } };
}

interface Restaging {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  readonly settings: DeploySettings;
  readonly account: AccountView & { readonly subdomain: string };
  readonly stores: ProjectStores;
  readonly site: { readonly hostnames: readonly string[] };
  readonly target: RemoteTarget;
  readonly deploymentId: string;
  /** The deployment live now, whose files stay served; nothing where no deploy tagged it. */
  readonly live: string | undefined;
  readonly reach: ScriptSubdomain;
  readonly message: string;
  readonly io: RollbackIo;
}

/**
 * The deployment staged and published again, against the live one, and a version of the edge for
 * it uploaded; nothing where the bucket keeps no bundle of it.
 */
async function restage(input: Restaging): Promise<Served | undefined> {
  const { scope, names, settings, account, target, deploymentId } = input;
  const kept = await bundleIn(target, names.project, deploymentId);
  if (kept === undefined) {
    return undefined;
  }
  const previous =
    input.live === undefined ? undefined : await bundleIn(target, names.project, input.live);
  if (previous === undefined && input.live !== undefined) {
    warn(
      `${names.artifactsBucket} keeps no bundle of ${input.live}, so its files are not carried over; its pages still open may lose them`,
    );
  }
  const app = appRuntimeOf(names.project, kept.bundle);
  const staged = await stageDeployment(target, {
    bundle: kept.bundle,
    json: kept.json,
    ...(previous !== undefined && { previous: previous.bundle }),
    projectId: names.project,
    runId: createId('run'),
    originHost: settings.hostnames[0] ?? `${names.edge}.${account.subdomain}.workers.dev`,
    environment: 'production',
    owner: scope.accountId,
    app,
    recoverySource: await recoveryScriptCspSource(),
    now: input.io.now ?? Date.now,
  });
  const pointer = await publishPointer({
    target,
    staged,
    settings,
    now: input.io.now,
    sleep: input.io.sleep,
  });
  const scripts = await shippedWorkers();
  const edge = await uploadEdgeVersion({
    scope,
    names,
    stores: input.stores,
    script: scripts.edge,
    pointer,
    app,
    hostnames: input.site.hostnames.join(','),
    images: settings.images,
    reach: input.reach,
    message: input.message,
    existing: new Set(account.projectWorkers),
  });
  return { versionId: edge.versionId, manifestId: staged.manifestId };
}

/** Why the account cannot be rolled back on; nothing where it can. */
function refusalOf(
  names: ProjectNames,
  settings: DeploySettings,
  account: AccountView,
): string | undefined {
  if (account.subdomain !== undefined) {
    return undefined;
  }
  // The deploy agent is reached on `workers.dev`, and so is the edge where the settings say.
  return account.bucket !== undefined || settings.workersDev
    ? `the account has no workers.dev subdomain, where ${names.agent} and the edge are reached; choose one in Cloudflare's settings for Workers`
    : undefined;
}

/** Roll the edge back; what the command exits with. */
export async function runRollback(
  options: RollbackOptions,
  credentials: CloudflareCredentials | undefined,
  io: RollbackIo = {},
): Promise<number> {
  if (credentials === undefined) {
    console.error(
      'upwind: rollback reaches the account with CLOUDFLARE_API_TOKEN, which is not set',
    );
    return 1;
  }
  const settings = await readDeploySettings(options.projectDir);
  const names = projectNames(settings.project);
  const client = createCloudflareClient({ apiToken: credentials.apiToken, fetch: io.fetch });
  const scope = { client, accountId: await resolveAccount(client, credentials.accountId) };
  const [account, history] = await Promise.all([
    readAccount(scope, names),
    readHistory(scope, names),
  ]);
  if (history.current === undefined) {
    console.error(`upwind: ${names.edge} serves no deployment, so there is nothing to roll back`);
    return 1;
  }
  const target = await chosen(scope, names, history, options.to);
  if (typeof target === 'string') {
    console.error(`upwind: ${target}`);
    return 1;
  }
  const refused = refusalOf(names, settings, account);
  if (refused !== undefined) {
    console.error(`upwind: ${refused}`);
    return 1;
  }
  const site = siteOf(settings, names, account.subdomain ?? '');
  const { deploymentId } = target.record;
  const message = `upwind rollback to ${deploymentId}`;
  const reach: ScriptSubdomain = { enabled: settings.workersDev, previews_enabled: false };
  const switchTo = async (served: Served): Promise<number> => {
    console.log(`upwind: checking ${names.edge} version ${served.versionId}, of ${deploymentId}`);
    const activation = await activate({
      scope,
      edge: names.edge,
      origin: site.origin,
      expected: { deploymentId, ...served },
      first: false,
      checks: settings.checks,
      message,
      fetch: io.fetch,
      sleep: io.sleep,
      now: io.now,
    });
    if (activation.kind === 'live' || activation.kind === 'unconfirmed') {
      await narrowReach(scope, names.edge, reach);
    }
    return report(activation, deploymentId, site.origin);
  };
  const asItStands: Served = { versionId: target.record.versionId, manifestId: target.manifestId };
  const { subdomain } = account;
  if (subdomain === undefined || account.bucket === undefined) {
    warn(
      `${names.artifactsBucket} is not on the account, so ${deploymentId}'s version is switched to as it stands, without the live deployment's files; its pages still open may lose them`,
    );
    return switchTo(asItStands);
  }
  const { stores, refused: unusable } = storesOf(names, account);
  if (stores === undefined) {
    console.error(`upwind: ${String(unusable)}`);
    return 1;
  }
  const session = await openAgent({
    scope,
    names,
    stores,
    script: (await shippedWorkers()).agent,
    subdomain,
    mode: 'deploy',
    existing: new Set(account.projectWorkers),
    withCache: true,
    fetch: io.fetch,
    sleep: io.sleep,
    now: io.now,
  });
  try {
    const restaged = await restage({
      scope,
      names,
      settings,
      account: { ...account, subdomain },
      stores,
      site,
      target: storedTarget(session.client),
      deploymentId,
      live: liveDeploymentOf(history),
      reach,
      message,
      io,
    });
    if (restaged === undefined) {
      warn(
        `${names.artifactsBucket} keeps no bundle of ${deploymentId}, so its version is switched to as it stands, without the live deployment's files; its pages still open may lose them`,
      );
    }
    return await switchTo(restaged ?? asItStands);
  } finally {
    await session.close();
  }
}
