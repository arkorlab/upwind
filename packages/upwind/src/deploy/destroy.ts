import {
  type AccountView,
  type OwnerMark,
  readAccount,
  resolveAccount,
  writeOwnerMark,
} from './account.ts';
import type { AgentClient } from './agent-client.ts';
import { openAgent } from './agent-session.ts';
import type { DestroyOptions } from './args.ts';
import { CloudflareApiError, createCloudflareClient } from './cloudflare/client.ts';
import {
  deleteBucket,
  deleteD1Database,
  deleteKvNamespace,
  deleteObject,
} from './cloudflare/storage.ts';
import { type AccountScope, deleteScript } from './cloudflare/workers.ts';
import { readDeploySettings } from './config.ts';
import type { CloudflareCredentials } from './credentials.ts';
import { deploymentOfScript, type ProjectNames, projectNames } from './names.ts';
import { withProjectLock } from './project-lock.ts';
import { shippedWorkers } from './shipped.ts';
import { recordedStores } from './stores.ts';
import { AGENT_PATHS, OWNER_KEY } from './workers/protocol.ts';

/**
 * `upwind destroy`: everything a deploy made for the project, deleted — its edge first, so the site
 * stops before anything behind it goes, then each deployment's Functions, every file of every
 * deployment, the Workers behind them, and the stores.
 *
 * Only what the owner mark says is the project's (`account.ts`), and only with `--yes`. The stores
 * the application asked for (`deploy.storage`) hold its data, not a deployment's, and are deleted
 * only with `--include-storage`; without it they are listed, and left — and so is the bucket, with
 * the owner mark and nothing else in it: the record of them, which a later deploy takes them up
 * again by, as the project's, and a later destroy deletes them by.
 *
 * Every step is one a second run finds done or does: a Worker or a store that is gone already is
 * passed over, and the owner mark is the last thing in the bucket deleted — written back where the
 * bucket then could not be — so a run stopped half way can be run again on what the mark still says
 * is the project's. What the mark says was about to be made is looked up first, and what of it is
 * on the account is the project's as much as what it says was made.
 */

export interface DestroyIo {
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

/** One of the application's stores the mark records, left where it is. */
interface LeftStore {
  /** As the mark names it: its kind and its binding. */
  readonly name: string;
  readonly id: string;
  /** Why it is left, where it was not left by being asked to. */
  readonly why?: string;
}

/** What R2 answers a deletion of a bucket that still holds objects with. */
const BUCKET_NOT_EMPTY = 10_008;

function say(text: string): void {
  console.log(`upwind: ${text}`);
}

/** Every file of every deployment deleted, through the agent, a batch at a time. */
async function purge(agent: AgentClient): Promise<number> {
  let deleted = 0;
  for (;;) {
    const response = await agent.call('POST', AGENT_PATHS.purge);
    const answer = (await response?.json()) as
      | { readonly deleted?: number; readonly more?: boolean }
      | undefined;
    if (answer?.deleted === undefined) {
      throw new Error('the deploy agent did not say what it deleted');
    }
    deleted += answer.deleted;
    if (answer.more !== true) {
      return deleted;
    }
  }
}

/** The project's Workers, the edge first and the agent, which empties the bucket, last. */
function workersOf(names: ProjectNames, account: AccountView): readonly string[] {
  const functions = account.projectWorkers.filter(
    (name) => deploymentOfScript(names.project, name) !== undefined,
  );
  return [names.edge, ...functions, names.cacheRead, names.prefetch, names.cache];
}

async function emptyBucket(
  scope: AccountScope,
  names: ProjectNames,
  account: AccountView & { readonly subdomain: string },
  io: DestroyIo,
): Promise<void> {
  const scripts = await shippedWorkers();
  const session = await openAgent({
    scope,
    names,
    // The bucket alone: emptying it is all a destroy asks of the agent, and the edge's namespace may
    // be gone already, deleted by a destroy that stopped after it.
    stores: { bucket: names.artifactsBucket, edgeState: undefined },
    script: scripts.agent,
    subdomain: account.subdomain,
    mode: 'destroy',
    existing: new Set(account.projectWorkers),
    // Gone by now (`workersOf`), and nothing a destroy asks of the agent reaches it.
    withCache: false,
    fetch: io.fetch,
    sleep: io.sleep,
    now: io.now,
  });
  say(`emptied ${names.artifactsBucket} of ${String(await purge(session.client))} objects`);
}

/** The application's stores, deleted where asked to, and listed where not. */
async function applicationStores(
  scope: AccountScope,
  recorded: Readonly<Record<string, string>>,
  includeStorage: boolean,
): Promise<LeftStore[]> {
  const left: LeftStore[] = [];
  const made = Object.entries(recorded).filter(([name]) => /^(?:kv|d1|r2):/u.test(name));
  for (const [name, id] of made) {
    if (!includeStorage) {
      left.push({ name, id });
      continue;
    }
    if (name.startsWith('kv:')) {
      await deleteKvNamespace(scope, id);
    } else if (name.startsWith('d1:')) {
      await deleteD1Database(scope, id);
    } else {
      try {
        await deleteBucket(scope, id);
      } catch (error) {
        if (error instanceof CloudflareApiError && error.codes.includes(BUCKET_NOT_EMPTY)) {
          left.push({ name, id, why: 'which still holds objects: empty it, and run this again' });
          continue;
        }
        throw error;
      }
    }
    say(`deleted ${name}`);
  }
  return left;
}

/** Why nothing of the account may be destroyed; nothing where it may. */
function refusalOf(names: ProjectNames, account: AccountView): string | undefined {
  const { bucket, subdomain } = account;
  if (bucket === undefined) {
    return account.projectWorkers.length > 0
      ? `the account has Workers named for ${names.project} and no ${names.artifactsBucket} saying they are its; delete them by hand if they are`
      : undefined;
  }
  if (account.owner?.project !== names.project) {
    return `${names.artifactsBucket} was not made by upwind deploy for ${names.project}, so nothing of it is destroyed`;
  }
  return subdomain === undefined
    ? "the account has no workers.dev subdomain, where the agent that empties the bucket is reached; choose one in Cloudflare's settings for Workers"
    : undefined;
}

/**
 * The bucket deleted, its owner mark last — or, where the application's storage is left, kept with
 * the mark as the record of it: without that, a later deploy would refuse the project's own storage
 * as somebody else's.
 *
 * A bucket that cannot be deleted once its mark is gone has the mark written back, as it stood: a
 * bucket left without one is one no later destroy would touch.
 */
async function settleBucket(
  scope: AccountScope,
  names: ProjectNames,
  input: { readonly left: readonly LeftStore[]; readonly mark: OwnerMark },
): Promise<void> {
  const { left, mark } = input;
  if (left.length === 0) {
    await deleteObject(scope, names.artifactsBucket, OWNER_KEY);
    try {
      await deleteBucket(scope, names.artifactsBucket);
    } catch (error) {
      try {
        await writeOwnerMark(scope, names.artifactsBucket, mark);
      } catch (error_) {
        const why = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${names.artifactsBucket} could not be deleted (${why}), and its owner mark could not be written back: it holds nothing of the project's now — delete it by hand`,
          { cause: error_ },
        );
      }
      throw error;
    }
    return;
  }
  await writeOwnerMark(scope, names.artifactsBucket, {
    v: 1,
    project: names.project,
    made: Object.fromEntries(left.map((store) => [store.name, store.id])),
    pending: [],
  });
}

/** Delete what the account holds of the project; what is left of the application's storage. */
async function destroyAll(
  scope: AccountScope,
  names: ProjectNames,
  account: AccountView,
  input: { readonly options: DestroyOptions; readonly io: DestroyIo },
): Promise<LeftStore[]> {
  const mark: OwnerMark = account.owner ?? { v: 1, project: names.project, made: {}, pending: [] };
  // Read before anything is deleted: the stores a stopped deploy made and never recorded.
  const recorded = await recordedStores(scope, names, mark);
  for (const name of workersOf(names, account)) {
    // `force`: a Worker another binds is deleted all the same, its Durable Objects with it.
    await deleteScript(scope, name, { force: true });
  }
  const { subdomain } = account;
  if (subdomain !== undefined && account.bucket !== undefined) {
    await emptyBucket(scope, names, { ...account, subdomain }, input.io);
  }
  await deleteScript(scope, names.agent, { force: true });
  for (const title of [names.edgeStateTitle, names.cacheStateTitle]) {
    const id = recorded[title];
    if (id !== undefined) {
      await deleteKvNamespace(scope, id);
    }
  }
  const left = await applicationStores(scope, recorded, input.options.includeStorage);
  if (account.bucket !== undefined) {
    await settleBucket(scope, names, {
      left,
      mark: { ...mark, made: recorded, pending: [] },
    });
  }
  return left;
}

/** Delete everything a deploy made for the project; what the command exits with. */
export async function runDestroy(
  options: DestroyOptions,
  credentials: CloudflareCredentials | undefined,
  io: DestroyIo = {},
): Promise<number> {
  if (!options.yes) {
    console.error(
      "upwind: destroy deletes the project's site, every deployment of it and every file they serve; run it with --yes",
    );
    return 1;
  }
  if (credentials === undefined) {
    console.error(
      'upwind: destroy reaches the account with CLOUDFLARE_API_TOKEN, which is not set',
    );
    return 1;
  }
  const settings = await readDeploySettings(options.projectDir);
  const names = projectNames(settings.project);
  const client = createCloudflareClient({ apiToken: credentials.apiToken, fetch: io.fetch });
  const scope = { client, accountId: await resolveAccount(client, credentials.accountId) };
  return withProjectLock(
    scope,
    names,
    async (held) => {
      const { scope } = held;
      const lockedIo = { ...io, fetch: held.fetch };
      const account = await readAccount(scope, names);
      const refused = refusalOf(names, account);
      if (refused !== undefined) {
        console.error(`upwind: ${refused}`);
        return 1;
      }
      const left = await destroyAll(scope, names, account, { options, io: lockedIo });
      say(`destroyed ${names.project}`);
      if (left.length > 0) {
        say(
          `the application's storage is left as it is, and ${names.artifactsBucket} with the record of it (--include-storage deletes them):`,
        );
        for (const store of left) {
          const why = store.why === undefined ? '' : `, ${store.why}`;
          console.log(`  ${store.name} (${store.id})${why}`);
        }
      }
      return 0;
    },
    { fetch: io.fetch },
  );
}
