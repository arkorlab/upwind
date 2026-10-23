import { describe, expect, it } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { workerForm } from '../../src/deploy/cloudflare/form.ts';
import {
  createBucket,
  createD1Database,
  createKvNamespace,
  deleteBucket,
  deleteD1Database,
  deleteKvNamespace,
  findD1Database,
  getBucket,
  getObject,
  listKvNamespaces,
  putObject,
} from '../../src/deploy/cloudflare/storage.ts';
import {
  accountSubdomain,
  createDeployment,
  createWorker,
  deleteScript,
  getScriptSubdomain,
  listDeployments,
  listVersions,
  migrationTag,
  putScript,
  putSecret,
  uploadVersion,
} from '../../src/deploy/cloudflare/workers.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';

function scopeOf(fake: ReturnType<typeof fakeCloudflare>) {
  return {
    client: createCloudflareClient({ apiToken: 'token', fetch: fake.fetch }),
    accountId: 'account-1',
  };
}

function form(annotations: Record<string, string> = {}, migrations?: { new_tag: string }) {
  return workerForm(
    {
      main_module: 'index.mjs',
      compatibility_date: '2026-09-15',
      bindings: [],
      annotations,
      ...(migrations !== undefined && {
        migrations: { ...migrations, steps: [{ new_sqlite_classes: ['CacheScope'] }] },
      }),
    },
    [{ name: 'index.mjs', type: 'esm', bytes: new TextEncoder().encode('export default {}') }],
  );
}

describe("a Worker's life on the account", () => {
  it('is made closed, uploaded, given a version without traffic, and then the traffic', async () => {
    const fake = fakeCloudflare();
    const scope = scopeOf(fake);

    await expect(accountSubdomain(scope)).resolves.toBe('example');

    await createWorker(scope, 'shop-edge', { enabled: false, previews_enabled: false });

    await expect(getScriptSubdomain(scope, 'shop-edge')).resolves.toStrictEqual({
      enabled: false,
      previews_enabled: false,
    });

    await putScript(scope, 'shop-edge', form({ 'workers/tag': 'first' }));
    const [first] = (await listDeployments(scope, 'shop-edge')) ?? [];
    const candidate = await uploadVersion(scope, 'shop-edge', form({ 'workers/tag': 'second' }));
    const [stillFirst] = (await listDeployments(scope, 'shop-edge')) ?? [];

    expect(stillFirst).toStrictEqual(first);
    // A secret is a new version deployed at once, which Cloudflare refuses while a newer one waits.
    await expect(putSecret(scope, 'shop-edge', { name: 'KEY', text: 'x' })).rejects.toMatchObject({
      status: 400,
    });

    await createDeployment(
      scope,
      'shop-edge',
      [{ version_id: candidate.id, percentage: 100 }],
      'go',
    );
    const [live] = (await listDeployments(scope, 'shop-edge')) ?? [];

    expect(live?.versions).toStrictEqual([{ version_id: candidate.id, percentage: 100 }]);
    expect(
      (await listVersions(scope, 'shop-edge')).map((version) => version.annotations),
    ).toStrictEqual([{ 'workers/tag': 'second' }, { 'workers/tag': 'first' }]);

    await putSecret(scope, 'shop-edge', { name: 'KEY', text: 'x' });

    expect(fake.scripts.get('shop-edge')?.secrets.get('KEY')).toBe('x');
  });

  it('keeps the tag of the migration it applied, and is gone once deleted', async () => {
    const fake = fakeCloudflare();
    const scope = scopeOf(fake);

    await expect(migrationTag(scope, 'shop-cache')).resolves.toBeUndefined();

    await putScript(scope, 'shop-cache', form({}, { new_tag: 'upwind-v1' }));

    await expect(migrationTag(scope, 'shop-cache')).resolves.toBe('upwind-v1');

    await deleteScript(scope, 'shop-cache', { force: true });
    await deleteScript(scope, 'shop-cache', { force: true });

    await expect(listDeployments(scope, 'shop-cache')).resolves.toBeUndefined();
  });
});

describe("a project's stores on the account", () => {
  it('are made, found by name, and deleted', async () => {
    const fake = fakeCloudflare();
    const scope = scopeOf(fake);
    const namespace = await createKvNamespace(scope, 'upwind:shop:edge-state');

    await expect(listKvNamespaces(scope)).resolves.toStrictEqual([namespace]);

    await deleteKvNamespace(scope, namespace.id);

    await expect(listKvNamespaces(scope)).resolves.toStrictEqual([]);

    await createBucket(scope, 'shop-artifacts');

    await expect(getBucket(scope, 'shop-artifacts')).resolves.toStrictEqual({
      name: 'shop-artifacts',
    });

    await putObject(scope, 'shop-artifacts', {
      key: 'upwind/owner.json',
      body: new TextEncoder().encode('{}'),
      contentType: 'application/json',
    });

    await expect(getObject(scope, 'shop-artifacts', 'upwind/owner.json')).resolves.toStrictEqual(
      new TextEncoder().encode('{}'),
    );
    await expect(getObject(scope, 'shop-artifacts', 'missing')).resolves.toBeUndefined();
    await expect(deleteBucket(scope, 'shop-artifacts')).rejects.toMatchObject({ status: 409 });

    const database = await createD1Database(scope, 'shop-d1-db');

    await expect(findD1Database(scope, 'shop-d1-db')).resolves.toStrictEqual(database);

    await deleteD1Database(scope, database.uuid);

    await expect(findD1Database(scope, 'shop-d1-db')).resolves.toBeUndefined();
  });
});
