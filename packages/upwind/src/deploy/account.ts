import { type CloudflareClient, listPages } from './cloudflare/client.ts';
import {
  getBucket,
  getObject,
  type KvNamespace,
  listKvNamespaces,
  type R2Bucket,
} from './cloudflare/storage.ts';
import {
  type AccountScope,
  accountSubdomain,
  listDeployments,
  listScripts,
  type WorkerDeployment,
} from './cloudflare/workers.ts';
import { deploymentOfScript, type ProjectNames } from './names.ts';

/**
 * What a deploy reads of the account before it changes anything on it: which account it is, where
 * `workers.dev` puts it, how many Workers it already holds, and whether what this project would
 * make there is already there — and is this project's.
 *
 * Whether it is the project's is the question that matters. Every name a deploy uses is made of the
 * project's name, and another project, or another tool, may have used the same names first: a
 * bucket called `<project>-artifacts` that a deploy did not make is not one it may write into, let
 * alone empty. So the bucket holds a mark the deploy wrote when it made it (`OWNER_KEY`), naming the
 * project, and everything else is trusted only alongside that mark.
 */

/** The object in the artifacts bucket that says whose the bucket is, and what else was made with it. */
export const OWNER_KEY = 'upwind/owner.json';
const OWNER_VERSION = 1;

/** What the owner mark says. */
export interface OwnerMark {
  readonly v: typeof OWNER_VERSION;
  readonly project: string;
  /** KV namespace ids, by title, and the ids of the storage made for the application. */
  readonly made: Readonly<Record<string, string>>;
}

export interface AccountView {
  readonly accountId: string;
  /** The account's `workers.dev` subdomain; nothing for an account that has not chosen one. */
  readonly subdomain: string | undefined;
  /** Every Worker on the account, the project's included. */
  readonly workers: number;
  /** The project's own Workers already there: its edge, cache, agent and the like, and its Functions. */
  readonly projectWorkers: readonly string[];
  readonly edgeState: readonly KvNamespace[];
  readonly cacheState: readonly KvNamespace[];
  readonly bucket: R2Bucket | undefined;
  readonly owner: OwnerMark | undefined;
  /** What the edge serves now; nothing before a first deploy. */
  readonly live: WorkerDeployment | undefined;
  /** Every reason a deploy to this account would be refused. */
  readonly problems: readonly string[];
}

interface AccountSummary {
  readonly id: string;
  readonly name?: string;
}

/** The account to deploy to: the one named, or the only one the token can see. */
export async function resolveAccount(
  client: CloudflareClient,
  named: string | undefined,
): Promise<string> {
  if (named !== undefined) {
    return named;
  }
  const accounts = await listPages<AccountSummary>(client, '/accounts', { perPage: 50 });
  const [only] = accounts;
  if (only === undefined || accounts.length > 1) {
    throw new Error(
      accounts.length === 0
        ? 'the API token reaches no account; give it access to the one to deploy to'
        : `the API token reaches ${accounts.length} accounts; name one in CLOUDFLARE_ACCOUNT_ID`,
    );
  }
  return only.id;
}

function ownerOf(bytes: Uint8Array | undefined): OwnerMark | undefined {
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'v' in parsed &&
      parsed.v === OWNER_VERSION &&
      'project' in parsed &&
      typeof parsed.project === 'string' &&
      'made' in parsed &&
      typeof parsed.made === 'object' &&
      parsed.made !== null
    ) {
      const made: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.made)) {
        if (typeof value === 'string') {
          made[key] = value;
        }
      }
      return { v: OWNER_VERSION, project: parsed.project, made };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Read the account, changing nothing on it. */
export async function readAccount(scope: AccountScope, names: ProjectNames): Promise<AccountView> {
  const [subdomain, scripts, namespaces, bucket] = await Promise.all([
    accountSubdomain(scope),
    listScripts(scope),
    listKvNamespaces(scope),
    getBucket(scope, names.artifactsBucket),
  ]);
  const own = new Set([names.agent, names.cache, names.cacheRead, names.edge, names.prefetch]);
  const projectWorkers = scripts
    .map((script) => script.id)
    .filter((id) => own.has(id) || deploymentOfScript(names.project, id) !== undefined);
  const owner =
    bucket === undefined
      ? undefined
      : ownerOf(await getObject(scope, names.artifactsBucket, OWNER_KEY));
  const edgeState = namespaces.filter((namespace) => namespace.title === names.edgeStateTitle);
  const cacheState = namespaces.filter((namespace) => namespace.title === names.cacheStateTitle);
  const live = projectWorkers.includes(names.edge)
    ? (await listDeployments(scope, names.edge))?.[0]
    : undefined;
  const problems: string[] = [];
  if (bucket !== undefined && owner?.project !== names.project) {
    problems.push(
      `the bucket ${names.artifactsBucket} is already on the account, and was not made by upwind deploy for ${names.project}; choose another deploy.name`,
    );
  }
  for (const [title, found] of [
    [names.edgeStateTitle, edgeState],
    [names.cacheStateTitle, cacheState],
  ] as const) {
    if (found.length > 1) {
      problems.push(
        `the account has ${found.length} KV namespaces titled ${title}, and a deploy uses one`,
      );
    }
    const [namespace] = found;
    if (namespace !== undefined && owner?.made[title] !== namespace.id) {
      problems.push(
        `the KV namespace ${title} is already on the account, and was not made by upwind deploy for ${names.project}`,
      );
    }
  }
  if (bucket === undefined && projectWorkers.length > 0) {
    problems.push(
      `the account has Workers named for ${names.project} (${projectWorkers.join(', ')}) and no ${names.artifactsBucket}; they were not made by upwind deploy, or not all of what it made is still there`,
    );
  }
  return {
    accountId: scope.accountId,
    subdomain,
    workers: scripts.length,
    projectWorkers,
    edgeState,
    cacheState,
    bucket,
    owner,
    live,
    problems,
  };
}
