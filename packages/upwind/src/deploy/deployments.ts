import { resolveAccount } from './account.ts';
import type { DeploymentsOptions } from './args.ts';
import { createCloudflareClient } from './cloudflare/client.ts';
import type { AccountScope } from './cloudflare/workers.ts';
import { readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';
import {
  type DeploymentRecord,
  type EdgeHistory,
  functionsRemain,
  pointerOf,
  readHistory,
} from './history.ts';
import { type ProjectNames, projectNames } from './names.ts';

/**
 * `upwind deployments`: the project's deployments, the one first deployed most recently first (a
 * deployment rolled back to is no newer for it), each as the edge's version for it
 * stands — taking the edge's traffic, held at none beside the one that does, one a rollback can go
 * back to, one whose Functions are gone, or one whose version is older than the hundred a deployment
 * of the edge can choose from. Read from the Workers API alone, and changing nothing.
 */

export interface DeploymentsIo {
  readonly fetch?: typeof fetch | undefined;
}

const FULL = 100;
/** How wide a deployment's status is printed, the widest of them. */
const STATUS_WIDTH = 12;

/** Where the deployment stands, by its share, its edge version's reach, and its Functions. */
async function statusOf(
  scope: AccountScope,
  names: ProjectNames,
  history: EdgeHistory,
  record: DeploymentRecord,
): Promise<string> {
  if (record.share !== undefined) {
    if (record.share === 0) {
      return 'waiting';
    }
    return record.share === FULL ? 'live' : `live ${String(record.share)}%`;
  }
  if (!record.reachable) {
    return 'out of reach';
  }
  if (!history.functions.has(record.deploymentId)) {
    return 'cleaned up';
  }
  const pointer = await pointerOf(scope, names.edge, record.versionId);
  return pointer !== undefined && functionsRemain(history, pointer) ? 'rollback' : 'cleaned up';
}

function lineOf(record: DeploymentRecord, status: string): string {
  const number = record.number === undefined ? '' : ` (#${String(record.number)})`;
  const message = record.message === undefined ? '' : `  ${record.message}`;
  return `  ${record.deploymentId}  ${status.padEnd(STATUS_WIDTH)}  version ${record.versionId}${number}${message}`;
}

/** List the project's deployments; what the command exits with. */
export async function runDeployments(
  options: DeploymentsOptions,
  credentials: CloudflareCredentials | undefined,
  io: DeploymentsIo = {},
): Promise<number> {
  if (credentials === undefined) {
    console.error(
      'upwind: deployments reads the account with CLOUDFLARE_API_TOKEN, which is not set',
    );
    return 1;
  }
  const settings = await readDeploySettings(options.projectDir);
  const names = projectNames(settings.project);
  const client = createCloudflareClient({ apiToken: credentials.apiToken, fetch: io.fetch });
  const scope = { client, accountId: await resolveAccount(client, credentials.accountId) };
  const history = await readHistory(scope, names);
  if (history.deployments.length === 0) {
    console.log(`upwind: ${names.project} has no deployments on the account`);
    return 0;
  }
  console.log(
    `upwind: ${names.project}, ${String(history.deployments.length)} deployments on ${names.edge}`,
  );
  for (const record of history.deployments) {
    console.log(lineOf(record, await statusOf(scope, names, history, record)));
  }
  return 0;
}
