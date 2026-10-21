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

/**
 * A namespace of the title, found or made, and recorded in the mark under `recorded` either way:
 * its title, for the deployment's own; its binding, for one of the application's.
 */
async function namespaceOf(
  scope: AccountScope,
  mark: Mark,
  namespace: { readonly title: string; readonly recorded: string },
  found: readonly KvNamespace[],
): Promise<string> {
  const { title, recorded } = namespace;
  const existing = found.find((candidate) => candidate.title === title);
  if (existing !== undefined) {
    if (!markOwns(mark.value, recorded, existing.id)) {
      throw new Error(
        `the KV namespace ${title} is on the account, and was not made for this project`,
      );
    }
    if (mark.value.made[recorded] !== existing.id) {
      await mark.made(recorded, existing.id);
    }
    return existing.id;
  }
  const made = await createKvNamespace(scope, title);
  await mark.made(recorded, made.id);
  return made.id;
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

async function createStore(scope: AccountScope, kind: 'd1' | 'r2', name: string): Promise<string> {
  return kind === 'd1'
    ? (await createD1Database(scope, name)).uuid
    : (await createBucket(scope, name)).name;
}

/** An application's store, found or made, and recorded in the mark either way. */
async function storeOf(
  scope: AccountScope,
  mark: Mark,
  binding: StorageBinding & { readonly project: string },
  namespaces: readonly KvNamespace[],
): Promise<MadeStorage> {
  const name = storageName(binding.project, binding);
  const recorded = markName(binding);
  if (binding.kind === 'kv') {
    const id = await namespaceOf(scope, mark, { title: name, recorded }, namespaces);
    return { binding: binding.name, kind: binding.kind, id };
  }
  const existing = await existingStore(scope, binding.kind, name);
  if (existing !== undefined) {
    if (!markOwns(mark.value, recorded, existing)) {
      throw new Error(
        `${name} is on the account, and was not made for this project's ${binding.name}`,
      );
    }
    if (mark.value.made[recorded] !== existing) {
      await mark.made(recorded, existing);
    }
    return { binding: binding.name, kind: binding.kind, id: existing };
  }
  const id = await createStore(scope, binding.kind, name);
  await mark.made(recorded, id);
  return { binding: binding.name, kind: binding.kind, id };
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
  const mark = markOf(
    scope,
    names.artifactsBucket,
    account.owner ?? { v: 1, project: names.project, made: {}, pending: [] },
  );
  const namespaces = await listKvNamespaces(scope);
  const wanted = [
    names.edgeStateTitle,
    names.cacheStateTitle,
    ...storage.map((binding) => markName(binding)),
  ];
  const unrecorded = wanted.filter((name) => mark.value.made[name] === undefined);
  if (account.owner === undefined || unrecorded.length > 0) {
    await mark.intend(unrecorded);
  }
  const edgeState = await namespaceOf(
    scope,
    mark,
    { title: names.edgeStateTitle, recorded: names.edgeStateTitle },
    namespaces,
  );
  const cacheState = await namespaceOf(
    scope,
    mark,
    { title: names.cacheStateTitle, recorded: names.cacheStateTitle },
    namespaces,
  );
  const made: MadeStorage[] = [];
  for (const binding of storage) {
    made.push(await storeOf(scope, mark, { ...binding, project: names.project }, namespaces));
  }
  return { edgeState, cacheState, bucket: names.artifactsBucket, storage: made };
}
