import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { type AccountView, readAccount } from './account.ts';
import { type Activation, activate, confirmLive } from './activate.ts';
import { openAgent } from './agent-session.ts';
import { type AccountScope, getVersion, type ScriptSubdomain } from './cloudflare/workers.ts';
import type { DeploySettings } from './config.ts';
import { cronTableOf, holdCrons } from './crons.ts';
import { deploymentOfTag, uploadEdgeVersion } from './edge-version.ts';
import { uploadFunctions } from './functions.ts';
import { pointerOf } from './history.ts';
import { ensureInfra } from './infra.ts';
import { appRuntimeOf, type ProjectNames, projectNames } from './names.ts';
import { publishPointer } from './pointer.ts';
import type { Preflight } from './preflight.ts';
import { withProjectLock } from './project-lock.ts';
import { retainDeployments } from './retention.ts';
import { shippedWorkers } from './shipped.ts';
import { stageBuild } from './stage.ts';
import { ensureStores } from './stores.ts';
import { remoteTarget } from './target.ts';
import { holdReach } from './uploads.ts';
import { CRON_SECRET } from './workers/protocol.ts';

/**
 * A deployment made on the account, once the plan has been checked (`command.ts`): its stores and
 * the Workers behind its Functions found or made, the build staged through the deploy agent, its
 * Functions uploaded, its pointer published, the edge's version for it uploaded, checked, and made
 * the live one (`activate.ts`), and the edge's Cron Triggers set to the deployment's cron jobs
 * (`crons.ts`).
 *
 * Nothing a visitor reaches changes before that last step, except the Workers behind the Functions
 * where this version of upwind ships them otherwise — which every deployment still live uses, and
 * which therefore answer every deployment a version of upwind has made. A run stopped anywhere
 * before it can be run again: every write is under a digest or the deployment's id, and every
 * upload is found again by its tag.
 */

/** The exit code of a deployment made live without the edge answering as it in time. */
export const UNCONFIRMED_EXIT = 3;

export interface DeployRun {
  readonly scope: AccountScope;
  readonly account: AccountView;
  readonly settings: DeploySettings;
  readonly plan: Preflight;
  readonly secrets: ReadonlyMap<string, string>;
  readonly message: string | undefined;
  readonly resetCacheKey: boolean;
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

function say(text: string): void {
  console.log(`upwind: ${text}`);
}

/** The edge's version that has its traffic, and the deployment it is tagged with. */
interface LiveVersion {
  readonly versionId: string;
  readonly deploymentId: string | undefined;
}

/** What the edge serves now: its live version, and the deployment that version is tagged with. */
async function liveVersionOf(
  scope: AccountScope,
  names: ProjectNames,
  account: AccountView,
): Promise<LiveVersion | undefined> {
  const live = account.live?.versions.find((share) => share.percentage > 0);
  if (live === undefined) {
    return undefined;
  }
  const version = await getVersion(scope, names.edge, live.version_id);
  return {
    versionId: live.version_id,
    deploymentId: deploymentOfTag(version.annotations?.['workers/tag']),
  };
}

/** Where the site is reached on the account's side, as the edge's names and its first one. */
export function siteOf(
  settings: DeploySettings,
  names: ProjectNames,
  subdomain: string,
): { readonly hostnames: readonly string[]; readonly origin: URL } {
  const workersDev = `${names.edge}.${subdomain}.workers.dev`;
  const hostnames = [...(settings.workersDev ? [workersDev] : []), ...settings.hostnames];
  const [first] = hostnames;
  if (first === undefined) {
    throw new Error(
      'nothing reaches the edge: deploy.workersDev is false, and no hostname is named',
    );
  }
  return { hostnames, origin: new URL(`https://${first}/`) };
}

/** What a check-then-switch came to, said; what the command exits with. */
export function report(activation: Activation, deploymentId: string, origin: URL): number {
  switch (activation.kind) {
    case 'live': {
      say(`${deploymentId} is live at ${origin.href}`);
      return 0;
    }
    case 'unconfirmed': {
      console.error(
        `upwind: ${deploymentId} was given the edge's traffic, and ${origin.host} did not answer as it in time; it may still be on its way`,
      );
      return UNCONFIRMED_EXIT;
    }
    case 'kept': {
      console.error(
        `upwind: ${deploymentId} failed its checks, and nothing was switched: the edge serves version ${activation.versionId} as before`,
      );
      for (const reason of activation.reasons) {
        console.error(`  - ${reason}`);
      }
      return 1;
    }
    case 'failing': {
      console.error(`upwind: ${deploymentId} is live, and failed its checks:`);
      for (const reason of activation.reasons) {
        console.error(`  - ${reason}`);
      }
      return 1;
    }
    case 'overtaken': {
      console.error(
        `upwind: the edge's deployment changed while this run checked ${deploymentId}; this run switched nothing and put nothing back — run it again`,
      );
      for (const reason of activation.reasons) {
        console.error(`  - ${reason}`);
      }
      return 1;
    }
  }
}

/**
 * The edge's reach narrowed to what the settings say, once the new version has the traffic; until
 * then the live version kept what it was reached on (`uploadEdgeVersion`). A failure here leaves
 * the deployment live, and the next run narrows it.
 */
export async function narrowReach(
  scope: AccountScope,
  edge: string,
  reach: ScriptSubdomain,
): Promise<void> {
  try {
    await holdReach(scope, edge, reach);
  } catch (error) {
    console.warn(
      `upwind: ${edge} is still reached where deploy.workersDev no longer says: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The older deployments cleaned up, once this one is live (`retention.ts`): best done, and said
 * where it could not be — the deployment is live either way, and the next run tries again.
 */
async function cleanUp(
  run: DeployRun,
  names: ProjectNames,
  cache: Parameters<typeof retainDeployments>[0]['cache'],
): Promise<void> {
  try {
    const retention = await retainDeployments({
      scope: run.scope,
      names,
      keep: run.settings.keep,
      deploymentId: run.plan.bundle.deploymentId,
      cache,
      now: run.now,
    });
    say(`kept ${retention.kept.join(', ')}`);
    if (retention.deleted.length > 0) {
      say(`deleted the Functions of ${retention.deleted.join(', ')}`);
    }
    if (retention.orphans.length > 0) {
      say(`deleted ${retention.orphans.join(', ')}, which no deployment named`);
    }
  } catch (error) {
    console.warn(
      `upwind: warning: the deployment is live, and older ones were not cleaned up: ${error instanceof Error ? error.message : String(error)}; the next deploy tries again`,
    );
  }
}

/**
 * Whether the live version answers as the deployment it is tagged with, unnamed, and passes the
 * project's checks: what the version's own pointer names — the manifest — read from what the
 * version was uploaded with. Said where it does not; nothing where it does.
 */
async function unconfirmedLive(
  run: DeployRun,
  input: { readonly names: ProjectNames; readonly origin: URL; readonly versionId: string },
): Promise<number | undefined> {
  const deploymentId = run.plan.bundle.deploymentId;
  const pointer = await pointerOf(run.scope, input.names.edge, input.versionId);
  if (pointer?.manifestId === undefined) {
    console.error(
      `upwind: ${deploymentId} is live, and ${input.names.edge}'s version ${input.versionId} names no manifest this run can confirm it by; nothing was changed`,
    );
    return 1;
  }
  const confirmed = await confirmLive({
    origin: input.origin,
    expected: { deploymentId, manifestId: pointer.manifestId, versionId: input.versionId },
    checks: run.settings.checks,
    fetch: run.fetch,
    sleep: run.sleep,
    now: run.now,
  });
  if (confirmed.kind === 'live') {
    return undefined;
  }
  const code = report(confirmed, deploymentId, input.origin);
  console.error(
    "upwind: the edge's reach and the deployments before it are left as they are until it answers as it should",
  );
  return code;
}

/**
 * A run of the deployment that is live already. Staged again, it would be staged without the
 * deployment before it, whose files its open pages still ask for; and switched to again, it would
 * be switched from itself. What a run that made it live may have left undone is done, though, and
 * nothing else: the edge's reach and its Cron Triggers, which a run sets only once its deployment
 * is live, and the cleanup of older deployments, which takes the agent — a failure of any is left
 * for the next run, which may be this one.
 *
 * Neither is done before the deployment is confirmed live, as a deploy confirms one it has just
 * switched to: a run that made it live may have ended with it unconfirmed, or failing its checks,
 * and what such a run would not have done, this one does not do either — least of all delete the
 * Functions of the deployment it would be rolled back to.
 */
async function finishLive(
  run: DeployRun,
  input: {
    readonly names: ProjectNames;
    readonly subdomain: string;
    readonly reach: ScriptSubdomain;
    readonly origin: URL;
    readonly versionId: string;
  },
): Promise<number> {
  const { scope, account, settings, plan } = run;
  const { names } = input;
  const unconfirmed = await unconfirmedLive(run, input);
  if (unconfirmed !== undefined) {
    return unconfirmed;
  }
  await narrowReach(scope, names.edge, input.reach);
  const scheduled = await holdCrons(
    scope,
    names.edge,
    cronTableOf(plan.bundle.crons),
    plan.bundle.deploymentId,
  );
  const stores = await ensureStores({ scope, names, account, storage: settings.storage });
  const scripts = await shippedWorkers();
  const session = await openAgent({
    scope,
    names,
    stores,
    script: scripts.agent,
    subdomain: input.subdomain,
    mode: 'deploy',
    existing: new Set(account.projectWorkers),
    withCache: true,
    fetch: run.fetch,
    sleep: run.sleep,
    now: run.now,
  });
  try {
    await cleanUp(run, names, remoteTarget(session.client, plan.bundleDir).cache);
  } finally {
    await session.close();
  }
  say(`${plan.bundle.deploymentId} is live already, and answers as it; nothing else was changed`);
  return scheduled ? 0 : 1;
}

/** The secret a deployment's cron jobs are sent with: the project's, where it set one with a value. */
function cronSecretOf(secrets: ReadonlyMap<string, string>): string | undefined {
  const secret = secrets.get(CRON_SECRET);
  return secret === undefined || secret === '' ? undefined : secret;
}

/**
 * Make the deployment under project exclusion. A caller's earlier account view is never used:
 * the account is read again only after acquisition, and the command checks that same view.
 */
export async function deployToAccount(
  input: Omit<DeployRun, 'account'> & { readonly account?: AccountView },
  inspect?: (account: AccountView) => number | undefined,
): Promise<number> {
  if (input.plan.problems.length > 0) {
    throw new Error(input.plan.problems.join('; '));
  }
  const names = projectNames(input.settings.project);
  return withProjectLock(
    input.scope,
    names,
    async (held) => {
      const account = await readAccount(held.scope, names);
      const stopped = inspect?.(account);
      if (stopped !== undefined) {
        return stopped;
      }
      if (account.problems.length > 0) {
        throw new Error(account.problems.join('; '));
      }
      return deployWhileLocked({ ...input, account, scope: held.scope, fetch: held.fetch });
    },
    { fetch: input.fetch },
  );
}

/** Provision, activate and retain, with the fresh account view held by `deployToAccount`. */
async function deployWhileLocked(run: DeployRun): Promise<number> {
  const { scope, account, settings, plan } = run;
  const { bundle, bundleDir } = plan;
  const names = projectNames(settings.project);
  const subdomain = account.subdomain;
  if (subdomain === undefined) {
    throw new Error('the account has no workers.dev subdomain');
  }
  const site = siteOf(settings, names, subdomain);
  const reach: ScriptSubdomain = { enabled: settings.workersDev, previews_enabled: false };
  const live = await liveVersionOf(scope, names, account);
  if (live?.deploymentId === bundle.deploymentId) {
    return finishLive(run, {
      names,
      subdomain,
      reach,
      origin: site.origin,
      versionId: live.versionId,
    });
  }
  const previous = live?.deploymentId;
  const existing = new Set(account.projectWorkers);
  say('finding or making the stores');
  const stores = await ensureStores({ scope, names, account, storage: settings.storage });
  const scripts = await shippedWorkers();
  const infra = await ensureInfra({
    scope,
    names,
    stores,
    scripts,
    existing,
    live: account.live !== undefined,
    resetCacheKey: run.resetCacheKey,
  });
  for (const uploaded of infra.uploaded) {
    say(`uploaded ${uploaded}`);
    existing.add(uploaded);
  }
  const session = await openAgent({
    scope,
    names,
    stores,
    script: scripts.agent,
    subdomain,
    mode: 'deploy',
    existing,
    withCache: true,
    fetch: run.fetch,
    sleep: run.sleep,
    now: run.now,
  });
  existing.add(names.agent);
  try {
    say(`staging ${bundle.deploymentId}`);
    const staged = await stageBuild({
      agent: session.client,
      bundleDir,
      bundle,
      json: await readFile(path.join(bundleDir, 'bundle.json'), 'utf8'),
      project: names.project,
      owner: scope.accountId,
      originHost: settings.hostnames[0] ?? `${names.edge}.${subdomain}.workers.dev`,
      previous,
      now: run.now,
    });
    const functions = await uploadFunctions({
      scope,
      names,
      bundleDir,
      bundle,
      stores,
      token: staged.token,
      secrets: run.secrets,
      logs: settings.logs,
      existing,
    });
    say(`uploaded ${functions.join(', ')}`);
    const pointer = await publishPointer({
      target: remoteTarget(session.client, bundleDir),
      staged,
      settings,
      now: run.now,
      sleep: run.sleep,
    });
    const message = run.message ?? `upwind deploy ${bundle.deploymentId}`;
    const crons = cronTableOf(bundle.crons);
    const edge = await uploadEdgeVersion({
      scope,
      names,
      stores,
      script: scripts.edge,
      pointer,
      app: appRuntimeOf(names.project, bundle),
      hostnames: site.hostnames.join(','),
      images: settings.images,
      reach,
      message,
      existing,
      crons,
      cronSecret: cronSecretOf(run.secrets),
      keepSecrets: false,
    });
    say(`checking ${names.edge} version ${edge.versionId}`);
    const activation = await activate({
      scope,
      edge: names.edge,
      origin: site.origin,
      expected: {
        deploymentId: bundle.deploymentId,
        manifestId: staged.manifestId,
        versionId: edge.versionId,
      },
      first: edge.live,
      checks: settings.checks,
      message,
      fetch: run.fetch,
      sleep: run.sleep,
      now: run.now,
    });
    const switched = activation.kind === 'live' || activation.kind === 'unconfirmed';
    if (switched && !edge.live) {
      await narrowReach(scope, names.edge, reach);
    }
    const scheduled = !switched || (await holdCrons(scope, names.edge, crons, bundle.deploymentId));
    const reported = report(activation, bundle.deploymentId, site.origin);
    const code = reported === 0 && !scheduled ? 1 : reported;
    if (activation.kind === 'live') {
      await cleanUp(run, names, remoteTarget(session.client, bundleDir).cache);
    }
    return code;
  } finally {
    await session.close();
  }
}
