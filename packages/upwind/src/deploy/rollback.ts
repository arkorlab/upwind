import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { DeployRefusalError, stageDeployment } from '@stayingupwind/deploy/deploy';
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
  wayBackOrder,
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
 * Which deployment: the one named (`--to`), or one first deployed before the live one that can be
 * rolled back to — whose edge version a deployment of the edge can still choose, and whose
 * Functions are all on the account still — the one the edge served most recently first
 * (`wayBackOrder`). Before, not merely older in upload: a deployment rolled back to has a new
 * version, and rolling back again from it goes further back, never forward to the one it replaced.
 *
 * A deployment whose cache scope is retired cannot be gone back to: a deploy's cleanup retires a
 * scope before it deletes the deployment's Functions, and one stopped between leaves the Functions
 * of a deployment it was taking away. Its staging is refused (`cache_scope_conflict`), nothing is
 * switched to it, and a rollback that named none goes on to the one before it.
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

/** The deployments a rollback may go to, in the order it tries them; or why there are none. */
interface Candidates {
  readonly records: readonly DeploymentRecord[];
  readonly refused?: string;
}

function candidatesOf(
  names: ProjectNames,
  history: EdgeHistory,
  to: string | undefined,
): Candidates {
  const liveVersion = liveVersionOf(history.current);
  if (to !== undefined) {
    const named = history.deployments.find((record) => record.deploymentId === to);
    if (named === undefined) {
      return { records: [], refused: `no version of ${names.edge} serves ${to}` };
    }
    return named.versionId === liveVersion
      ? { records: [], refused: `${to} is the deployment the edge serves` }
      : { records: [named] };
  }
  const live = history.deployments.find((record) => record.versionId === liveVersion);
  if (live === undefined) {
    // Nothing says which deployments came before a version no deploy tagged.
    return {
      records: [],
      refused: `${names.edge}'s live version ${liveVersion} is not one upwind deploy made, so which deployment came before it is not known; name one with --to`,
    };
  }
  const records = history.deployments
    .filter((record) => record.firstDeployed < live.firstDeployed)
    .toSorted(wayBackOrder);
  return { records };
}

/** A candidate that can be rolled back to, from `start` on, and where to go on from; or why none can. */
async function firstTarget(
  input: {
    readonly scope: AccountScope;
    readonly names: ProjectNames;
    readonly history: EdgeHistory;
    readonly named: boolean;
  },
  candidates: readonly DeploymentRecord[],
  start: number,
): Promise<string | { readonly target: Target; readonly next: number }> {
  for (const [index, record] of candidates.entries()) {
    if (index < start) {
      continue;
    }
    const target = await targetOf(input.scope, input.names, input.history, record);
    if (typeof target !== 'string') {
      return { target, next: index + 1 };
    }
    if (input.named) {
      return target;
    }
  }
  return 'no deployment before the live one can be rolled back to';
}

/** Whether staging was refused for the deployment's cache scope: retired, by a stopped cleanup. */
function scopeRetired(error: unknown): error is DeployRefusalError {
  return error instanceof DeployRefusalError && error.code === 'cache_scope_conflict';
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

function messageOf(deploymentId: string): string {
  return `upwind rollback to ${deploymentId}`;
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

/** What a rollback tries the candidates with, once it holds the agent. */
interface Rolling {
  readonly restaging: Omit<Restaging, 'deploymentId' | 'message'>;
  readonly choosing: Parameters<typeof firstTarget>[0];
  readonly candidates: readonly DeploymentRecord[];
  readonly found: { readonly target: Target; readonly next: number };
  readonly switchTo: (deploymentId: string, served: Served) => Promise<number>;
}

/** The deployment published again; or the refusal of a retired cache scope, which is no failure. */
async function restageUnlessRetired(
  restaging: Rolling['restaging'],
  deploymentId: string,
): Promise<Served | DeployRefusalError | undefined> {
  try {
    return await restage({ ...restaging, deploymentId, message: messageOf(deploymentId) });
  } catch (error) {
    if (scopeRetired(error)) {
      return error;
    }
    throw error;
  }
}

/**
 * Publish the first candidate again and switch to it — passing over one whose cache scope is
 * retired, to the next, where none was named; what the command exits with.
 */
async function rollThrough(input: Rolling): Promise<number> {
  const { restaging, choosing, candidates, switchTo } = input;
  const { names } = restaging;
  let found: string | { readonly target: Target; readonly next: number } = input.found;
  while (typeof found !== 'string') {
    const { record, manifestId } = found.target;
    const { deploymentId } = record;
    const restaged = await restageUnlessRetired(restaging, deploymentId);
    if (!(restaged instanceof Error)) {
      if (restaged === undefined) {
        warn(
          `${names.artifactsBucket} keeps no bundle of ${deploymentId}, so its version is switched to as it stands, without the live deployment's files; its pages still open may lose them`,
        );
      }
      return switchTo(deploymentId, restaged ?? { versionId: record.versionId, manifestId });
    }
    const why = `${deploymentId}'s cache scope refuses it (${restaged.message}): a cleanup that retired the scope stopped before deleting the deployment's Functions, which the next deploy deletes, so it cannot be gone back to`;
    if (choosing.named) {
      console.error(`upwind: ${why}`);
      return 1;
    }
    warn(`${why}; trying the deployment before it`);
    found = await firstTarget(choosing, candidates, found.next);
  }
  console.error(`upwind: ${found}`);
  return 1;
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
  const { records: candidates, refused: none } = candidatesOf(names, history, options.to);
  if (none !== undefined) {
    console.error(`upwind: ${none}`);
    return 1;
  }
  const choosing = { scope, names, history, named: options.to !== undefined };
  const found = await firstTarget(choosing, candidates, 0);
  if (typeof found === 'string') {
    console.error(`upwind: ${found}`);
    return 1;
  }
  const refused = refusalOf(names, settings, account);
  if (refused !== undefined) {
    console.error(`upwind: ${refused}`);
    return 1;
  }
  const site = siteOf(settings, names, account.subdomain ?? '');
  const reach: ScriptSubdomain = { enabled: settings.workersDev, previews_enabled: false };
  const switchTo = async (deploymentId: string, served: Served): Promise<number> => {
    console.log(`upwind: checking ${names.edge} version ${served.versionId}, of ${deploymentId}`);
    const activation = await activate({
      scope,
      edge: names.edge,
      origin: site.origin,
      expected: { deploymentId, ...served },
      first: false,
      checks: settings.checks,
      message: messageOf(deploymentId),
      fetch: io.fetch,
      sleep: io.sleep,
      now: io.now,
    });
    if (activation.kind === 'live' || activation.kind === 'unconfirmed') {
      await narrowReach(scope, names.edge, reach);
    }
    return report(activation, deploymentId, site.origin);
  };
  const { subdomain } = account;
  if (subdomain === undefined || account.bucket === undefined) {
    const { record, manifestId } = found.target;
    warn(
      `${names.artifactsBucket} is not on the account, so ${record.deploymentId}'s version is switched to as it stands, without the live deployment's files; its pages still open may lose them`,
    );
    return switchTo(record.deploymentId, { versionId: record.versionId, manifestId });
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
    return await rollThrough({
      restaging: {
        scope,
        names,
        settings,
        account: { ...account, subdomain },
        stores,
        site,
        target: storedTarget(session.client),
        live: liveDeploymentOf(history),
        reach,
        io,
      },
      choosing,
      candidates,
      found,
      switchTo,
    });
  } finally {
    await session.close();
  }
}
