import { createHash } from 'node:crypto';

import { type AccountView, markOwns, type OwnerMark, writeOwnerMark } from './account.ts';
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
 * The bucket is made first, and the owner mark in it (`OWNER_KEY`) before anything else: every
 * other store is trusted as the project's only alongside that mark. Each store is written into the
 * mark as one about to be made (`pending`) before it is made, and with its id once it is, so a run
 * stopped between the two leaves nothing the next run would refuse as somebody else's.
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

async function create(scope: AccountScope, wanted: Wanted): Promise<string> {
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

/** Find or make every store the deployment needs, and say what each is. */
export async function ensureStores(input: {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  readonly account: AccountView;
  readonly storage: readonly StorageBinding[];
}): Promise<ProjectStores> {
  const { scope, names, account, storage } = input;
  assertDistinct(names.project, storage);
  if (account.bucket === undefined) {
    await createBucket(scope, names.artifactsBucket);
  }
  const wanted: Wanted[] = [
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
  const namespaces = await listKvNamespaces(scope);
  const found = await Promise.all(wanted.map((one) => existingOf(scope, one, namespaces)));
  // Judged by the mark as it was before this run, which marks as pending only what is not there
  // yet: a store of the project's name that the mark does not say is the project's is refused,
  // here and on every later run.
  const initial = account.owner ?? { v: 1, project: names.project, made: {}, pending: [] };
  for (const [index, one] of wanted.entries()) {
    const id = found[index];
    if (id !== undefined && !markOwns(initial, one.recorded, id)) {
      throw new Error(
        `${one.name} is on the account, and was not made for ${names.project}'s ${one.of}`,
      );
    }
  }
  const mark = markOf(scope, names.artifactsBucket, initial);
  const absent = wanted.filter((_, index) => found[index] === undefined);
  if (account.owner === undefined || absent.length > 0) {
    await mark.intend(absent.map((one) => one.recorded));
  }
  const ids: string[] = [];
  for (const [index, one] of wanted.entries()) {
    const id = found[index] ?? (await create(scope, one));
    if (mark.value.made[one.recorded] !== id) {
      await mark.made(one.recorded, id);
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
