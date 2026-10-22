import { resolveAccount } from './account.ts';
import type { DeploymentsOptions } from './args.ts';
import { createCloudflareClient } from './cloudflare/client.ts';
import type { AccountScope } from './cloudflare/workers.ts';
import { readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';
import {
  cacheKeyMadeAt,
  type DeploymentRecord,
  type EdgeHistory,
  functionsRemain,
  pointerOf,
  readHistory,
  uploadedBefore,
} from './history.ts';
import { type ProjectNames, projectNames } from './names.ts';

/**
 * `upwind deployments`: the project's deployments, the one first deployed most recently first (a
 * deployment rolled back to is no newer for it), each as the edge's version for it
 * stands — taking the edge's traffic, held at none beside the one that does, kept (its edge version
 * and Functions there, so a rollback tries it), one whose Functions are gone, one deployed before
 * the runtime cache's key was reset, or one whose version is older than the hundred a deployment of
 * the edge can choose from. Read from the Workers API alone, and changing nothing: what only the
 * bucket and the cache know — its bundle kept, its cache scope not retired by a stopped cleanup,
 * which a rollback still refuses one for — it does not say.
 */

export interface DeploymentsIo {
  readonly fetch?: typeof fetch | undefined;
}

const FULL = 100;
/** How wide a deployment's status is printed, the widest of them. */
const STATUS_WIDTH = 12;

/** What every deployment's status is read against. */
interface Listing {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  readonly history: EdgeHistory;
  /** When the key the cache's Workers check a Function's token with now was made (`cacheKeyMadeAt`). */
  readonly keyMadeAt: number | undefined;
}

/** Where the deployment stands, by its share, its edge version's reach, and its Functions. */
async function statusOf(listing: Listing, record: DeploymentRecord): Promise<string> {
  const { scope, names, history, keyMadeAt } = listing;
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
  if (pointer === undefined || !functionsRemain(history, pointer)) {
    return 'cleaned up';
  }
  // Its Functions hold a token of a key the cache no longer checks with: no way back.
  return keyMadeAt !== undefined && (await uploadedBefore(scope, pointer, keyMadeAt))
    ? 'key reset'
    : 'kept';
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
  const listing = { scope, names, history, keyMadeAt: await cacheKeyMadeAt(scope, names) };
  for (const record of history.deployments) {
    console.log(lineOf(record, await statusOf(listing, record)));
  }
  return 0;
}
