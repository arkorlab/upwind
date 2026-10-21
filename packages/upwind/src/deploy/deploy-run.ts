import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { AccountView } from './account.ts';
import { type Activation, activate } from './activate.ts';
import { openAgent } from './agent-session.ts';
import { type AccountScope, getVersion } from './cloudflare/workers.ts';
import type { DeploySettings } from './config.ts';
import { deploymentOfTag, uploadEdgeVersion } from './edge-version.ts';
import { uploadFunctions } from './functions.ts';
import { ensureInfra } from './infra.ts';
import { appRuntimeOf, type ProjectNames, projectNames } from './names.ts';
import { publishPointer } from './pointer.ts';
import type { Preflight } from './preflight.ts';
import { shippedWorkers } from './shipped.ts';
import { stageBuild } from './stage.ts';
import { ensureStores } from './stores.ts';
import { remoteTarget } from './target.ts';

/**
 * A deployment made on the account, once the plan has been checked (`command.ts`): its stores and
 * the Workers behind its Functions found or made, the build staged through the deploy agent, its
 * Functions uploaded, its pointer published, the edge's version for it uploaded, checked, and made
 * the live one (`activate.ts`).
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

/** The deployment the edge serves now: the one its live version is tagged with. */
async function liveDeployment(
  scope: AccountScope,
  names: ProjectNames,
  account: AccountView,
): Promise<string | undefined> {
  const live = account.live?.versions.find((share) => share.percentage > 0);
  if (live === undefined) {
    return undefined;
  }
  const version = await getVersion(scope, names.edge, live.version_id);
  return deploymentOfTag(version.annotations?.['workers/tag']);
}

/** Where the site is reached on the account's side, as the edge's names and its first one. */
function siteOf(
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

function report(activation: Activation, deploymentId: string, origin: URL): number {
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
  }
}

/** Make the deployment on the account; what the command exits with. */
export async function deployToAccount(run: DeployRun): Promise<number> {
  const { scope, account, settings, plan } = run;
  const { bundle, bundleDir } = plan;
  const names = projectNames(settings.project);
  const subdomain = account.subdomain;
  if (subdomain === undefined) {
    throw new Error('the account has no workers.dev subdomain');
  }
  const site = siteOf(settings, names, subdomain);
  const previous = await liveDeployment(scope, names, account);
  if (previous === bundle.deploymentId) {
    // Staged again, it would be staged without the deployment before it, whose files its open
    // pages still ask for; and switched to again, it would be switched from itself.
    say(`${bundle.deploymentId} is live already; nothing was changed`);
    return 0;
  }
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
    const edge = await uploadEdgeVersion({
      scope,
      names,
      stores,
      script: scripts.edge,
      pointer,
      app: appRuntimeOf(names.project, bundle),
      hostnames: site.hostnames.join(','),
      images: settings.images,
      reach: { enabled: settings.workersDev, previews_enabled: false },
      message,
      existing,
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
    return report(activation, bundle.deploymentId, site.origin);
  } finally {
    await session.close();
  }
}
