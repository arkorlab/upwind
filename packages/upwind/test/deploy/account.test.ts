import { describe, expect, it } from 'vitest';

import { OWNER_KEY, readAccount, resolveAccount } from '../../src/deploy/account.ts';
import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { projectNames } from '../../src/deploy/names.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';

function scopeOf(fake: ReturnType<typeof fakeCloudflare>) {
  return {
    client: createCloudflareClient({ apiToken: 'token', fetch: fake.fetch }),
    accountId: 'account-1',
  };
}

const NAMES = projectNames('shop');

function mark(project: string, made: Record<string, string> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: 1, project, made }));
}

describe('reading the account', () => {
  it('finds the only account the token reaches, and refuses to guess between several', async () => {
    const fake = fakeCloudflare();
    const { client } = scopeOf(fake);

    await expect(resolveAccount(client, undefined)).resolves.toBe('account-1');
    await expect(resolveAccount(client, 'named')).resolves.toBe('named');

    fake.accounts.push({ id: 'account-2', name: 'Another' });

    await expect(resolveAccount(client, undefined)).rejects.toThrow(/reaches 2 accounts/u);
  });

  it('sees an account the project was never deployed to', async () => {
    const fake = fakeCloudflare();
    fake.scripts.set('unrelated', {
      name: 'unrelated',
      versions: [],
      deployments: [],
      subdomain: { enabled: true, previews_enabled: true },
      migrationTag: undefined,
      secrets: new Map(),
    });
    const view = await readAccount(scopeOf(fake), NAMES);

    expect(view).toMatchObject({
      subdomain: 'example',
      workers: 1,
      projectWorkers: [],
      bucket: undefined,
      live: undefined,
      problems: [],
    });
  });

  it("refuses a bucket of the project's name that the deploy did not make for it", async () => {
    const fake = fakeCloudflare();
    fake.buckets.set(NAMES.artifactsBucket, new Map());

    expect((await readAccount(scopeOf(fake), NAMES)).problems).toStrictEqual([
      expect.stringMatching(/was not made by upwind deploy for shop/u),
    ]);

    fake.buckets.set(
      NAMES.artifactsBucket,
      new Map([[OWNER_KEY, { bytes: mark('other'), contentType: 'application/json' }]]),
    );

    expect((await readAccount(scopeOf(fake), NAMES)).problems).toHaveLength(1);
  });

  it('accepts what it made, and refuses a namespace of its title that it did not', async () => {
    const fake = fakeCloudflare();
    fake.kv.set('kv-mine', { id: 'kv-mine', title: NAMES.edgeStateTitle });
    fake.kv.set('kv-theirs', { id: 'kv-theirs', title: NAMES.cacheStateTitle });
    fake.buckets.set(
      NAMES.artifactsBucket,
      new Map([
        [
          OWNER_KEY,
          {
            bytes: mark('shop', { [NAMES.edgeStateTitle]: 'kv-mine' }),
            contentType: 'application/json',
          },
        ],
      ]),
    );
    const view = await readAccount(scopeOf(fake), NAMES);

    expect(view.owner?.project).toBe('shop');
    expect(view.problems).toStrictEqual([
      expect.stringMatching(/KV namespace upwind:shop:cache-state is already on the account/u),
    ]);
  });
});
