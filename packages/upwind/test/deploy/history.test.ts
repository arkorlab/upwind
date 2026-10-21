import { describe, expect, it } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { readHistory } from '../../src/deploy/history.ts';
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
});
