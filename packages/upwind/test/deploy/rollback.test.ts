import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRollback } from '../../src/deploy/rollback.ts';
import { ownVersion } from '../../src/manifest.ts';
import { fakeEdge, NAMES } from './edge-history.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';
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
    // An account of an edge and Functions alone, with no bucket to stage again from: each
    // deployment is switched to as its version stands, and the run says so.
    vi.spyOn(console, 'warn').mockImplementation(() => {
      // Said, and not what these tests are about (`rollback-flow.test.ts` is).
    });
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      errors.push(text);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives the edge back to the deployment before the live one, once it answers as itself', async () => {
    const { edge, second } = threeDeployed();

    await expect(
      runRollback({ projectDir: await project(), to: undefined }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(0);
    expect(edge.script.deployments[0]?.versions).toStrictEqual([
      { version_id: second.versionId, percentage: 100 },
    ]);
    // Checked first, at none of the traffic, beside the version that had all of it.
    expect(edge.script.deployments[1]?.versions).toContainEqual({
      version_id: second.versionId,
      percentage: 0,
    });
    expect(printed).toContainEqual(
      `upwind: ${second.deploymentId} is live at https://shop-edge.example.workers.dev/`,
    );
  });

  it('goes further back with each rollback, never forward to the one it went back from', async () => {
    const { edge, first, second } = threeDeployed();
    // A rollback to the second, as one that publishes it again leaves the edge: its newest version
    // is the second's, and serves.
    const again = edge.redeploy(second);
    edge.serve([{ versionId: again.versionId, percentage: 100 }]);

    await expect(
      runRollback({ projectDir: await project(), to: undefined }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(0);
    expect(edge.script.deployments[0]?.versions).toStrictEqual([
      { version_id: first.versionId, percentage: 100 },
    ]);
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

    await expect(
      runRollback({ projectDir: await project(), to: undefined }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(0);
    expect(edge.script.deployments[0]?.versions).toStrictEqual([
      { version_id: first.versionId, percentage: 100 },
    ]);
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

    await expect(
      runRollback({ projectDir: await project(), to: undefined }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(0);
    // The first, live before the fourth — not the second, which was gone back from.
    expect(edge.script.deployments[0]?.versions).toStrictEqual([
      { version_id: again.versionId, percentage: 100 },
    ]);
  });

  it('goes back to the deployment named, and to none whose Functions are gone', async () => {
    const { fake, edge, first, second } = threeDeployed();
    const dir = await project();

    await expect(
      runRollback({ projectDir: dir, to: first.deploymentId }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(0);
    expect(edge.script.deployments[0]?.versions).toStrictEqual([
      { version_id: first.versionId, percentage: 100 },
    ]);

    fake.scripts.delete(second.scriptName);

    await expect(
      runRollback({ projectDir: dir, to: second.deploymentId }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(1);
    expect(errors).toStrictEqual([
      `upwind: ${second.deploymentId}'s Functions are no longer on the account`,
    ]);
  });

  it('keeps the live deployment where the one before it fails its checks', async () => {
    const { edge, second, third } = threeDeployed();
    const failing = edge.fetch(new Set([second.deploymentId]));

    await expect(
      runRollback({ projectDir: await project(), to: undefined }, CREDENTIALS, {
        fetch: failing,
        ...clock(),
      }),
    ).resolves.toBe(1);
    expect(edge.script.deployments[0]?.versions).toStrictEqual([
      { version_id: third.versionId, percentage: 100 },
    ]);
    expect(errors).toContainEqual('  - / was answered with 500');
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
    const dir = await project();

    await expect(
      runRollback({ projectDir: dir, to: old.deploymentId }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(1);
    expect(errors).toStrictEqual([
      expect.stringMatching(/older than the 100 a deployment of the edge can choose from/u),
    ]);
    await expect(
      runRollback({ projectDir: dir, to: undefined }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(1);
    expect(errors).toContainEqual(
      'upwind: no deployment before the live one can be rolled back to',
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
    const dir = await project();

    await expect(
      runRollback({ projectDir: dir, to: undefined }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(1);
    expect(errors).toStrictEqual([
      `upwind: shop-edge's live version ${untagged} is not one upwind deploy made, so which deployment came before it is not known; name one with --to`,
    ]);
    await expect(
      runRollback({ projectDir: dir, to: first.deploymentId }, CREDENTIALS, {
        fetch: edge.fetch(),
        ...clock(),
      }),
    ).resolves.toBe(0);
    expect(edge.script.deployments[0]?.versions).toStrictEqual([
      { version_id: first.versionId, percentage: 100 },
    ]);
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
