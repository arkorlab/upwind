import { describe, expect, it } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { type DeploymentRecord, readHistory, wayBackOrder } from '../../src/deploy/history.ts';
import { type Deployed, fakeEdge, NAMES } from './edge-history.ts';
import { type FakeCloudflare, fakeCloudflare } from './fake-cloudflare.ts';

function scopeOf(fake: FakeCloudflare) {
  return {
    client: createCloudflareClient({ apiToken: 'token', fetch: fake.fetch }),
    accountId: 'account-1',
  };
}

/** The deployment uploaded again: a newer version of the edge for it, beside the one it had. */
function uploadedAgain(fake: FakeCloudflare, deployed: Deployed): string {
  const edge = fake.scripts.get(NAMES.edge);
  if (edge === undefined) {
    throw new Error('the account has no edge');
  }
  const id = `${deployed.versionId}-again`;
  edge.versions.unshift({
    id,
    number: edge.versions.length + 1,
    metadata: { bindings: [] },
    modules: ['index.mjs'],
    annotations: { 'workers/tag': `${deployed.deploymentId}:again` },
  });
  return id;
}

describe("the edge's history", () => {
  it('stands for a deployment by a version that served it, over a newer one that never did', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const first = edge.deploy();
    edge.serve([{ versionId: first.versionId, percentage: 100 }]);
    const second = edge.deploy();
    edge.serve([{ versionId: second.versionId, percentage: 100 }]);
    // Deployed again, and failing its checks: its new version never had any of the traffic.
    uploadedAgain(fake, first);

    const history = await readHistory(scopeOf(fake), NAMES);

    expect(
      history.deployments.find((record) => record.deploymentId === first.deploymentId)?.versionId,
    ).toBe(first.versionId);
  });

  it('stands for one by its newest version where none of them served', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const first = edge.deploy();
    const live = edge.deploy();
    edge.serve([{ versionId: live.versionId, percentage: 100 }]);
    const again = uploadedAgain(fake, first);

    const history = await readHistory(scopeOf(fake), NAMES);

    expect(
      history.deployments.find((record) => record.deploymentId === first.deploymentId)?.versionId,
    ).toBe(again);
  });

  it('stands for one by the version the edge gives traffic to, over one it holds at none', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const first = edge.deploy();
    edge.serve([{ versionId: first.versionId, percentage: 100 }]);
    const again = uploadedAgain(fake, first);
    // Held at none beside the version that served, as a run checking it leaves it.
    edge.serve([
      { versionId: first.versionId, percentage: 100 },
      { versionId: again, percentage: 0 },
    ]);

    const history = await readHistory(scopeOf(fake), NAMES);
    const record = history.deployments.find(
      (candidate) => candidate.deploymentId === first.deploymentId,
    );

    expect(record?.versionId).toBe(first.versionId);
    expect(record?.share).toBe(100);
  });

  it('orders deployments by when each was first deployed, whatever versions came since', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const first = edge.deploy();
    const second = edge.deploy();
    const third = edge.deploy();
    edge.serve([{ versionId: third.versionId, percentage: 100 }]);
    // The first published again, as a rollback to it does: the edge's newest version is its.
    const again = edge.redeploy(first);
    edge.serve([{ versionId: again.versionId, percentage: 100 }]);

    const history = await readHistory(scopeOf(fake), NAMES);

    expect(history.deployments.map((record) => record.deploymentId)).toStrictEqual([
      third.deploymentId,
      second.deploymentId,
      first.deploymentId,
    ]);
    // How many of the edge's deployments ago each last had traffic; the second never did.
    expect(history.deployments.map((record) => record.lastServed)).toStrictEqual([1, undefined, 0]);
  });

  it('goes back to the deployment served most recently, then to the newest deployed', () => {
    const record = (
      deploymentId: string,
      firstDeployed: number,
      lastServed: number | undefined,
    ): DeploymentRecord => {
      return {
        deploymentId,
        versionId: `version-${deploymentId}`,
        number: firstDeployed,
        message: undefined,
        reachable: true,
        share: undefined,
        firstDeployed,
        lastServed,
      };
    };
    const ordered = [
      record('never-served', 3, undefined),
      record('served-before', 2, 4),
      record('served-last', 1, 1),
      record('newest-never-served', 4, undefined),
    ].toSorted(wayBackOrder);

    expect(ordered.map((one) => one.deploymentId)).toStrictEqual([
      'served-last',
      'served-before',
      'newest-never-served',
      'never-served',
    ]);
  });
});
