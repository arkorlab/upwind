import { randomBytes, randomUUID } from 'node:crypto';

import type { WorkerBinding, WorkerMetadata } from './cloudflare/form.ts';
import { type AccountScope, migrationTag, putScript } from './cloudflare/workers.ts';
import type { ProjectNames } from './names.ts';
import type { WorkerRole, WorkerScript } from './shipped.ts';
import type { ProjectStores } from './stores.ts';
import {
  COMPATIBILITY_DATE,
  ensureWorker,
  holdReach,
  infraTag,
  newestTag,
  shippedForm,
  UNREACHED,
} from './uploads.ts';

/**
 * The project's Workers behind its Functions, uploaded where they are not already this version's:
 * the runtime cache's read gateway and authority, and the prefetch Worker. None is reached but by a
 * service binding.
 *
 * Each is tagged with the digest of what it was uploaded as (`infraTag`), and one whose newest
 * version carries the tag this run would give it is left as it is: most deploys upload none of
 * them. One that is uploaded is uploaded before any Function that binds it, so that every binding a
 * deployment is uploaded with reaches a Worker that answers it.
 *
 * The cache and its read gateway share a key, which signs and checks the token each deployment's
 * Functions open their scope with. It is made here, once, put in both as a secret and kept nowhere
 * else; each upload after that keeps it (`keep_bindings`). Its id rides in both Workers' tags, so a
 * run sees whether the two hold the same one — and makes a new one where they do not and no
 * deployment is live, or is told to (`--reset-cache-key`), since a new key closes every scope a
 * live deployment's Functions hold a token to.
 */

/** The Durable Object migration the authority's scopes are made by, and its class. */
const CACHE_MIGRATION_TAG = 'upwind-v1';
const CACHE_SCOPE_CLASS = 'CacheScope';
/** How a key's id follows the upload's digest in a tag. */
const KEY_TAG = ':key-';
const KEY_BYTES = 32;
const KEY_ID_LENGTH = 12;
const CACHE_TOKEN_KEY = 'CACHE_TOKEN_KEY';

export interface InfraInput {
  readonly scope: AccountScope;
  readonly names: ProjectNames;
  readonly stores: ProjectStores;
  readonly scripts: Readonly<Record<WorkerRole, WorkerScript>>;
  /** The Workers the account holds now, by name. */
  readonly existing: ReadonlySet<string>;
  /** Whether a deployment of the project is live, which a new cache key would cut off. */
  readonly live: boolean;
  readonly resetCacheKey: boolean;
}

/** What a run did to the project's Workers, for its report. */
export interface InfraResult {
  readonly uploaded: readonly string[];
  readonly freshKey: boolean;
}

function keyIdOf(tag: string | undefined): string | undefined {
  const at = tag?.indexOf(KEY_TAG) ?? -1;
  return tag === undefined || at === -1 ? undefined : tag.slice(at + KEY_TAG.length);
}

/** The cache's key: the one both Workers hold, or a new one, made only where it may be. */
async function cacheKey(
  input: InfraInput,
): Promise<{ readonly id: string; readonly secret: string | undefined }> {
  const { scope, names, existing } = input;
  const tags = await Promise.all(
    [names.cache, names.cacheRead].map((name) =>
      existing.has(name) ? newestTag(scope, name) : Promise.resolve(undefined),
    ),
  );
  const [held, read] = tags.map((tag) => keyIdOf(tag));
  if (input.resetCacheKey) {
    return made();
  }
  if (held !== undefined && held === read) {
    return { id: held, secret: undefined };
  }
  const either = existing.has(names.cache) || existing.has(names.cacheRead);
  if (either && input.live) {
    throw new Error(
      `${names.cache} and ${names.cacheRead} do not hold the same key, and a deployment is live; deploy with --reset-cache-key to give both a new one, which closes the runtime cache to every deployment but the one being made`,
    );
  }
  return made();
}

/** A key, and its id: random, and the id nothing of the key. */
function made(): { readonly id: string; readonly secret: string } {
  return {
    id: randomUUID().replaceAll('-', '').slice(0, KEY_ID_LENGTH),
    secret: randomBytes(KEY_BYTES).toString('base64url'),
  };
}

/** The migration the cache's upload carries: the first, or none once it is applied. */
async function cacheMigrations(input: InfraInput): Promise<WorkerMetadata['migrations']> {
  const { scope, names, existing } = input;
  const applied = existing.has(names.cache) ? await migrationTag(scope, names.cache) : undefined;
  if (applied === CACHE_MIGRATION_TAG) {
    return undefined;
  }
  if (applied !== undefined) {
    throw new Error(
      `${names.cache} has applied Durable Object migrations up to ${applied}, which no version of upwind deploy made; it is not this project's cache`,
    );
  }
  return { new_tag: CACHE_MIGRATION_TAG, steps: [{ new_sqlite_classes: [CACHE_SCOPE_CLASS] }] };
}

interface InfraUpload {
  readonly name: string;
  readonly script: WorkerScript;
  readonly bindings: readonly WorkerBinding[];
  /** A key both cache Workers carry, and its id, which joins their tags. */
  readonly key?: { readonly id: string; readonly secret: string | undefined } | undefined;
  readonly migrations?: WorkerMetadata['migrations'];
}

/** Upload one Worker where its newest version is not tagged as this one; whether it was. */
async function upload(input: InfraInput, worker: InfraUpload): Promise<boolean> {
  const { scope, existing } = input;
  const metadata = { compatibility_date: COMPATIBILITY_DATE, bindings: worker.bindings };
  const key = worker.key === undefined ? '' : `${KEY_TAG}${worker.key.id}`;
  const tag = `${infraTag(worker.script.script, metadata)}${key}`;
  const secret = worker.key?.secret;
  if (
    secret === undefined &&
    existing.has(worker.name) &&
    (await newestTag(scope, worker.name)) === tag
  ) {
    return false;
  }
  await ensureWorker(scope, worker.name, UNREACHED, existing);
  await putScript(
    scope,
    worker.name,
    shippedForm(worker.script.script, {
      ...metadata,
      bindings: [
        ...worker.bindings,
        ...(secret === undefined
          ? []
          : [{ type: 'secret_text', name: CACHE_TOKEN_KEY, text: secret } as const]),
      ],
      annotations: { 'workers/tag': tag, 'workers/message': 'upwind deploy' },
      // A secret this run does not hold — the cache's key, set when it was made — stays as it is.
      ...(secret === undefined && { keep_bindings: ['secret_text'] }),
      ...(worker.migrations !== undefined && { migrations: worker.migrations }),
    }),
  );
  await holdReach(scope, worker.name, UNREACHED);
  return true;
}

/** Upload the Workers behind the Functions where they are not this version's. */
export async function ensureInfra(input: InfraInput): Promise<InfraResult> {
  const { names, stores, scripts } = input;
  const key = await cacheKey(input);
  const cacheState: WorkerBinding = {
    type: 'kv_namespace',
    name: 'CACHE_STATE',
    namespace_id: stores.cacheState,
  };
  const artifacts: WorkerBinding = {
    type: 'r2_bucket',
    name: 'ARTIFACTS',
    bucket_name: stores.bucket,
  };
  const uploads: InfraUpload[] = [
    { name: names.cacheRead, script: scripts['cache-read'], bindings: [cacheState], key },
    {
      name: names.cache,
      script: scripts.cache,
      bindings: [
        cacheState,
        artifacts,
        { type: 'durable_object_namespace', name: 'CACHE_SCOPE', class_name: CACHE_SCOPE_CLASS },
      ],
      key,
      migrations: await cacheMigrations(input),
    },
    {
      name: names.prefetch,
      script: scripts.prefetch,
      // Each Function reaches the blobs its own bundle names and no others (`PrefetchForDeployment`).
      bindings: [artifacts, { type: 'plain_text', name: 'PREFETCH_LEGACY_ACCESS', text: 'deny' }],
    },
  ];
  const uploaded: string[] = [];
  for (const worker of uploads) {
    if (await upload(input, worker)) {
      uploaded.push(worker.name);
    }
  }
  return { uploaded, freshKey: key.secret !== undefined };
}
