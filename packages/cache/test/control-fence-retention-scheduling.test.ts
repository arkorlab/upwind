import { createId } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { createLogger } from '../src/logger.ts';
import {
  CONTROL_FENCE_LIFETIME_MS,
  controlFenceSweepPending,
  controlFenceTag,
  queueControlFence,
  readControlFenceFloor,
} from '../src/scope/control-fences.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { blobStore } from '../src/scope/io.ts';
import { nextRetentionAt, runRetention, type RetentionRun } from '../src/scope/retention-run.ts';
import { readMeta } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { queueControlTagProjection } from '../src/scope/tags.ts';

const NOW = 1_800_000_000_000;
const INTERVAL = 3_600_000;
const SOON = 1000;
const EXPIRED = 201;
const LIMITS = limitsOf(parseVars({}));

function noFaults() {
  return {};
}

async function inScope<T>(action: (run: RetentionRun) => T | Promise<T>) {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await stub.seedScope(
    {
      scope: {
        scopeId,
        organizationId: 'owner',
        projectId: 'site',
        environmentId: 'production',
        deploymentId: scopeId,
        keySchemaVersion: 1,
        buildId: 'build',
      },
    },
    NOW,
  );
  return runInDurableObject(stub, (_instance, state) => {
    return action({
      scopeId,
      sql: state.storage.sql,
      limits: LIMITS,
      history: NO_HISTORY,
      blobs: blobStore(env.ARTIFACTS, noFaults),
      log: createLogger({ component: 'retention-fence-test' }),
      transaction: (body) => state.storage.transactionSync(body),
    });
  });
}

function addFence(sql: SqlStorage, id: string, revision: number, recordedAt: number) {
  const ref = { tagId: id, kind: 'next-explicit' as const, value: id };
  const write = {
    ref,
    revision,
    staleAt: recordedAt,
    hardExpireAt: null,
    meaning: 'immediate' as const,
  };
  queueControlFence(
    sql,
    { ...ref, revision, staleAt: recordedAt, hardExpireAt: null, meaning: 'immediate' },
    {
      invalidation_id: `invalidation-${id}`,
      revision,
      target_kind: 'tag',
      target_id: id,
      target_value: id,
      stale_at: recordedAt,
      hard_expire_at: null,
      meaning: 'immediate',
      expire_seconds: null,
      cause: 'control-fence-retention-test',
      recorded_at: recordedAt,
    },
  );
  return write;
}

function addExpired(sql: SqlStorage) {
  for (let index = 0; index < EXPIRED; index += 1) {
    addFence(
      sql,
      `tag-${String(index).padStart(4, '0')}`,
      index + 1,
      NOW - CONTROL_FENCE_LIFETIME_MS,
    );
  }
}

function standing(sql: SqlStorage, now: number) {
  return {
    count: Number(readMeta(sql, 'control_tag_fence_count') ?? '0'),
    pending: controlFenceSweepPending(sql),
    next: nextRetentionAt(sql, now, INTERVAL),
    floor: readControlFenceFloor(sql),
  };
}

describe('the next retention alarm while projected control fences expire', () => {
  it('returns within a second for the expired projected fence beyond one sweep page', async () => {
    const result = await inScope(async (run) => {
      addExpired(run.sql);
      await runRetention(run, NOW, undefined);
      return standing(run.sql, NOW);
    });

    expect(result).toMatchObject({ count: 1, pending: true, next: NOW + SOON });
  });

  it('drains the next page and returns to the normal interval without another mutation', async () => {
    const result = await inScope(async (run) => {
      addExpired(run.sql);
      await runRetention(run, NOW, undefined);
      const first = standing(run.sql, NOW);
      await runRetention(run, NOW + SOON, undefined);
      return { first, last: standing(run.sql, NOW + SOON) };
    });

    expect(result.first).toMatchObject({ count: 1, pending: true, next: NOW + SOON });
    expect(result.last).toStrictEqual({
      count: 0,
      pending: false,
      next: NOW + SOON + INTERVAL,
      floor: { revision: EXPIRED, timestamp: NOW - CONTROL_FENCE_LIFETIME_MS },
    });
  });

  it('preserves unexpired and unprojected fences without keeping the soon alarm armed', async () => {
    const result = await inScope(async (run) => {
      addFence(run.sql, 'expired-projected', 1, NOW - CONTROL_FENCE_LIFETIME_MS);
      addFence(run.sql, 'unexpired', 2, NOW);
      const pending = addFence(run.sql, 'pending-projection', 3, NOW - CONTROL_FENCE_LIFETIME_MS);
      queueControlTagProjection(run.sql, pending);
      await runRetention(run, NOW, undefined);
      return {
        ...standing(run.sql, NOW),
        unexpired: controlFenceTag(run.sql, 'unexpired'),
        unprojected: controlFenceTag(run.sql, 'pending-projection'),
      };
    });

    expect(result).toMatchObject({ count: 2, pending: false, next: NOW + INTERVAL });
    expect(result.unexpired).toMatchObject({ tagId: 'unexpired', revision: 2 });
    expect(result.unprojected).toMatchObject({ tagId: 'pending-projection', revision: 3 });
  });
});
