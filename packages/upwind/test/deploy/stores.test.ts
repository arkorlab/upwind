import { describe, expect, it } from 'vitest';

import { OWNER_KEY, readAccount } from '../../src/deploy/account.ts';
import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import type { AccountScope } from '../../src/deploy/cloudflare/workers.ts';
import type { StorageBinding } from '../../src/deploy/config.ts';
import { projectNames } from '../../src/deploy/names.ts';
import { ensureStores, storageName } from '../../src/deploy/stores.ts';
import { type FakeCloudflare, fakeCloudflare } from './fake-cloudflare.ts';

const NAMES = projectNames('shop');
const STORAGE: readonly StorageBinding[] = [
  { name: 'DB', kind: 'd1' },
  { name: 'SESSIONS', kind: 'kv' },
  { name: 'FILES', kind: 'r2' },
];

/** What a run wrote and made, in the order it did: each owner mark it wrote, and each creation. */
type Step =
  | { readonly mark: { readonly made: Record<string, string>; readonly pending: string[] } }
  | { readonly made: string };

/**
 * What another run does on the account while this one runs, as a request of this run's reaches the
 * fake: told the request's method, its path under the account and its body, before the fake answers
 * it and after.
 */
interface Meddler {
  readonly before?: (method: string, path: string, body: unknown) => void;
  readonly after?: (method: string, path: string, body: unknown) => void;
}

/** A request's body, as the JSON it is; nothing for a body that is not. */
async function bodyOf(request: Request): Promise<unknown> {
  try {
    return (await request.clone().json()) as unknown;
  } catch {
    return undefined;
  }
}

/** The account, reached through the fake, with every write of the owner mark and every creation logged. */
function accountOf(
  fake: FakeCloudflare,
  meddler: Meddler = {},
): {
  readonly scope: AccountScope;
  readonly steps: Step[];
} {
  const steps: Step[] = [];
  const logged: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace(/^.*\/accounts\/[^/]+/u, '');
    const body = await bodyOf(request);
    if (request.method === 'PUT' && path.endsWith(`/objects/${OWNER_KEY}`)) {
      steps.push({ mark: body as Extract<Step, { mark: unknown }>['mark'] });
    } else if (request.method === 'POST') {
      steps.push({ made: path });
    }
    meddler.before?.(request.method, path, body);
    try {
      return await fake.fetch(request);
    } finally {
      meddler.after?.(request.method, path, body);
    }
  };
  const client = createCloudflareClient({
    apiToken: 'token',
    fetch: logged,
    sleep: () => Promise.resolve(),
  });
  return { scope: { client, accountId: 'account-1' }, steps };
}

function markIn(fake: FakeCloudflare): unknown {
  const object = fake.buckets.get(NAMES.artifactsBucket)?.get(OWNER_KEY);
  return object === undefined ? undefined : JSON.parse(new TextDecoder().decode(object.bytes));
}

async function ensure(
  fake: FakeCloudflare,
  storage: readonly StorageBinding[] = STORAGE,
  meddler: Meddler = {},
): Promise<Awaited<ReturnType<typeof ensureStores>> & { readonly steps: Step[] }> {
  const { scope, steps } = accountOf(fake, meddler);
  const account = await readAccount(scope, NAMES);
  const stores = await ensureStores({ scope, names: NAMES, account, storage });
  return { ...stores, steps };
}

function titled(fake: FakeCloudflare, title: string): string | undefined {
  for (const namespace of fake.kv.values()) {
    if (namespace.title === title) {
      return namespace.id;
    }
  }
  return undefined;
}

function databaseNamed(fake: FakeCloudflare, name: string): string | undefined {
  for (const database of fake.d1.values()) {
    if (database.name === name) {
      return database.uuid;
    }
  }
  return undefined;
}

describe("a project's stores", () => {
  it('makes the bucket, marks what it is about to make, and records each store it made', async () => {
    const fake = fakeCloudflare();
    const stores = await ensure(fake);

    const database = databaseNamed(fake, 'shop-d1-db');

    expect(stores).toMatchObject({
      edgeState: titled(fake, NAMES.edgeStateTitle),
      cacheState: titled(fake, NAMES.cacheStateTitle),
      bucket: NAMES.artifactsBucket,
      storage: [
        { binding: 'DB', kind: 'd1', id: database },
        { binding: 'SESSIONS', kind: 'kv', id: titled(fake, 'upwind:shop:kv:SESSIONS') },
        { binding: 'FILES', kind: 'r2', id: 'shop-r2-files' },
      ],
    });
    expect(fake.buckets.has('shop-r2-files')).toBe(true);

    const [bucket, mark, ...rest] = stores.steps;

    // The bucket first, then the mark saying what is about to be made, then each store.
    expect(bucket).toStrictEqual({ made: '/r2/buckets' });
    expect(mark).toStrictEqual({
      mark: expect.objectContaining({
        made: {},
        pending: [NAMES.edgeStateTitle, NAMES.cacheStateTitle, 'd1:DB', 'kv:SESSIONS', 'r2:FILES'],
      }) as unknown,
    });
    expect(rest.filter((step) => 'made' in step)).toHaveLength(5);
    expect(markIn(fake)).toStrictEqual({
      v: 1,
      project: 'shop',
      made: {
        [NAMES.edgeStateTitle]: stores.edgeState,
        [NAMES.cacheStateTitle]: stores.cacheState,
        'd1:DB': database,
        'kv:SESSIONS': titled(fake, 'upwind:shop:kv:SESSIONS'),
        'r2:FILES': 'shop-r2-files',
      },
      pending: [],
    });
  });

  it('makes and writes nothing on a run after that', async () => {
    const fake = fakeCloudflare();
    const first = await ensure(fake);
    const second = await ensure(fake);

    expect(second.steps).toStrictEqual([]);
    expect({ ...second, steps: [] }).toStrictEqual({ ...first, steps: [] });
  });

  it('takes up a store a stopped run made, which the mark says it was about to make', async () => {
    const fake = fakeCloudflare();
    const stopped = { v: 1, project: 'shop', made: {}, pending: [NAMES.edgeStateTitle] };
    const bytes = new TextEncoder().encode(JSON.stringify(stopped));
    fake.buckets.set(
      NAMES.artifactsBucket,
      new Map([[OWNER_KEY, { bytes, contentType: 'application/json' }]]),
    );
    fake.kv.set('kv-stopped', { id: 'kv-stopped', title: NAMES.edgeStateTitle });
    const stores = await ensure(fake, []);

    expect(stores.edgeState).toBe('kv-stopped');
    expect(markIn(fake)).toMatchObject({
      made: { [NAMES.edgeStateTitle]: 'kv-stopped', [NAMES.cacheStateTitle]: stores.cacheState },
      pending: [],
    });
  });

  it("refuses a store of the project's name it did not make, and marks nothing of it", async () => {
    const fake = fakeCloudflare();
    await ensure(fake, []);
    const before = markIn(fake);
    fake.d1.set('d1-theirs', { uuid: 'd1-theirs', name: 'shop-d1-db' });

    await expect(ensure(fake, [{ name: 'DB', kind: 'd1' }])).rejects.toThrow(
      "shop-d1-db is on the account, and was not made for shop's DB",
    );
    // Not marked as about to be made, either: a later run refuses it as well.
    expect(markIn(fake)).toStrictEqual(before);
    await expect(ensure(fake, [{ name: 'DB', kind: 'd1' }])).rejects.toThrow('was not made');

    fake.kv.set('kv-theirs', { id: 'kv-theirs', title: 'upwind:shop:kv:SESSIONS' });

    await expect(ensure(fake, [{ name: 'SESSIONS', kind: 'kv' }])).rejects.toThrow(
      "upwind:shop:kv:SESSIONS is on the account, and was not made for shop's SESSIONS",
    );

    fake.buckets.set('shop-r2-files', new Map());

    await expect(ensure(fake, [{ name: 'FILES', kind: 'r2' }])).rejects.toThrow(
      "shop-r2-files is on the account, and was not made for shop's FILES",
    );
  });

  it('refuses a store it did not make before it makes anything, the bucket included', async () => {
    const fake = fakeCloudflare();
    fake.d1.set('d1-theirs', { uuid: 'd1-theirs', name: 'shop-d1-db' });

    await expect(ensure(fake, [{ name: 'DB', kind: 'd1' }])).rejects.toThrow(
      "shop-d1-db is on the account, and was not made for shop's DB",
    );
    expect(fake.buckets.has(NAMES.artifactsBucket)).toBe(false);
    expect(fake.requests.filter((request) => request.method !== 'GET')).toStrictEqual([]);
  });

  it('marks the bucket as it makes it, so a run stopped after that leaves nothing refused', async () => {
    const fake = fakeCloudflare();
    fake.fail({ method: 'POST', path: /\/storage\/kv\/namespaces$/u }, 500);

    await expect(ensure(fake, [])).rejects.toThrow('injected');
    expect(markIn(fake)).toStrictEqual({
      v: 1,
      project: 'shop',
      made: {},
      pending: [NAMES.edgeStateTitle, NAMES.cacheStateTitle],
    });

    const stores = await ensure(fake, []);

    expect(stores.edgeState).toBe(titled(fake, NAMES.edgeStateTitle));
    expect(markIn(fake)).toMatchObject({ pending: [] });
  });

  it('refuses a bucket of its name with no mark in it, and says how to clear one', async () => {
    const fake = fakeCloudflare();
    fake.buckets.set(NAMES.artifactsBucket, new Map());

    await expect(ensure(fake, [])).rejects.toThrow(
      'it holds no owner mark. If a deploy of shop stopped as it made the bucket, the bucket holds nothing; delete it, and run again',
    );
    expect(fake.kv.size).toBe(0);
    expect(markIn(fake)).toBeUndefined();
  });

  it('stops where another run makes a store as this one goes to make it', async () => {
    const fake = fakeCloudflare();
    const meddler: Meddler = {
      before: (method, path, body) => {
        const title = (body as { readonly title?: string } | undefined)?.title;
        if (method === 'POST' && path === '/storage/kv/namespaces' && title !== undefined) {
          fake.kv.set('kv-theirs', { id: 'kv-theirs', title });
        }
      },
    };

    await expect(ensure(fake, [], meddler)).rejects.toThrow(
      `${NAMES.edgeStateTitle} was made by another run as this one went to make it: another deploy of shop is making its stores, and a project is deployed by one run at a time`,
    );
  });

  it('stops where another run made a namespace of the title beside the one this run made', async () => {
    const fake = fakeCloudflare();
    const meddler: Meddler = {
      after: (method, path, body) => {
        const title = (body as { readonly title?: string } | undefined)?.title;
        if (method === 'POST' && path === '/storage/kv/namespaces' && title !== undefined) {
          // Beside this run's: two of one title, as two runs at once could leave them.
          fake.kv.set('kv-theirs', { id: 'kv-theirs', title });
        }
      },
    };

    await expect(ensure(fake, [], meddler)).rejects.toThrow(
      `the account now has 2 KV namespaces titled ${NAMES.edgeStateTitle}`,
    );

    // The mark records this run's, which says which of the two is the other run's.
    const titles = new Map<string, string>();
    for (const namespace of fake.kv.values()) {
      titles.set(namespace.id, namespace.title);
    }
    titles.delete('kv-theirs');
    const mine = [...titles].find(([, title]) => title === NAMES.edgeStateTitle);

    expect(markIn(fake)).toMatchObject({ made: { [NAMES.edgeStateTitle]: mine?.[0] } });
  });

  it('stops where another run makes a database or the bucket as this one goes to', async () => {
    const fake = fakeCloudflare();
    const theirs: Meddler = {
      before: (method, path, body) => {
        const name = (body as { readonly name?: string } | undefined)?.name;
        if (method === 'POST' && path === '/d1/database' && name !== undefined) {
          fake.d1.set('d1-theirs', { uuid: 'd1-theirs', name });
        }
        if (method === 'POST' && path === '/r2/buckets' && name === NAMES.artifactsBucket) {
          fake.buckets.set(name, new Map());
        }
      },
    };

    await expect(ensure(fake, [], theirs)).rejects.toThrow(
      `${NAMES.artifactsBucket} was made by another run as this one went to make it`,
    );

    const later = fakeCloudflare();
    await ensure(later, []);
    const meddled: Meddler = {
      before: (method, path, body) => {
        const name = (body as { readonly name?: string } | undefined)?.name;
        if (method === 'POST' && path === '/d1/database' && name !== undefined) {
          later.d1.set('d1-theirs', { uuid: 'd1-theirs', name });
        }
      },
    };

    await expect(ensure(later, [{ name: 'DB', kind: 'd1' }], meddled)).rejects.toThrow(
      'shop-d1-db was made by another run as this one went to make it',
    );
  });

  it('refuses two bindings that would be one store, before making anything', async () => {
    const fake = fakeCloudflare();

    await expect(
      ensure(fake, [
        { name: 'MY_DB', kind: 'd1' },
        { name: 'my_db', kind: 'd1' },
      ]),
    ).rejects.toThrow("deploy.storage's MY_DB and my_db would both be shop-d1-my-db");
    expect(fake.requests.filter((request) => request.method === 'POST')).toStrictEqual([]);
  });
});

describe("an application's store's name", () => {
  it('is a title of the project for a namespace, and a name of its own for the rest', () => {
    expect(storageName('shop', { name: 'SESSIONS', kind: 'kv' })).toBe('upwind:shop:kv:SESSIONS');
    expect(storageName('shop', { name: 'MY_DB', kind: 'd1' })).toBe('shop-d1-my-db');
    expect(storageName('shop', { name: 'Files2', kind: 'r2' })).toBe('shop-r2-files2');
    expect(storageName('shop', { name: '__', kind: 'r2' })).toBe('shop-r2-store');
  });

  it('is cut to 63 characters where it would be longer, and keeps a digest of the binding', () => {
    const long = { name: `UPLOADS_${'X'.repeat(80)}`, kind: 'r2' } as const;
    const other = { name: `UPLOADS_${'X'.repeat(81)}`, kind: 'r2' } as const;
    const name = storageName('a-project-of-24-letters', long);

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(/^a-project-of-24-letters-r2-uploads-x+-[\da-f]{8}$/u);
    expect(name).not.toContain('--');
    expect(storageName('a-project-of-24-letters', other)).not.toBe(name);
  });
});
