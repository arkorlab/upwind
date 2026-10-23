import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { readHistory } from '../../src/deploy/history.ts';
import { chooseTarget, runRollback } from '../../src/deploy/rollback.ts';
import { ownVersion } from '../../src/manifest.ts';
import { type Deployed, fakeEdge, NAMES, uploadVersion } from './edge-history.ts';
import { type FakeCloudflare, fakeCloudflare } from './fake-cloudflare.ts';
import { projectWith } from './project.ts';

const CREDENTIALS = { apiToken: 'token', accountId: undefined };
const DEPLOYABLE = 100;

/** Waits that take no time, on a clock that moves a second each time it is read. */
function clock(): { readonly sleep: () => Promise<void>; readonly now: () => number } {
  let at = 0;
  return {
    sleep: () => Promise.resolve(),
    now: () => {
      at += 1000;
      return at;
    },
  };
}

async function project(): Promise<string> {
  return projectWith({ adapterVersion: await ownVersion(), packageName: NAMES.project });
}

/** Where a rollback would go on this account, by its edge's history: the deployment, or why none. */
async function chosen(fake: FakeCloudflare, to?: string): Promise<string> {
  const scope = {
    client: createCloudflareClient({ apiToken: 'token', fetch: fake.fetch }),
    accountId: 'account-1',
  };
  const choice = await chooseTarget(scope, NAMES, await readHistory(scope, NAMES), to);
  return typeof choice === 'string' ? choice : choice.found.target.deploymentId;
}

/** Three deployments, the newest live. */
function threeDeployed() {
  const fake = fakeCloudflare();
  const edge = fakeEdge(fake);
  const first = edge.deploy();
  const second = edge.deploy();
  const third = edge.deploy();
  edge.serve([{ versionId: third.versionId, percentage: 100 }]);
  return { fake, edge, first, second, third };
}

describe('`upwind rollback`', () => {
  let printed: string[];
  let errors: string[];

  beforeEach(() => {
    printed = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => {
      printed.push(text);
    });
    // An account of an edge and Functions alone, with no bucket to publish a deployment again
    // from: which deployment a rollback goes to is asked of its history (`chosen`), and a run is
    // refused before it changes anything. Going back on an account that has one is
    // `rollback-flow.test.ts`'s.
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // Nothing a run here gets far enough to warn of.
    });
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      errors.push(text);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('goes back to the deployment before the live one', async () => {
    const { fake, second } = threeDeployed();

    await expect(chosen(fake)).resolves.toBe(second.deploymentId);
  });

  it('refuses where the account keeps no bucket to publish the deployment again from', async () => {
    const { edge, third } = threeDeployed();

    await expect(
      runRollback({ projectDir: await project(), to: undefined }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(1);
    // Nothing switched: its own version as it stands would serve none of the live one's files, and
    // nothing would have asked whether its cache scope still answers.
    expect(edge.script.deployments[0]?.versions).toStrictEqual([
      { version_id: third.versionId, percentage: 100 },
    ]);
    expect(errors).toStrictEqual([
      expect.stringContaining('shop-artifacts is not on the account, and a rollback publishes'),
    ]);
    expect(printed).toStrictEqual([]);
  });

  it('goes further back with each rollback, never forward to the one it went back from', async () => {
    const { fake, edge, first, second } = threeDeployed();
    // A rollback to the second, as one that publishes it again leaves the edge: its newest version
    // is the second's, and serves.
    const again = edge.redeploy(second);
    edge.serve([{ versionId: again.versionId, percentage: 100 }]);

    await expect(chosen(fake)).resolves.toBe(first.deploymentId);
  });

  it('goes back to the deployment that was live before, over a newer one that never was', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const first = edge.deploy();
    edge.serve([{ versionId: first.versionId, percentage: 100 }]);
    // Deployed, and failing its checks: never given any of the traffic.
    edge.deploy();
    const third = edge.deploy();
    edge.serve([{ versionId: third.versionId, percentage: 100 }]);

    await expect(chosen(fake)).resolves.toBe(first.deploymentId);
  });

  it('goes back from a deployment made after a rollback to the one rolled back to', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const first = edge.deploy();
    edge.serve([{ versionId: first.versionId, percentage: 100 }]);
    const second = edge.deploy();
    edge.serve([{ versionId: second.versionId, percentage: 100 }]);
    // Gone back from the second to the first, published again; then a fourth deployed.
    const again = edge.redeploy(first);
    edge.serve([{ versionId: again.versionId, percentage: 100 }]);
    const fourth = edge.deploy();
    edge.serve([{ versionId: fourth.versionId, percentage: 100 }]);

    // The first, live before the fourth — not the second, which was gone back from.
    await expect(chosen(fake)).resolves.toBe(first.deploymentId);
    expect(again.deploymentId).toBe(first.deploymentId);
  });

  it('goes back to the deployment named, and to none whose Functions are gone', async () => {
    const { fake, edge, first, second } = threeDeployed();

    await expect(chosen(fake, first.deploymentId)).resolves.toBe(first.deploymentId);

    fake.scripts.delete(second.scriptName);

    await expect(chosen(fake, second.deploymentId)).resolves.toBe(
      `${second.deploymentId}'s Functions are no longer on the account`,
    );
    await expect(
      runRollback({ projectDir: await project(), to: second.deploymentId }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(1);
    expect(errors).toStrictEqual([
      `upwind: ${second.deploymentId}'s Functions are no longer on the account`,
    ]);
  });

  it('passes over a deployment made before the cache key was reset, and refuses it named', async () => {
    const { fake, first, second, third } = threeDeployed();
    // The cache's key was reset as the third was deployed. The first's build was deployed again
    // since, its Function uploaded after the key; the second's was not.
    const cache = (key: string, createdOn: string) => {
      uploadVersion(fake, NAMES.cache, {
        tag: `upwind:infra:0000000000000000:key-${key}`,
        createdOn,
      });
    };
    const upload = (deployed: Deployed, createdOn: string) => {
      uploadVersion(fake, deployed.scriptName, { tag: deployed.deploymentId, createdOn });
    };
    cache('before', '2026-10-01T00:00:00.000Z');
    upload(first, '2026-10-02T00:00:00.000Z');
    upload(second, '2026-10-03T00:00:00.000Z');
    cache('reset', '2026-10-04T00:00:00.000Z');
    upload(first, '2026-10-05T00:00:00.000Z');
    // The cache's code changed since, its key kept: the key is as old as its first version with it.
    cache('reset', '2026-10-06T00:00:00.000Z');
    upload(third, '2026-10-07T00:00:00.000Z');

    await expect(chosen(fake)).resolves.toBe(first.deploymentId);
    await expect(chosen(fake, second.deploymentId)).resolves.toBe(
      `${second.deploymentId} was deployed before shop-cache's key was reset, and its Functions hold a token the cache no longer takes, so it cannot be gone back to; deploy its build again instead`,
    );
  });

  it('refuses a deployment no version of the edge a deployment can choose serves', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const old = edge.deploy();
    for (let index = 0; index < DEPLOYABLE; index += 1) {
      edge.upload();
    }
    const live = edge.deploy();
    edge.serve([{ versionId: live.versionId, percentage: 100 }]);

    await expect(chosen(fake, old.deploymentId)).resolves.toMatch(
      /older than the 100 a deployment of the edge can choose from/u,
    );
    await expect(chosen(fake)).resolves.toBe(
      'no deployment before the live one can be rolled back to',
    );
  });

  it('names no deployment before a live version no deploy made, and goes to one named', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const first = edge.deploy();
    // A version of the edge some other upload made, which says nothing of what came before it.
    edge.upload();
    const untagged = edge.script.versions[0]?.id ?? '';
    edge.serve([{ versionId: untagged, percentage: 100 }]);

    await expect(chosen(fake)).resolves.toBe(
      `shop-edge's live version ${untagged} is not one upwind deploy made, so which deployment came before it is not known; name one with --to`,
    );
    await expect(chosen(fake, first.deploymentId)).resolves.toBe(first.deploymentId);
  });

  it('has nothing to go back to before a first deploy, nor to the live one', async () => {
    const fake = fakeCloudflare();
    const dir = await project();

    await expect(runRollback({ projectDir: dir, to: undefined }, CREDENTIALS, fake)).resolves.toBe(
      1,
    );
    expect(errors).toStrictEqual([
      'upwind: shop-edge serves no deployment, so there is nothing to roll back',
    ]);

    const edge = fakeEdge(fake);
    const live = edge.deploy();
    edge.serve([{ versionId: live.versionId, percentage: 100 }]);

    await expect(
      runRollback({ projectDir: dir, to: live.deploymentId }, CREDENTIALS, {
        fetch: edge.fetch(),
      }),
    ).resolves.toBe(1);
    expect(errors).toContainEqual(`upwind: ${live.deploymentId} is the deployment the edge serves`);
  });
});
