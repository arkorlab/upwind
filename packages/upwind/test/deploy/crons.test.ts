import { describe, expect, it } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import type { AccountScope } from '../../src/deploy/cloudflare/workers.ts';
import { cronProblems, cronTableOf, scheduleCrons, triggersOf } from '../../src/deploy/crons.ts';
import { type FakeCloudflare, fakeCloudflare } from './fake-cloudflare.ts';

const NOW_MS = Date.parse('2026-10-24T12:34:56Z');

function scopeOf(fake: FakeCloudflare): AccountScope {
  return {
    client: createCloudflareClient({
      apiToken: 'token',
      fetch: fake.fetch,
      sleep: () => Promise.resolve(),
    }),
    accountId: 'account-1',
  };
}

describe("a deployment's cron jobs, by trigger", () => {
  it('groups the jobs whose schedules select the same minutes under one trigger', () => {
    const table = cronTableOf([
      { path: '/api/tick', schedule: '0 * * * *' },
      { path: '/api/weekly', schedule: '0 9 * * 1' },
      { path: '/api/tick-again', schedule: '0 */1 * * *' },
    ]);

    expect(table).toStrictEqual({
      '0 * * * *': [
        { path: '/api/tick', schedule: '0 * * * *' },
        { path: '/api/tick-again', schedule: '0 */1 * * *' },
      ],
      '0 9 * * 2': [{ path: '/api/weekly', schedule: '0 9 * * 1' }],
    });
    expect(triggersOf(table)).toStrictEqual(['0 * * * *', '0 9 * * 2']);
  });

  it('has nothing for a deployment with no jobs', () => {
    expect(cronTableOf(undefined)).toStrictEqual({});
    expect(cronTableOf([])).toStrictEqual({});
  });

  it("finds every job's trigger firing when its schedule does, one that never fires included", () => {
    expect(
      cronProblems(
        [
          { path: '/api/weekdays', schedule: '30 8 * * 1-5' },
          { path: '/api/leap', schedule: '0 0 29 2 *' },
          { path: '/api/never', schedule: '0 0 30 2 *' },
        ],
        NOW_MS,
      ),
    ).toStrictEqual([]);
  });
});

describe("the edge's Cron Triggers", () => {
  it('are written only where they are not already what they are to be', async () => {
    const fake = fakeCloudflare();
    fake.scripts.set('shop-edge', {
      name: 'shop-edge',
      versions: [],
      deployments: [],
      subdomain: { enabled: true, previews_enabled: false },
      migrationTag: undefined,
      secrets: new Map(),
    });
    const scope = scopeOf(fake);
    const puts = (): number => {
      return fake.requests.filter(
        (request) => request.method === 'PUT' && request.path.endsWith('/schedules'),
      ).length;
    };

    await expect(scheduleCrons(scope, 'shop-edge', [])).resolves.toBe(false);
    await expect(scheduleCrons(scope, 'shop-edge', ['0 9 * * 2', '0 * * * *'])).resolves.toBe(true);
    await expect(scheduleCrons(scope, 'shop-edge', ['0 * * * *', '0 9 * * 2'])).resolves.toBe(
      false,
    );
    await expect(scheduleCrons(scope, 'shop-edge', [])).resolves.toBe(true);

    expect(puts()).toBe(2);
    expect(fake.scripts.get('shop-edge')?.schedules).toStrictEqual([]);
  });
});
