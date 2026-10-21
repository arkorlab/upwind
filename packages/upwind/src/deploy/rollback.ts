import { resolveAccount } from './account.ts';
import { activate, liveVersionOf } from './activate.ts';
import type { RollbackOptions } from './args.ts';
import { createCloudflareClient } from './cloudflare/client.ts';
import { type AccountScope, accountSubdomain } from './cloudflare/workers.ts';
import { readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';
import { report, siteOf } from './deploy-run.ts';
import {
  type DeploymentRecord,
  type EdgeHistory,
  functionsRemain,
  pointerOf,
  readHistory,
} from './history.ts';
import { type ProjectNames, projectNames } from './names.ts';

/**
 * `upwind rollback`: the edge's traffic given back to an older deployment's version, with nothing
 * uploaded — the version, its pointer and its Functions are on the account as they were.
 *
 * The same check-then-switch a deploy makes (`activate.ts`): the older version given a share of none
 * beside the live one, asked by name whether it answers as its deployment, each of the project's
 * checks asked through it, and only then given all of the traffic. One that fails is given none.
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
  const at = history.deployments.findIndex((record) => record.versionId === liveVersion);
  if (to !== undefined) {
    const named = history.deployments.find((record) => record.deploymentId === to);
    if (named === undefined) {
      return `no version of ${names.edge} serves ${to}`;
    }
    return named.versionId === liveVersion
      ? `${to} is the deployment the edge serves`
      : targetOf(scope, names, history, named);
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
  const [subdomain, history] = await Promise.all([
    accountSubdomain(scope),
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
  if (subdomain === undefined && settings.workersDev) {
    console.error(
      "upwind: the account has no workers.dev subdomain, where the edge is checked; choose one in Cloudflare's settings for Workers",
    );
    return 1;
  }
  const site = siteOf(settings, names, subdomain ?? '');
  const { deploymentId, versionId } = target.record;
  console.log(`upwind: checking ${names.edge} version ${versionId}, of ${deploymentId}`);
  const activation = await activate({
    scope,
    edge: names.edge,
    origin: site.origin,
    expected: { deploymentId, manifestId: target.manifestId, versionId },
    first: false,
    checks: settings.checks,
    message: `upwind rollback to ${deploymentId}`,
    fetch: io.fetch,
    sleep: io.sleep,
    now: io.now,
  });
  return report(activation, deploymentId, site.origin);
}
