import { createHash } from 'node:crypto';

import {
  type AccountView,
  bucketRefusal,
  markOwns,
  OWNER_KEY,
  type OwnerMark,
  writeOwnerMark,
} from './account.ts';
import { CloudflareApiError } from './cloudflare/client.ts';
import {
  createBucket,
  createD1Database,
  createKvNamespace,
  findD1Database,
  getBucket,
  type KvNamespace,
  listKvNamespaces,
} from './cloudflare/storage.ts';
import type { AccountScope } from './cloudflare/workers.ts';
import type { StorageBinding, StorageKind } from './config.ts';
import type { ProjectNames } from './names.ts';

/**
 * The stores a deployment is served from, found or made: the edge's namespace and the cache's,
 * the bucket of artifacts, and each store the application asked for by name (`deploy.storage`).
 *
 * Everything is looked up, and every store found is held to the owner mark (`OWNER_KEY`), before
 * anything is made: a refusal leaves the account as it was. Then the bucket is made, where there is
 * none, and the mark written in it at once, naming as about to be made (`pending`) every store
 * this run makes after it; each is recorded with its id once it is made. A run stopped between
 * making a store and recording it leaves nothing the next run would refuse as somebody else's — and
 * one stopped between making the bucket and marking it leaves a bucket that holds nothing, which
 * the next run refuses (`bucketRefusal`) and says how to clear.
 *
 * A project is deployed by one run at a time. One that finds another making the same stores — a
 * store that was not there when it looked, there when it went to make it, or there twice once it
 * made it — stops, and says so, rather than taking either for its own.
 */

/** What a project's stores are, once they are there. */
export interface ProjectStores {
  readonly edgeState: string;
  readonly cacheState: string;
  readonly bucket: string;
  /** Each store the application asked for, by its binding, with what the binding names it by. */
  readonly storage: readonly MadeStorage[];
}

export interface MadeStorage {
  readonly binding: string;
  readonly kind: StorageKind;
  /** A namespace's id, a database's id, or a bucket's name. */
  readonly id: string;
}

/** An R2 bucket's name, and a D1 database's, is at most this long. */
const MAX_STORE_NAME = 63;
const NAME_HASH_DIGITS = 8;

/** What an application's store is called on the account: its name, or a namespace's title. */
export function storageName(project: string, binding: StorageBinding): string {
  if (binding.kind === 'kv') {
    return `upwind:${project}:kv:${binding.name}`;
  }
  const slug = binding.name
    .toLowerCase()
    .split(/[^\da-z]+/u)
    .filter((part) => part !== '')
    .join('-');
  const name = `${project}-${binding.kind}-${slug === '' ? 'store' : slug}`;
  if (name.length <= MAX_STORE_NAME) {
    return name;
  }
  const hash = createHash('sha256').update(binding.name).digest('hex').slice(0, NAME_HASH_DIGITS);
  let cut = name.slice(0, MAX_STORE_NAME - NAME_HASH_DIGITS - 1);
  while (cut.endsWith('-')) {
    cut = cut.slice(0, -1);
  }
  return `${cut}-${hash}`;
}

/** The mark's name for an application's store: its kind and its binding. */
function markName(binding: StorageBinding): string {
  return `${binding.kind}:${binding.name}`;
}

/** The mark as a run records it: written each time it changes, so a stop loses nothing. */
interface Mark {
  readonly value: OwnerMark;
  /** Record that these are about to be made. */
  intend(names: readonly string[]): Promise<void>;
  /** Record what was made, by its name and id. */
  made(name: string, id: string): Promise<void>;
}

function markOf(scope: AccountScope, bucket: string, initial: OwnerMark): Mark {
  let current = initial;
  const write = async (next: OwnerMark): Promise<void> => {
    await writeOwnerMark(scope, bucket, next);
    current = next;
  };
  return {
    get value() {
      return current;
    },
    intend: async (names) => {
      const pending = new Set(current.pending);
      for (const name of names) {
        pending.add(name);
      }
      await write({ ...current, pending: [...pending] });
    },
    made: async (name, id) => {
      await write({
        ...current,
        made: { ...current.made, [name]: id },
        pending: current.pending.filter((pending) => pending !== name),
      });
    },
  };
}

/** A store the deployment needs: what the mark calls it, and what the account does. */
interface Wanted {
  readonly recorded: string;
  readonly kind: StorageKind;
  /** A namespace's title, or a database's or a bucket's name. */
  readonly name: string;
  /** Whose it is, for a message: the deployment's, or one of the application's bindings. */
  readonly of: string;
}

/** The id of an application's database or bucket on the account; nothing where there is none. */
async function existingStore(
  scope: AccountScope,
  kind: 'd1' | 'r2',
  name: string,
): Promise<string | undefined> {
  if (kind === 'd1') {
    return (await findD1Database(scope, name))?.uuid;
  }
  return (await getBucket(scope, name)) === undefined ? undefined : name;
}

/** The id of a store the account holds under the wanted name; nothing where it holds none. */
async function existingOf(
  scope: AccountScope,
  wanted: Wanted,
  namespaces: readonly KvNamespace[],
): Promise<string | undefined> {
  if (wanted.kind === 'kv') {
    return namespaces.find((namespace) => namespace.title === wanted.name)?.id;
  }
  return existingStore(scope, wanted.kind, wanted.name);
}

async function createOnce(scope: AccountScope, wanted: Wanted): Promise<string> {
  switch (wanted.kind) {
    case 'kv': {
      return (await createKvNamespace(scope, wanted.name)).id;
    }
    case 'd1': {
      return (await createD1Database(scope, wanted.name)).uuid;
    }
    case 'r2': {
      return (await createBucket(scope, wanted.name)).name;
    }
  }
}

/** What a run that finds another making the project's stores says, beside what it found. */
function oneAtATime(project: string): string {
  return `another deploy of ${project} is making its stores, and a project is deployed by one run at a time`;
}

/**
 * Make a store this run found absent — refused, with what happened said, where another run made it
 * in the meantime: by a refusal to make it that the store's being there now explains.
 */
async function create(scope: AccountScope, project: string, wanted: Wanted): Promise<string> {
  try {
    return await createOnce(scope, wanted);
  } catch (error) {
    if (!(error instanceof CloudflareApiError)) {
      throw error;
    }
    const namespaces = wanted.kind === 'kv' ? await listKvNamespaces(scope) : [];
    if ((await existingOf(scope, wanted, namespaces)) === undefined) {
      throw error;
    }
    throw new Error(
      `${wanted.name} was made by another run as this one went to make it: ${oneAtATime(project)}; let that one finish, and run this again`,
      { cause: error },
    );
  }
}

/**
 * Refuses a namespace this run made that another run made beside it: two of one title, which no
 * later run could tell apart. The one the mark records is this run's, and says which to delete.
 */
async function assertOnly(scope: AccountScope, names: ProjectNames, wanted: Wanted): Promise<void> {
  if (wanted.kind !== 'kv') {
    // A database's name and a bucket's are the account's once: a second is refused as it is made.
    return;
  }
  const titled = (await listKvNamespaces(scope)).filter(
    (namespace) => namespace.title === wanted.name,
  );
  if (titled.length > 1) {
    throw new Error(
      `the account now has ${String(titled.length)} KV namespaces titled ${wanted.name} (${titled.map((namespace) => namespace.id).join(', ')}): ${oneAtATime(names.project)}. Let that one finish, delete the one ${OWNER_KEY} in ${names.artifactsBucket} does not record, and run this again`,
    );
  }
}

/** Refuses two bindings whose stores would have one name. */
function assertDistinct(project: string, storage: readonly StorageBinding[]): void {
  const seen = new Map<string, string>();
  for (const binding of storage) {
    const name = storageName(project, binding);
    const other = seen.get(name);
    if (other !== undefined) {
      throw new Error(
        `deploy.storage's ${other} and ${binding.name} would both be ${name}; rename one`,
      );
    }
    seen.set(name, binding.name);
  }
}

function madeStorage(binding: StorageBinding, id = ''): MadeStorage {
  return { binding: binding.name, kind: binding.kind, id };
}

/** Every store the deployment needs, as the mark records it and the account names it. */
function wantedOf(names: ProjectNames, storage: readonly StorageBinding[]): Wanted[] {
  return [
    { recorded: names.edgeStateTitle, kind: 'kv', name: names.edgeStateTitle, of: 'the edge' },
    { recorded: names.cacheStateTitle, kind: 'kv', name: names.cacheStateTitle, of: 'the cache' },
    ...storage.map((binding) => {
      return {
        recorded: markName(binding),
        kind: binding.kind,
        name: storageName(names.project, binding),
        of: binding.name,
      };
    }),
  ];
}

/** The store a name in the mark stands for, as the account names it; nothing for any other name. */
function recordedAs(names: ProjectNames, recorded: string): Wanted | undefined {
  if (recorded === names.edgeStateTitle || recorded === names.cacheStateTitle) {
    return { recorded, kind: 'kv', name: recorded, of: 'the deployment' };
  }
  const colon = recorded.indexOf(':');
  const kind = recorded.slice(0, colon);
  if (colon === -1 || (kind !== 'd1' && kind !== 'kv' && kind !== 'r2')) {
    return undefined;
  }
  const binding = { name: recorded.slice(colon + 1), kind } as const;
  return { recorded, kind, name: storageName(names.project, binding), of: binding.name };
}

/**
 * Every store the mark records, by the name it records each under: those it says were made, and
 * those it says were about to be made and are on the account — a run stopped between making a
 * store and recording it leaves only its name. One that is not on the account was never made.
 */
export async function recordedStores(
  scope: AccountScope,
  names: ProjectNames,
  mark: OwnerMark,
): Promise<Readonly<Record<string, string>>> {
  const recorded: Record<string, string> = { ...mark.made };
  const pending = mark.pending.filter((name) => recorded[name] === undefined);
  if (pending.length === 0) {
    return recorded;
  }
  const namespaces = await listKvNamespaces(scope);
  for (const name of pending) {
    const wanted = recordedAs(names, name);
    const id = wanted === undefined ? undefined : await existingOf(scope, wanted, namespaces);
    if (id !== undefined) {
      recorded[name] = id;
    }
  }
  return recorded;
}

/**
 * Refuses what the account holds under the project's names and the mark does not say is the
 * project's: the bucket, and every store found.
 */
function assertOwned(
  names: ProjectNames,
  account: AccountView,
  owned: { readonly wanted: readonly Wanted[]; readonly found: readonly (string | undefined)[] },
): OwnerMark {
  const refused = account.bucket === undefined ? undefined : bucketRefusal(names, account.owner);
  if (refused !== undefined) {
    throw new Error(refused);
  }
  // Judged by the mark as it was before this run, which marks as pending only what is not there
  // yet: a store of the project's name that the mark does not say is the project's is refused,
  // here and on every later run.
  const initial = account.owner ?? { v: 1, project: names.project, made: {}, pending: [] };
  for (const [index, one] of owned.wanted.entries()) {
    const id = owned.found[index];
    if (id !== undefined && !markOwns(initial, one.recorded, id)) {
      throw new Error(
        `${one.name} is on the account, and was not made for ${names.project}'s ${one.of}`,
      );
    }
  }
  return initial;
}

/** Find or make every store the deployment needs, and say what each is. */
export async function ensureStores(input: {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  readonly account: AccountView;
  readonly storage: readonly StorageBinding[];
}): Promise<ProjectStores> {
  const { scope, names, account, storage } = input;
  assertDistinct(names.project, storage);
  const wanted = wantedOf(names, storage);
  const namespaces = await listKvNamespaces(scope);
  const found = await Promise.all(wanted.map((one) => existingOf(scope, one, namespaces)));
  const initial = assertOwned(names, account, { wanted, found });
  const absent = wanted.filter((_, index) => found[index] === undefined).map((one) => one.recorded);
  const mark = markOf(scope, names.artifactsBucket, initial);
  if (account.bucket === undefined) {
    // The bucket, and at once the mark in it: nothing between the two can be refused.
    await create(scope, names.project, {
      recorded: OWNER_KEY,
      kind: 'r2',
      name: names.artifactsBucket,
      of: 'the deployments',
    });
    await mark.intend(absent);
  } else if (absent.length > 0) {
    await mark.intend(absent);
  }
  const ids: string[] = [];
  for (const [index, one] of wanted.entries()) {
    const id = found[index] ?? (await create(scope, names.project, one));
    if (mark.value.made[one.recorded] !== id) {
      await mark.made(one.recorded, id);
    }
    if (found[index] === undefined) {
      await assertOnly(scope, names, one);
    }
    ids.push(id);
  }
  const [edgeState = '', cacheState = '', ...rest] = ids;
  return {
    edgeState,
    cacheState,
    bucket: names.artifactsBucket,
    storage: storage.map((binding, index) => madeStorage(binding, rest[index])),
  };
}
