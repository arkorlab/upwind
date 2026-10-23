import { describe, expect, it } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import type { AccountScope } from '../../src/deploy/cloudflare/workers.ts';
import { ensureInfra, type InfraInput } from '../../src/deploy/infra.ts';
import { projectNames } from '../../src/deploy/names.ts';
import {
  sha256Of,
  WORKER_ROLES,
  type WorkerRole,
  type WorkerScript,
} from '../../src/deploy/shipped.ts';
import {
  type FakeCloudflare,
  type FakeScript,
  type FakeVersion,
  fakeCloudflare,
} from './fake-cloudflare.ts';

const NAMES = projectNames('shop');
const STORES = {
  edgeState: 'kv-edge',
  cacheState: 'kv-cache',
  bucket: NAMES.artifactsBucket,
  storage: [],
};
const KEY_TAG = /^upwind:infra:[\da-f]{16}:key-([\da-f]{12})$/u;

function scriptOf(role: WorkerRole, script = `export default {}; // ${role}`): WorkerScript {
  return { role, script, sha256: sha256Of(script) };
}

function scripts(
  overrides: Partial<Record<WorkerRole, WorkerScript>> = {},
): Record<WorkerRole, WorkerScript> {
  const all = Object.fromEntries(WORKER_ROLES.map((role) => [role, scriptOf(role)])) as Record<
    WorkerRole,
    WorkerScript
  >;
  return { ...all, ...overrides };
}

function scopeOf(fake: FakeCloudflare): AccountScope {
  return {
    client: createCloudflareClient({
      apiToken: 'token',
      fetch: fake.fetch,
      sleep: () => Promise.resolve(),
    }),
    accountId: 'account-1',
  };
}

function run(
  fake: FakeCloudflare,
  input: Partial<InfraInput> = {},
): ReturnType<typeof ensureInfra> {
  return ensureInfra({
    scope: scopeOf(fake),
    names: NAMES,
    stores: STORES,
    scripts: scripts(),
    existing: new Set(fake.scripts.keys()),
    live: false,
    resetCacheKey: false,
    ...input,
  });
}

function scriptNamed(fake: FakeCloudflare, name: string): FakeScript {
  const script = fake.scripts.get(name);
  if (script === undefined) {
    throw new Error(`the account has no ${name}`);
  }
  return script;
}

/** The newest version of a Worker, as the fake holds it. */
function newest(fake: FakeCloudflare, name: string): FakeVersion {
  const version = fake.scripts.get(name)?.versions[0];
  if (version === undefined) {
    throw new Error(`${name} has no version`);
  }
  return version;
}

interface Binding {
  readonly type: string;
  readonly name: string;
  readonly text?: string;
}

function bindingsOf(version: FakeVersion): readonly Binding[] {
  return version.metadata['bindings'] as readonly Binding[];
}

function keyOf(version: FakeVersion): string | undefined {
  return bindingsOf(version).find((binding) => binding.name === 'CACHE_TOKEN_KEY')?.text;
}

function keyIdOf(version: FakeVersion): string | undefined {
  return KEY_TAG.exec(version.annotations['workers/tag'] ?? '')?.[1];
}

/** An upload of a Worker's code: a `PUT` of the Worker itself. */
const SCRIPT_UPLOAD = /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)$/u;

/** The Workers uploaded, in the order they were. */
function uploads(fake: FakeCloudflare): string[] {
  const uploaded: string[] = [];
  for (const request of fake.requests) {
    const name = request.method === 'PUT' ? SCRIPT_UPLOAD.exec(request.path)?.[1] : undefined;
    if (name !== undefined) {
      uploaded.push(name);
    }
  }
  return uploaded;
}

describe("the project's Workers behind its Functions", () => {
  it('are made unreachable and uploaded the first time, the cache with its migration and key', async () => {
    const fake = fakeCloudflare();
    const result = await run(fake);

    expect(result).toStrictEqual({
      uploaded: [NAMES.cacheRead, NAMES.cache, NAMES.prefetch],
      freshKey: true,
    });
    expect(uploads(fake)).toStrictEqual([NAMES.cacheRead, NAMES.cache, NAMES.prefetch]);

    for (const name of [NAMES.cacheRead, NAMES.cache, NAMES.prefetch]) {
      expect(scriptNamed(fake, name).subdomain).toStrictEqual({
        enabled: false,
        previews_enabled: false,
      });
    }
  });

  it('give the cache its migration, and the cache and its read gateway one key', async () => {
    const fake = fakeCloudflare();
    await run(fake);
    const cache = newest(fake, NAMES.cache);
    const read = newest(fake, NAMES.cacheRead);

    expect(cache.metadata['migrations']).toStrictEqual({
      new_tag: 'upwind-v1',
      steps: [{ new_sqlite_classes: ['CacheScope'] }],
    });
    expect(bindingsOf(cache)).toContainEqual({
      type: 'durable_object_namespace',
      name: 'CACHE_SCOPE',
      class_name: 'CacheScope',
    });
    expect(cache.metadata['keep_bindings']).toBeUndefined();
    // One key, in both: what one signs, the other checks.
    expect(keyOf(cache)?.length).toBeGreaterThanOrEqual(32);
    expect(keyOf(read)).toBe(keyOf(cache));

    const keyId = keyIdOf(cache) ?? '';

    expect(keyId).toMatch(/^[\da-f]{12}$/u);
    expect(keyIdOf(read)).toBe(keyId);
    // The key's id is nothing of the key.
    expect(keyOf(cache)).not.toContain(keyId);
  });

  it('let the prefetch Worker reach nothing a binding does not name', async () => {
    const fake = fakeCloudflare();
    await run(fake);
    const prefetch = newest(fake, NAMES.prefetch);

    expect(bindingsOf(prefetch)).toStrictEqual([
      { type: 'r2_bucket', name: 'ARTIFACTS', bucket_name: NAMES.artifactsBucket },
      { type: 'plain_text', name: 'PREFETCH_LEGACY_ACCESS', text: 'deny' },
    ]);
    expect(prefetch.annotations['workers/tag']).toMatch(/^upwind:infra:[\da-f]{16}$/u);
  });

  it('are uploaded no more where the newest version is tagged as this one', async () => {
    const fake = fakeCloudflare();
    await run(fake);
    const before = uploads(fake).length;

    await expect(run(fake)).resolves.toStrictEqual({ uploaded: [], freshKey: false });
    expect(uploads(fake)).toHaveLength(before);
  });

  it('are uploaded again with the key they hold kept, where their code changed', async () => {
    const fake = fakeCloudflare();
    await run(fake);
    const keyId = keyIdOf(newest(fake, NAMES.cache));
    const result = await run(fake, {
      scripts: scripts({ cache: scriptOf('cache', 'export default {}; // a newer cache') }),
    });

    expect(result).toStrictEqual({ uploaded: [NAMES.cache], freshKey: false });

    const cache = newest(fake, NAMES.cache);

    expect(cache.metadata['keep_bindings']).toStrictEqual(['secret_text']);
    expect(keyOf(cache)).toBeUndefined();
    // Applied once already: not carried again.
    expect(cache.metadata['migrations']).toBeUndefined();
    expect(keyIdOf(cache)).toBe(keyId);
  });

  it('get a new key where the two hold different ones, unless a deployment is live', async () => {
    const fake = fakeCloudflare();
    await run(fake);
    const read = scriptNamed(fake, NAMES.cacheRead);
    read.versions.unshift({
      ...newest(fake, NAMES.cacheRead),
      id: 'version-other',
      annotations: { 'workers/tag': 'upwind:infra:0000000000000000:key-000000000000' },
    });

    await expect(run(fake, { live: true })).rejects.toThrow(
      `${NAMES.cache} and ${NAMES.cacheRead} do not hold the same key, and a deployment is live`,
    );

    const reset = await run(fake, { live: true, resetCacheKey: true });

    expect(reset).toStrictEqual({ uploaded: [NAMES.cacheRead, NAMES.cache], freshKey: true });
    expect(keyOf(newest(fake, NAMES.cacheRead))).toBe(keyOf(newest(fake, NAMES.cache)));
    expect(keyIdOf(newest(fake, NAMES.cacheRead))).toBe(keyIdOf(newest(fake, NAMES.cache)));

    read.versions.unshift({
      ...newest(fake, NAMES.cacheRead),
      id: 'version-another',
      annotations: { 'workers/tag': 'upwind:infra:0000000000000000:key-111111111111' },
    });

    // With nothing live, there is nobody to cut off.
    await expect(run(fake)).resolves.toMatchObject({ freshKey: true });
  });

  it('refuse a cache that applied Durable Object migrations no deploy made', async () => {
    const fake = fakeCloudflare();
    await run(fake);
    scriptNamed(fake, NAMES.cache).migrationTag = 'v1';

    await expect(run(fake, { resetCacheKey: true })).rejects.toThrow(
      `${NAMES.cache} has applied Durable Object migrations up to v1`,
    );
  });
});
