import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDeploy } from '../../src/deploy/command.ts';
import { runDestroy } from '../../src/deploy/destroy.ts';
import { projectNames } from '../../src/deploy/names.ts';
import { projectLockBucket } from '../../src/deploy/project-lock.ts';
import { OWNER_KEY } from '../../src/deploy/workers/protocol.ts';
import {
  bucketKeys,
  buildIn,
  deployableProject,
  deployOptions,
  type LiveAccount,
  liveAccount,
  ownerMarkOf,
  sorted,
} from './live-account.ts';

/**
 * `upwind destroy` against an account a deploy made things on (`live-account.ts`): what it deletes,
 * in what order, what it leaves, and what it refuses to touch.
 */

// Bundled once for the file, as in the deploy's own suite.
vi.mock(import('../../src/deploy/shipped.ts'), async (importOriginal) => {
  const actual = await importOriginal();
  const held: { workers?: ReturnType<typeof actual.shippedWorkers> } = {};
  return {
    ...actual,
    shippedWorkers: () => {
      held.workers ??= actual.shippedWorkers();
      return held.workers;
    },
  };
});

const PROJECT = 'shop';
const NAMES = projectNames(PROJECT);
const STORAGE = { UPWIND_KV: 'kv', UPWIND_D1: 'd1', UPWIND_R2: 'r2' } as const;

describe('`upwind destroy`', () => {
  let account: LiveAccount;
  let printed: string[];
  let errors: string[];

  beforeEach(async () => {
    account = await liveAccount(PROJECT);
    printed = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => {
      printed.push(text);
    });
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      errors.push(text);
    });
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await account.dispose();
  });

  /** A project with a deployment live on the account. */
  async function deployed(deploy?: unknown): Promise<string> {
    const dir = await deployableProject(PROJECT, deploy);
    buildIn(dir);

    await expect(runDeploy(deployOptions(dir), account.credentials, account.io)).resolves.toBe(0);

    return dir;
  }

  const destroy = (dir: string, options: { yes?: boolean; includeStorage?: boolean } = {}) => {
    return runDestroy(
      {
        projectDir: dir,
        yes: options.yes ?? true,
        includeStorage: options.includeStorage ?? false,
      },
      account.credentials,
      account.io,
    );
  };

  /** Write the owner mark into the project's bucket, as a run stopped part way would leave it. */
  async function rewriteMark(
    edit: (mark: { made: Record<string, string>; pending: string[] }) => void,
  ): Promise<void> {
    const mark = await ownerMarkOf(account);
    if (mark === undefined) {
      throw new Error('the project has no owner mark to rewrite');
    }
    const next = {
      v: 1,
      project: mark.project,
      made: { ...mark.made },
      pending: [...mark.pending],
    };
    edit(next);
    const bucket = await account.stack.mf.getR2Bucket('ARTIFACTS', 'agent');
    await bucket.put(OWNER_KEY, JSON.stringify(next));
  }

  /** What the account holds of the project: its Workers, namespaces, databases and buckets. */
  async function holdings(): Promise<unknown> {
    const { fake } = account;
    return {
      scripts: sorted(fake.scripts.keys()),
      namespaces: sorted([...fake.kv.values()].map((namespace) => namespace.title)),
      databases: sorted([...fake.d1.values()].map((database) => database.name)),
      buckets: sorted(fake.buckets.keys()),
      objects: await bucketKeys(account),
    };
  }

  it('deletes everything a deploy made, the owner mark the last thing in the bucket', async () => {
    const dir = await deployed();
    const { fake } = account;
    const from = fake.requests.length;

    await expect(destroy(dir)).resolves.toBe(0);
    expect(errors).toStrictEqual([]);
    await expect(holdings()).resolves.toStrictEqual({
      scripts: [],
      namespaces: [],
      databases: [],
      buckets: [],
      objects: [],
    });

    const deletions = fake.requests
      .slice(from)
      .filter((request) => request.method === 'DELETE')
      .map((request) => request.path.replace(/^\/accounts\/[^/]+/u, ''));

    // The site goes first, and the mark goes after everything it vouched for but its bucket.
    expect(deletions[0]).toBe(`/workers/scripts/${NAMES.edge}`);
    expect(deletions.slice(-3)).toStrictEqual([
      `/r2/buckets/${NAMES.artifactsBucket}/objects/${OWNER_KEY}`,
      `/r2/buckets/${NAMES.artifactsBucket}`,
      `/r2/buckets/${projectLockBucket(NAMES)}`,
    ]);
  });

  it('finds nothing left to do the second time', async () => {
    const dir = await deployed();

    await expect(destroy(dir)).resolves.toBe(0);

    const { fake } = account;
    const from = fake.requests.length;

    await expect(destroy(dir)).resolves.toBe(0);
    expect(
      fake.requests
        .slice(from)
        .filter((request) => request.method !== 'GET' && request.method !== 'DELETE')
        .map(({ method, path }) => ({ method, path })),
    ).toStrictEqual([{ method: 'POST', path: '/accounts/account-1/r2/buckets' }]);
    expect(sorted(fake.scripts.keys())).toStrictEqual([]);
  });

  it('deletes nothing without --yes', async () => {
    const dir = await deployed();
    const before = await holdings();

    await expect(destroy(dir, { yes: false })).resolves.toBe(1);
    expect(errors.join('\n')).toMatch(/run it with --yes/u);
    await expect(holdings()).resolves.toStrictEqual(before);
  });

  it('deletes nothing of a bucket a deploy did not make', async () => {
    const dir = await deployableProject(PROJECT);
    account.fake.buckets.set(NAMES.artifactsBucket, new Map());
    const bucket = await account.stack.mf.getR2Bucket('ARTIFACTS', 'agent');
    await bucket.put('theirs.txt', 'somebody else');

    await expect(destroy(dir)).resolves.toBe(1);
    expect(errors.join('\n')).toMatch(/was not made by upwind deploy for shop/u);
    expect(account.fake.buckets.has(NAMES.artifactsBucket)).toBe(true);
    await expect(bucketKeys(account)).resolves.toStrictEqual(['theirs.txt']);
  });

  it('deletes nothing where the agent that empties the bucket cannot be reached', async () => {
    const dir = await deployed();
    const before = await holdings();
    account.fake.subdomain = undefined;

    await expect(destroy(dir)).resolves.toBe(1);
    expect(errors.join('\n')).toMatch(/no workers\.dev subdomain/u);
    await expect(holdings()).resolves.toStrictEqual(before);
  });

  it("leaves the application's storage, and the record a deploy takes it up again by", async () => {
    const dir = await deployed({ storage: STORAGE });
    const kept = (await holdings()) as { databases: string[]; buckets: string[] };

    await expect(destroy(dir)).resolves.toBe(0);
    expect(printed.join('\n')).toMatch(/storage is left as it is/u);
    // The bucket holds the mark and nothing else, and every Worker and namespace of its own is gone.
    await expect(holdings()).resolves.toStrictEqual({
      scripts: [],
      namespaces: [`upwind:${PROJECT}:kv:UPWIND_KV`],
      databases: kept.databases,
      buckets: kept.buckets,
      objects: [OWNER_KEY],
    });

    buildIn(dir);

    await expect(runDeploy(deployOptions(dir), account.credentials, account.io)).resolves.toBe(0);
    await expect(holdings()).resolves.toMatchObject({
      databases: kept.databases,
      buckets: kept.buckets,
    });
  });

  it('takes up again a destroy that stopped after the namespaces of its own went', async () => {
    const dir = await deployed({ storage: STORAGE });
    // A database that will not go, the first time: after the namespaces of the project's own did.
    // Refused rather than broken, which a deploy does not ask again.
    account.fake.fail({ method: 'DELETE', path: /\/d1\/database\/[^/]+$/u }, 400);

    await expect(destroy(dir, { includeStorage: true })).rejects.toThrow('injected');
    await expect(holdings()).resolves.toMatchObject({ namespaces: [] });
    await expect(ownerMarkOf(account)).resolves.toMatchObject({
      made: { [NAMES.edgeStateTitle]: expect.any(String) as unknown },
    });

    // An upload that binds what the account no longer holds is refused, as Cloudflare refuses it:
    // the agent that empties the bucket again binds none of what went.
    account.fake.checkBindings = true;

    await expect(destroy(dir, { includeStorage: true })).resolves.toBe(0);
    await expect(holdings()).resolves.toStrictEqual({
      scripts: [],
      namespaces: [],
      databases: [],
      buckets: [],
      objects: [],
    });
  });

  it('deletes the stores a stopped deploy made and never recorded', async () => {
    const dir = await deployed({ storage: STORAGE });
    // As a deploy that stopped after making them, before writing down what each was made as.
    await rewriteMark((mark) => {
      for (const name of [NAMES.edgeStateTitle, 'kv:UPWIND_KV']) {
        Reflect.deleteProperty(mark.made, name);
        mark.pending.push(name);
      }
    });

    await expect(destroy(dir, { includeStorage: true })).resolves.toBe(0);
    await expect(holdings()).resolves.toStrictEqual({
      scripts: [],
      namespaces: [],
      databases: [],
      buckets: [],
      objects: [],
    });
  });

  it('keeps in its record the stores a stopped deploy made, where it leaves them', async () => {
    const dir = await deployed({ storage: STORAGE });
    let kv: string | undefined;
    for (const namespace of account.fake.kv.values()) {
      if (namespace.title === `upwind:${PROJECT}:kv:UPWIND_KV`) {
        kv = namespace.id;
      }
    }
    await rewriteMark((mark) => {
      Reflect.deleteProperty(mark.made, 'kv:UPWIND_KV');
      mark.pending.push('kv:UPWIND_KV');
    });

    await expect(destroy(dir)).resolves.toBe(0);
    await expect(ownerMarkOf(account)).resolves.toMatchObject({
      made: { 'kv:UPWIND_KV': kv },
      pending: [],
    });
    await expect(holdings()).resolves.toMatchObject({
      namespaces: [`upwind:${PROJECT}:kv:UPWIND_KV`],
    });
  });

  it('writes the owner mark back where the bucket could not be deleted after it', async () => {
    const dir = await deployed();
    account.fake.fail({ method: 'DELETE', path: `/r2/buckets/${NAMES.artifactsBucket}` }, 400);

    await expect(destroy(dir)).rejects.toThrow('injected');
    expect(account.fake.buckets.has(NAMES.artifactsBucket)).toBe(true);
    await expect(ownerMarkOf(account)).resolves.toMatchObject({ project: PROJECT });

    await expect(destroy(dir)).resolves.toBe(0);
    await expect(holdings()).resolves.toStrictEqual({
      scripts: [],
      namespaces: [],
      databases: [],
      buckets: [],
      objects: [],
    });
  });

  it("deletes the application's storage with --include-storage", async () => {
    const dir = await deployed({ storage: STORAGE });

    await expect(destroy(dir, { includeStorage: true })).resolves.toBe(0);
    await expect(holdings()).resolves.toStrictEqual({
      scripts: [],
      namespaces: [],
      databases: [],
      buckets: [],
      objects: [],
    });
    expect(printed.join('\n')).not.toMatch(/storage is left/u);
  });
});
