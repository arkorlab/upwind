import { type DeploymentBundle, deploymentBundleSchema } from '@stayingupwind/core/bundle';
import { createId } from '@stayingupwind/core/util';
import { DeployRefusalError, stageDeployment } from '@stayingupwind/deploy/deploy';
import { recoveryScriptCspSource } from '@stayingupwind/host/splice';
import { bundleObjectKey } from '@stayingupwind/host/storage';

import { type AccountView, bucketRefusal, readAccount, resolveAccount } from './account.ts';
import { activate, liveVersionOf } from './activate.ts';
import type { AgentClient } from './agent-client.ts';
import { openAgent } from './agent-session.ts';
import type { RollbackOptions } from './args.ts';
import { createCloudflareClient } from './cloudflare/client.ts';
import type { AccountScope, ScriptSubdomain } from './cloudflare/workers.ts';
import { type DeploySettings, readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';
import { type CronTable, holdCrons, rollbackCronSecret, rollbackCrons } from './crons.ts';
import { narrowReach, report, siteOf } from './deploy-run.ts';
import { uploadEdgeVersion } from './edge-version.ts';
import {
  cacheKeyMadeAt,
  type DeploymentRecord,
  type EdgeHistory,
  functionsRemain,
  pointerOf,
  readHistory,
  uploadedBefore,
  wayBackOrder,
} from './history.ts';
import { appRuntimeOf, type ProjectNames, projectNames } from './names.ts';
import { publishPointer } from './pointer.ts';
import { withProjectLock } from './project-lock.ts';
import { shippedWorkers } from './shipped.ts';
import type { ProjectStores } from './stores.ts';
import { blobsMissing, type RemoteTarget, storedTarget } from './target.ts';

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
 * Where the live deployment's files cannot be carried over — no bundle of it kept, or one this
 * version cannot read — the rollback says so and goes on without them, its pages still open losing
 * them; a file of it the bucket no longer holds is left out alone, and the rest carried over. That
 * is asked once, before any deployment is tried (`carriedOver`): what is wrong with the live
 * deployment is no fault of the one gone back to, and stops no rollback, which is often run because
 * the live deployment is broken.
 *
 * It is staged through the deploy agent, uploaded with a key of the rollback's own as a deploy
 * uploads it: a deploy of the project running at the same time loses the agent, and stops. One
 * deploy or rollback of a project runs at a time.
 *
 * Then the same check-then-switch a deploy makes (`activate.ts`): the version given a share of none
 * beside the live one, asked by name whether it answers as its deployment, each of the project's
 * checks asked through it, and only then given all of the traffic. One that fails is given none.
 *
 * A deployment is gone back to only by publishing it again. Its own version of the edge, as it
 * stands, carries none of the live deployment's files, and nothing about it says whether its cache
 * scope still answers — a cleanup that stopped part way retires a scope before it deletes the
 * Functions. So where the bucket keeps no bundle of a deployment, it cannot be gone back to: one
 * named is refused, its build to be deployed again instead, and a rollback that named none goes on
 * to the one before it. Nor is a project rolled back that keeps no bucket at all.
 *
 * Which deployment: the one named (`--to`), or one first deployed before the live one that can be
 * rolled back to — whose edge version a deployment of the edge can still choose, and whose
 * Functions are all on the account still — the one the edge served most recently first
 * (`wayBackOrder`). Before, not merely older in upload: a deployment rolled back to has a new
 * version, and rolling back again from it goes further back, never forward to the one it replaced.
 *
 * Nor can one deployed before the runtime cache's key was reset (`--reset-cache-key`): its
 * Functions hold a token signed under the key before, which the cache refuses, and a rollback
 * uploads no Function — so one named is refused, its build to be deployed again instead, and one
 * not named is passed over. That is told by when Cloudflare says each was uploaded: a Function
 * uploaded before the cache's key was made (`uploadedBefore`).
 *
 * A deployment whose cache scope is retired cannot be gone back to: a deploy's cleanup retires a
 * scope before it deletes the deployment's Functions, and one stopped between leaves the Functions
 * of a deployment it was taking away. Its staging is refused (`cache_scope_conflict`), nothing is
 * switched to it, and a rollback that named none goes on to the one before it.
 *
 * Nor can one whose staging or publishing is refused for any other reason (`DeployRefusalError`)
 * — a blob of its build gone from the bucket, a kept bundle this version cannot read, a pointer
 * over what the edge's variable holds: a refusal is the deployment's own. One named is refused,
 * saying why; a rollback that named none goes on to the one before it, and where none is left
 * refuses, saying why of each one it tried. What is no refusal — the account, the agent or a store
 * failing — is no fault of the deployment's, and stops the rollback.
 */

export interface RollbackIo {
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

/** What a version of the edge serves: its deployment and its manifest, by the version's id. */
interface Served {
  readonly versionId: string;
  readonly manifestId: string;
  /** The deployment's cron jobs, which the edge fires once its version has the traffic. */
  readonly crons: CronTable;
}

function warn(text: string): void {
  console.warn(`upwind: warning: ${text}`);
}

/** What a rollback chooses the deployment it goes back to by. */
interface Choosing {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  readonly history: EdgeHistory;
  /** Whether the deployment was named (`--to`): one named is refused, never passed over. */
  readonly named: boolean;
  /** When the key the cache's Workers check a Function's token with now was made (`cacheKeyMadeAt`). */
  readonly keyMadeAt: number | undefined;
}

/** Why the deployment cannot be rolled back to; nothing where it can, and the deployment. */
async function targetOf(
  choosing: Choosing,
  record: DeploymentRecord,
): Promise<DeploymentRecord | string> {
  const { scope, names, history, keyMadeAt } = choosing;
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
  if (keyMadeAt !== undefined && (await uploadedBefore(scope, pointer, keyMadeAt))) {
    return `${record.deploymentId} was deployed before ${names.cache}'s key was reset, and its Functions hold a token the cache no longer takes, so it cannot be gone back to; deploy its build again instead`;
  }
  return record;
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

/** A deployment to go back to, and where in the candidates to go on from should it be refused. */
interface Found {
  readonly target: DeploymentRecord;
  readonly next: number;
}

/** A candidate that can be rolled back to, from `start` on, and where to go on from; or why none can. */
async function firstTarget(
  input: Choosing,
  candidates: readonly DeploymentRecord[],
  start: number,
): Promise<string | Found> {
  for (const [index, record] of candidates.entries()) {
    if (index < start) {
      continue;
    }
    const target = await targetOf(input, record);
    if (typeof target !== 'string') {
      return { target, next: index + 1 };
    }
    if (input.named) {
      return target;
    }
  }
  return 'no deployment before the live one can be rolled back to';
}

/** Where a rollback goes first, and the candidates it goes on through where that one is refused. */
export interface Choice {
  readonly candidates: readonly DeploymentRecord[];
  readonly found: Found;
  /** What the candidates are chosen by, the one found as those it goes on to. */
  readonly choosing: Choosing;
}

/** Which deployment a rollback goes back to, by the edge's history; or why it goes to none. */
export async function chooseTarget(
  scope: AccountScope,
  names: ProjectNames,
  history: EdgeHistory,
  to: string | undefined,
): Promise<Choice | string> {
  if (history.current === undefined) {
    return `${names.edge} serves no deployment, so there is nothing to roll back`;
  }
  const { records: candidates, refused } = candidatesOf(names, history, to);
  if (refused !== undefined) {
    return refused;
  }
  const choosing = {
    scope,
    names,
    history,
    named: to !== undefined,
    keyMadeAt: await cacheKeyMadeAt(scope, names),
  };
  const found = await firstTarget(choosing, candidates, 0);
  return typeof found === 'string' ? found : { candidates, found, choosing };
}

/** Whether staging was refused for the deployment's cache scope: retired, by a stopped cleanup. */
function scopeRetired(refusal: DeployRefusalError): boolean {
  return refusal.code === 'cache_scope_conflict';
}

/** The deployment the edge serves now, as the deploy that made its version tagged it. */
function liveDeploymentOf(history: EdgeHistory): string | undefined {
  const liveVersion = liveVersionOf(history.current);
  return history.deployments.find((record) => record.versionId === liveVersion)?.deploymentId;
}

/** A deployment's bundle as the bucket keeps it, and the bytes it was kept as. */
interface KeptBundle {
  readonly bundle: DeploymentBundle;
  readonly json: string;
}

/**
 * A deployment's bundle as the bucket keeps it; nothing where it keeps none. One this version
 * cannot read — not JSON, or no bundle by the schema — is refused (`bundle_invalid`): like any
 * refusal of publishing a deployment again, the deployment's own.
 */
async function bundleIn(
  target: RemoteTarget,
  project: string,
  deploymentId: string,
): Promise<KeptBundle | undefined> {
  const bytes = await target.bucket.get(bundleObjectKey(project, deploymentId));
  if (bytes === undefined) {
    return undefined;
  }
  const json = new TextDecoder().decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new DeployRefusalError('its kept bundle is not JSON', {
      code: 'bundle_invalid',
      cause: error,
    });
  }
  const parsed = deploymentBundleSchema.safeParse(value);
  if (!parsed.success) {
    throw new DeployRefusalError('its kept bundle is not a deployment bundle this version reads', {
      code: 'bundle_invalid',
      cause: parsed.error,
    });
  }
  return { bundle: parsed.data, json };
}

/**
 * The live deployment's bundle, whose files a deployment gone back to serves beside its own
 * (`previous`); nothing, with a warning, where they cannot be carried over — no bundle of it kept,
 * or one this version cannot read. A file of it the bucket no longer holds, which publishing would
 * refuse, is left out of it, with a warning, and the rest carried over: the scripts its pages still
 * open ask for are no less served for one lost beside them. Each file is asked about, none read.
 */
async function carriedOver(
  agent: AgentClient,
  target: RemoteTarget,
  names: ProjectNames,
  live: string | undefined,
): Promise<DeploymentBundle | undefined> {
  if (live === undefined) {
    return undefined;
  }
  const notCarried = (why: string): undefined => {
    warn(
      `the files of ${live}, the live deployment, are not carried over (${why}); its pages still open may lose them`,
    );
  };
  let kept: KeptBundle | undefined;
  try {
    kept = await bundleIn(target, names.project, live);
  } catch (error) {
    if (error instanceof DeployRefusalError) {
      notCarried(error.message);
      return;
    }
    throw error;
  }
  if (kept === undefined) {
    notCarried(`${names.artifactsBucket} keeps no bundle of it`);
    return;
  }
  const lost = new Set(
    await blobsMissing(
      agent,
      kept.bundle.staticFiles.map((file) => file.blob),
    ),
  );
  const gone = kept.bundle.staticFiles.filter((file) => lost.has(file.blob.sha256));
  const [first] = gone;
  if (first === undefined) {
    return kept.bundle;
  }
  const more = gone.length > 1 ? ` and ${String(gone.length - 1)} more` : '';
  warn(
    `${names.artifactsBucket} no longer holds ${String(gone.length)} of the files of ${live}, the live deployment (blob ${first.blob.sha256}${more}): the rest are carried over, and its pages still open may lose those`,
  );
  return {
    ...kept.bundle,
    staticFiles: kept.bundle.staticFiles.filter((file) => !lost.has(file.blob.sha256)),
  };
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
  /** The live deployment's bundle, whose files stay served; nothing where none is carried over. */
  readonly previous: DeploymentBundle | undefined;
  readonly reach: ScriptSubdomain;
  readonly message: string;
  readonly io: RollbackIo;
  /** The secret the jobs are sent with, as the rollback read it (`rollbackCronSecret`). */
  readonly cronSecret: string | undefined;
}

/**
 * The deployment staged and published again, against the live one, and a version of the edge for
 * it uploaded; nothing where the bucket keeps no bundle of it, which is no deployment to go back to.
 * One kept that this version cannot read is refused (`bundleIn`).
 */
async function restage(input: Restaging): Promise<Served | undefined> {
  const { scope, names, settings, account, target, deploymentId, previous } = input;
  const kept = await bundleIn(target, names.project, deploymentId);
  if (kept === undefined) {
    return undefined;
  }
  const app = appRuntimeOf(names.project, kept.bundle);
  const staged = await stageDeployment(target, {
    bundle: kept.bundle,
    json: kept.json,
    ...(previous !== undefined && { previous }),
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
  const crons = rollbackCrons(kept.bundle.crons, input.cronSecret);
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
    ...crons,
  });
  return { versionId: edge.versionId, manifestId: staged.manifestId, crons: crons.crons };
}

function messageOf(deploymentId: string): string {
  return `upwind rollback to ${deploymentId}`;
}

/** Why the account cannot be rolled back on; nothing where it can. */
function refusalOf(names: ProjectNames, account: AccountView): string | undefined {
  if (account.bucket === undefined) {
    return `${names.artifactsBucket} is not on the account, and a rollback publishes the deployment it goes back to again, from the bundle kept there; deploy that deployment's build again instead`;
  }
  // The deploy agent, which publishes it, is reached on `workers.dev`.
  return account.subdomain === undefined
    ? `the account has no workers.dev subdomain, where ${names.agent} is reached; choose one in Cloudflare's settings for Workers`
    : undefined;
}

/** What a rollback tries the candidates with, once it holds the agent. */
interface Rolling {
  readonly restaging: Omit<Restaging, 'deploymentId' | 'message'>;
  readonly choice: Choice;
  readonly switchTo: (deploymentId: string, served: Served) => Promise<number>;
}

/**
 * The deployment published again; or the refusal of staging or publishing it, which is the
 * deployment's own and no failure of the rollback's. Anything else — the account, the agent or a
 * store failing — is thrown.
 */
async function restageUnlessRefused(
  restaging: Rolling['restaging'],
  deploymentId: string,
): Promise<Served | DeployRefusalError | undefined> {
  try {
    return await restage({ ...restaging, deploymentId, message: messageOf(deploymentId) });
  } catch (error) {
    if (error instanceof DeployRefusalError) {
      return error;
    }
    throw error;
  }
}

/**
 * Why a deployment could not be published again: no bundle kept, a retired cache scope, or any
 * other refusal of staging or publishing it.
 */
function refusedBecause(
  names: ProjectNames,
  deploymentId: string,
  refusal: DeployRefusalError | undefined,
): string {
  if (refusal === undefined) {
    return `${names.artifactsBucket} keeps no bundle of ${deploymentId}, so it cannot be published again — with the live deployment's files beside its own, and its cache scope asked — and it cannot be gone back to; deploy its build again instead`;
  }
  return scopeRetired(refusal)
    ? `${deploymentId}'s cache scope refuses it (${refusal.message}): a cleanup that retired the scope stopped before deleting the deployment's Functions, which the next deploy deletes, so it cannot be gone back to`
    : `publishing ${deploymentId} again is refused (${refusal.message}), so it cannot be gone back to`;
}

/**
 * Publish the first candidate again and switch to it — passing over one that cannot be published
 * again, to the next, where none was named; what the command exits with.
 */
async function rollThrough(input: Rolling): Promise<number> {
  const { restaging, switchTo } = input;
  const { candidates, choosing } = input.choice;
  const { names } = restaging;
  // Why each one tried was passed over, said again where none is left.
  const passedOver: string[] = [];
  let found: string | Found = input.choice.found;
  while (typeof found !== 'string') {
    const { deploymentId } = found.target;
    const restaged = await restageUnlessRefused(restaging, deploymentId);
    if (restaged !== undefined && !(restaged instanceof Error)) {
      return switchTo(deploymentId, restaged);
    }
    const why = refusedBecause(names, deploymentId, restaged);
    if (choosing.named) {
      console.error(`upwind: ${why}`);
      return 1;
    }
    warn(`${why}; trying the deployment before it`);
    passedOver.push(why);
    found = await firstTarget(choosing, candidates, found.next);
  }
  console.error(`upwind: ${found}; each one tried was passed over:`);
  for (const why of passedOver) {
    console.error(`  - ${why}`);
  }
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
  const accountScope = { client, accountId: await resolveAccount(client, credentials.accountId) };
  return withProjectLock(
    accountScope,
    names,
    async (held) => {
      const { scope } = held;
      const lockedIo = { ...io, fetch: held.fetch };
      const [account, history] = await Promise.all([
        readAccount(scope, names),
        readHistory(scope, names),
      ]);
      const choice = await chooseTarget(scope, names, history, options.to);
      if (typeof choice === 'string') {
        console.error(`upwind: ${choice}`);
        return 1;
      }
      const refused = refusalOf(names, account);
      const { subdomain } = account;
      if (refused !== undefined || subdomain === undefined) {
        console.error(`upwind: ${refused ?? 'the account has no workers.dev subdomain'}`);
        return 1;
      }
      const site = siteOf(settings, names, subdomain);
      const reach: ScriptSubdomain = { enabled: settings.workersDev, previews_enabled: false };
      const switchTo = async (deploymentId: string, served: Served): Promise<number> => {
        console.log(
          `upwind: checking ${names.edge} version ${served.versionId}, of ${deploymentId}`,
        );
        const activation = await activate({
          scope,
          edge: names.edge,
          origin: site.origin,
          expected: { deploymentId, versionId: served.versionId, manifestId: served.manifestId },
          first: false,
          checks: settings.checks,
          message: messageOf(deploymentId),
          fetch: lockedIo.fetch,
          sleep: lockedIo.sleep,
          now: lockedIo.now,
        });
        const switched = activation.kind === 'live' || activation.kind === 'unconfirmed';
        if (switched) {
          await narrowReach(scope, names.edge, reach);
        }
        const scheduled =
          !switched || (await holdCrons(scope, names.edge, served.crons, deploymentId));
        const reported = report(activation, deploymentId, site.origin);
        return reported === 0 && !scheduled ? 1 : reported;
      };
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
        fetch: lockedIo.fetch,
        sleep: lockedIo.sleep,
        now: lockedIo.now,
      });
      try {
        const target = storedTarget(session.client);
        // Asked once, before any deployment is tried: what is wrong with the live deployment is no
        // fault of one gone back to.
        const previous = await carriedOver(
          session.client,
          target,
          names,
          liveDeploymentOf(history),
        );
        return await rollThrough({
          restaging: {
            scope,
            names,
            settings,
            account: { ...account, subdomain },
            stores,
            site,
            target,
            previous,
            reach,
            io: lockedIo,
            cronSecret: await rollbackCronSecret(options.envFiles ?? [], settings),
          },
          choice,
          switchTo,
        });
      } finally {
        await session.close();
      }
    },
    { fetch: io.fetch },
  );
}
