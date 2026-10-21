import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runDeployments } from '../../src/deploy/deployments.ts';
import { ownVersion } from '../../src/manifest.ts';
import { fakeEdge, NAMES } from './edge-history.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';
import { projectWith } from './project.ts';

const CREDENTIALS = { apiToken: 'token', accountId: undefined };
/** How many versions a deployment of the edge can choose among. */
const DEPLOYABLE = 100;

async function project(): Promise<string> {
  return projectWith({ adapterVersion: await ownVersion(), packageName: NAMES.project });
}

describe('`upwind deployments`', () => {
  let printed: string[];
  let errors: string[];

  beforeEach(() => {
    printed = [];
    errors = [];
    vi.spyOn(console, 'log').mockImplementation((text: string) => {
      printed.push(text);
    });
    vi.spyOn(console, 'error').mockImplementation((text: string) => {
      errors.push(text);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists each deployment where it stands, the newest first', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const gone = edge.deploy({ functions: false });
    const older = edge.deploy();
    const live = edge.deploy();
    const checked = edge.deploy();
    edge.serve([
      { versionId: live.versionId, percentage: 100 },
      { versionId: checked.versionId, percentage: 0 },
    ]);

    await expect(runDeployments({ projectDir: await project() }, CREDENTIALS, fake)).resolves.toBe(
      0,
    );
    expect(printed).toStrictEqual([
      'upwind: shop, 4 deployments on shop-edge',
      expect.stringContaining(`  ${checked.deploymentId}  waiting `),
      expect.stringContaining(`  ${live.deploymentId}  live `),
      expect.stringContaining(`  ${older.deploymentId}  rollback `),
      expect.stringContaining(`  ${gone.deploymentId}  cleaned up `),
    ]);
    expect(fake.requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('marks a deployment whose version a deployment of the edge can no longer choose', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const old = edge.deploy();
    for (let index = 0; index < DEPLOYABLE; index += 1) {
      edge.upload();
    }
    const live = edge.deploy();
    edge.serve([{ versionId: live.versionId, percentage: 100 }]);

    await expect(runDeployments({ projectDir: await project() }, CREDENTIALS, fake)).resolves.toBe(
      0,
    );
    expect(printed).toContainEqual(expect.stringContaining(`  ${old.deploymentId}  out of reach `));
  });

  it('says so of a project never deployed, and needs the token to read the account', async () => {
    const dir = await project();

    await expect(runDeployments({ projectDir: dir }, CREDENTIALS, fakeCloudflare())).resolves.toBe(
      0,
    );
    expect(printed).toStrictEqual(['upwind: shop has no deployments on the account']);
    await expect(runDeployments({ projectDir: dir }, undefined)).resolves.toBe(1);
    expect(errors).toStrictEqual([expect.stringMatching(/CLOUDFLARE_API_TOKEN/u)]);
  });
});
