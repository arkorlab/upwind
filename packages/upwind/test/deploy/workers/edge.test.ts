import { afterEach, describe, expect, it } from 'vitest';

import { READINESS_PATH } from '../../../src/deploy/workers/protocol.ts';
import { type RunningStack, runStack } from './stack.ts';

const MANIFEST_ID = 'a'.repeat(64);
const DEPLOYMENT_ID = 'dpl_4Fixture2Minima1AppXy';

describe("the edge's entry", () => {
  let stack: RunningStack | undefined;

  afterEach(async () => {
    await stack?.dispose();
    stack = undefined;
  });

  it('says which deployment it serves, which version it is, and whether its manifest is in place', async () => {
    stack = await runStack({
      pointer: JSON.stringify({ manifestId: MANIFEST_ID, app: { deploymentId: DEPLOYMENT_ID } }),
      versionId: 'version-7',
    });
    const edge = await stack.url('edge');
    const before = await fetch(new URL(READINESS_PATH, edge));

    expect(before.headers.get('cache-control')).toBe('no-store');
    await expect(before.json()).resolves.toStrictEqual({
      deploymentId: DEPLOYMENT_ID,
      manifestId: MANIFEST_ID,
      versionId: 'version-7',
      manifest: { kv: false, r2: false },
    });

    await (
      await stack.mf.getKVNamespace('EDGE_STATE', 'edge')
    ).put(`manifest:${MANIFEST_ID}`, '{}');
    await (
      await stack.mf.getR2Bucket('ARTIFACTS', 'edge')
    ).put(`manifests/${MANIFEST_ID}.json`, '{}');
    const after = await fetch(new URL(READINESS_PATH, edge));

    await expect(after.json()).resolves.toMatchObject({ manifest: { kv: true, r2: true } });
  });

  it('leaves every other request to the standalone edge', async () => {
    stack = await runStack();
    const edge = await stack.url('edge');
    const ready = await fetch(new URL(READINESS_PATH, edge));

    await expect(ready.json()).resolves.toStrictEqual({
      versionId: 'version-1',
      manifest: { kv: false, r2: false },
    });

    const page = await fetch(new URL(`/?next=${READINESS_PATH}`, edge));

    // No pointer: the standalone edge's own answer, which a path that merely mentions it gets too.
    expect(page.status).toBe(404);

    await page.body?.cancel();
  });

  it('fires the jobs of the trigger it is invoked on, and asks Cloudflare to try none again', async () => {
    stack = await runStack({
      edgeText: {
        HOSTNAMES: 'shop.example.com',
        CRONS: JSON.stringify({ '0 * * * *': [{ path: '/api/tick', schedule: '0 * * * *' }] }),
      },
    });
    const worker = await stack.mf.getWorker('edge');

    // No pointer: the job is the standalone edge's to answer, and is answered.
    await expect(worker.scheduled({ cron: '0 * * * *' })).resolves.toStrictEqual({
      outcome: 'ok',
      noRetry: true,
    });
    await expect(worker.scheduled({ cron: '*/5 * * * *' })).resolves.toMatchObject({
      outcome: 'ok',
    });
  });
});
