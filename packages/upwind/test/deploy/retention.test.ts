import { createId } from '@stayingupwind/core/util';
import type { RetireScopeInput } from '@stayingupwind/host/cache';
import { describe, expect, it } from 'vitest';

import { createCloudflareClient } from '../../src/deploy/cloudflare/client.ts';
import { functionScriptName } from '../../src/deploy/names.ts';
import { retainDeployments } from '../../src/deploy/retention.ts';
import { fakeEdge, NAMES, scriptOf } from './edge-history.ts';
import { fakeCloudflare } from './fake-cloudflare.ts';

/** When retention runs, in the tests: a day after `LONG_AGO`. */
const NOW = Date.parse('2026-01-02T00:00:00.000Z');
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function retiring(): {
  readonly retired: string[];
  readonly cache: { retireScope(input: RetireScopeInput): Promise<{ kind: 'retired' }> };
} {
  const retired: string[] = [];
  return {
    retired,
    cache: {
      retireScope: (input) => {
        retired.push(input.scopeId);
        return Promise.resolve({ kind: 'retired' });
      },
    },
  };
}

function scopeOf(fake: ReturnType<typeof fakeCloudflare>) {
  return {
    client: createCloudflareClient({ apiToken: 'token', fetch: fake.fetch }),
    accountId: 'account-1',
  };
}

describe('keeping deployments to roll back to', () => {
  it('keeps the live one and the newest few, and deletes the Functions of the rest', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const deployed = Array.from({ length: 6 }, () => edge.deploy());
    const live = edge.deploy();
    edge.serve([{ versionId: live.versionId, percentage: 100 }]);
    const { retired, cache } = retiring();

    const retention = await retainDeployments({
      scope: scopeOf(fake),
      names: NAMES,
      keep: 2,
      deploymentId: live.deploymentId,
      cache,
      now: () => NOW,
    });

    const [first, second, third, fourth, fifth, sixth] = deployed;

    expect(retention.kept).toStrictEqual([
      live.deploymentId,
      sixth?.deploymentId,
      fifth?.deploymentId,
    ]);

    const doomed = [fourth, third, second, first].map((record) => record?.deploymentId);

    expect(retention.deleted).toStrictEqual(doomed);
    expect(retired).toStrictEqual(doomed);

    for (const record of [...deployed, live]) {
      expect(fake.scripts.has(record.scriptName)).toBe(
        retention.kept.includes(record.deploymentId),
      );
    }

    expect(retention.orphans).toStrictEqual([]);
  });

  it('counts no deployment it could not roll back to among those it keeps', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const older = edge.deploy();
    const broken = edge.deploy();
    const live = edge.deploy();
    edge.serve([{ versionId: live.versionId, percentage: 100 }]);
    // Half deleted, by a run that stopped: nothing to roll back to.
    fake.scripts.delete(broken.scriptName);
    fake.scripts.set(
      functionScriptName(NAMES.project, broken.deploymentId, 'mw'),
      scriptOf(
        functionScriptName(NAMES.project, broken.deploymentId, 'mw'),
        '2026-01-01T00:00:00.000Z',
      ),
    );
    const { cache } = retiring();

    const retention = await retainDeployments({
      scope: scopeOf(fake),
      names: NAMES,
      keep: 1,
      deploymentId: live.deploymentId,
      cache,
      now: () => NOW,
    });

    expect(retention.kept).toStrictEqual([live.deploymentId, older.deploymentId]);
    expect(retention.deleted).toStrictEqual([broken.deploymentId]);
  });

  it('deletes Functions no edge version names once they are an hour old', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const live = edge.deploy();
    edge.serve([{ versionId: live.versionId, percentage: 100 }]);
    const stopped = createId('dpl');
    const running = createId('dpl');
    const stoppedScript = functionScriptName(NAMES.project, stopped, 'app');
    const runningScript = functionScriptName(NAMES.project, running, 'app');
    fake.scripts.set(
      stoppedScript,
      scriptOf(stoppedScript, new Date(NOW - 2 * HOUR_MS).toISOString()),
    );
    fake.scripts.set(
      runningScript,
      scriptOf(runningScript, new Date(NOW - 10 * MINUTE_MS).toISOString()),
    );
    const { retired, cache } = retiring();

    const retention = await retainDeployments({
      scope: scopeOf(fake),
      names: NAMES,
      keep: 5,
      deploymentId: live.deploymentId,
      cache,
      now: () => NOW,
    });

    expect(retention.orphans).toStrictEqual([stoppedScript]);
    expect(retired).toStrictEqual([stopped]);
    expect(fake.scripts.has(stoppedScript)).toBe(false);
    expect(fake.scripts.has(runningScript)).toBe(true);
  });

  it('deletes nothing the edge still sends requests to', async () => {
    const fake = fakeCloudflare();
    const edge = fakeEdge(fake);
    const old = edge.deploy();
    const live = edge.deploy();
    edge.serve([
      { versionId: live.versionId, percentage: 100 },
      // Held at none, as a run checking it leaves it: what it names stays as well.
      { versionId: old.versionId, percentage: 0 },
    ]);
    const { retired, cache } = retiring();

    const retention = await retainDeployments({
      scope: scopeOf(fake),
      names: NAMES,
      keep: 0,
      deploymentId: live.deploymentId,
      cache,
      now: () => NOW,
    });

    expect(retention.kept).toStrictEqual([live.deploymentId, old.deploymentId]);
    expect(retention.deleted).toStrictEqual([]);
    expect(retired).toStrictEqual([]);
    expect(fake.scripts.has(old.scriptName)).toBe(true);
  });
});
