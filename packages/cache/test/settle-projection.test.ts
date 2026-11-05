import {
  deriveEntry,
  kvGenerationKey,
  kvScopeKey,
  kvTagKey,
  policyFromBuild,
  tagIdFor,
} from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { wantedRecords } from '../src/scope/commit-record.ts';
import { NO_HISTORY, NOTHING_PUBLISHED } from '../src/scope/history.ts';
import { planInvalidate } from '../src/scope/invalidations.ts';
import type { BlobStore } from '../src/scope/io.ts';
import { applySchema } from '../src/scope/schema.ts';
import { applySeedScope, planSeedEntries } from '../src/scope/seed.ts';
import { countSettleFailures } from '../src/scope/settle-retry.ts';
import { chainSettlePhases } from '../src/scope/settle-schedule.ts';
import {
  finishSettle,
  ownRecordsOf,
  projectPending,
  publishPending,
  type SettleDeps,
} from '../src/scope/settle.ts';
import { readMeta } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { ControlTagProjectionError } from '../src/scope/tag-projection.ts';

const NOW = 1_800_000_000_000;
const TAG = 'changed';
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const IDLE = { projected: Promise.resolve(), done: Promise.resolve() };

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function watched(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise
    .finally(() => {
      state.settled = true;
    })
    .catch(() => {
      // This observer also records rejection; the caller checks its outcome separately.
    });
  return state;
}

async function observedResult(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
  }
}

function inScope<T>(action: (storage: DurableObjectStorage, scopeId: string) => Promise<T>) {
  const scopeId = createId('dpl');
  return runInDurableObject(scopeStub(env, scopeId), (_instance, state) => {
    applySchema(state.storage.sql, []);
    return action(state.storage, scopeId);
  });
}

function seed(): SeedEntryInput {
  return {
    descriptor: { kind: 'app-page', route: '/', pathname: '/' },
    groupInstanceId: null,
    generation: {
      generationId: createId('gen'),
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: {},
      tags: [{ kind: 'next-explicit', value: TAG }],
      dependencyCoverage: 'complete',
      outputs: [
        {
          representationKey: 'html',
          pathname: '/',
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: 0,
          artifacts: [
            {
              role: 'html',
              sha256: EMPTY_SHA,
              byteLength: 0,
              contentType: 'text/html',
              encoding: 'identity',
              storageRef: 'build/empty',
            },
          ],
        },
      ],
    },
  };
}

/** Real projection SQL and record construction, with storage I/O controlled by the test. */
async function fixture(storage: DurableObjectStorage, scopeId: string) {
  const tx = {
    sql: storage.sql,
    scopeId,
    now: NOW,
    revision: 1,
    limits: limitsOf(parseVars({})),
    history: NO_HISTORY,
  };
  applySeedScope(tx, {
    scope: {
      scopeId,
      organizationId: 'owner',
      projectId: 'site',
      environmentId: 'production',
      deploymentId: scopeId,
      keySchemaVersion: 1,
      buildId: 'build',
    },
  });
  const entry = seed();
  const apply = await planSeedEntries(
    { ...tx, revision: 2 },
    { scopeId, batchIndex: 0, entries: [entry] },
  );
  storage.transactionSync(apply);
  const invalidate = await planInvalidate(
    { ...tx, revision: 3 },
    { tags: [{ value: TAG }], cause: { source: 'control' } },
  );
  storage.transactionSync(invalidate);
  const { entryId } = await deriveEntry(scopeId, entry.descriptor);
  const tagId = await tagIdFor(scopeId, 'next-explicit', TAG);
  const blobs: BlobStore = {
    read: () => Promise.resolve(new Uint8Array()),
    exists: () => Promise.resolve(true),
    write: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    deletePrefix: () => Promise.resolve(),
    listPage: () => Promise.resolve({ objects: [], cursor: undefined }),
  };
  const deps: SettleDeps = {
    sql: storage.sql,
    scopeId,
    buildId: 'build',
    blobs,
    kv: {
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      listPage: () => Promise.resolve({ keys: [], cursor: undefined }),
    },
    history: NO_HISTORY,
    log: logger(),
    now: () => NOW,
    transaction: (body) => storage.transactionSync(body),
    sliceMs: 1000,
    othersWaiting: () => false,
    continueSoon: () => Promise.resolve(),
  };
  return {
    deps,
    entryId,
    own: ownRecordsOf(storage.sql, 3, [], [tagId]),
    keys: {
      record: kvGenerationKey(scopeId, entryId),
      tag: kvTagKey(scopeId, tagId),
      marker: kvScopeKey(scopeId),
    },
  };
}

describe('the projection acknowledgment boundary', () => {
  it('waits for its record and tag, then acknowledges before history', async () => {
    await inScope(async (storage, scopeId) => {
      const f = await fixture(storage, scopeId);
      const gates = new Map(
        [f.keys.record, f.keys.tag].map((key) => [key, Promise.withResolvers<undefined>()]),
      );
      const entered = Promise.withResolvers<undefined>();
      const history = Promise.withResolvers<undefined>();
      const calls = new Set<string>();
      const publish = vi.fn(async () => {
        await history.promise;
        return NOTHING_PUBLISHED;
      });
      const deps: SettleDeps = {
        ...f.deps,
        kv: {
          ...f.deps.kv,
          put: async (key) => {
            calls.add(key);
            if (calls.size === gates.size) entered.resolve(undefined);
            await gates.get(key)?.promise;
          },
        },
        history: { ...NO_HISTORY, publish },
      };
      const wanted = wantedRecords(() => f.entryId);
      const own = { ...f.own, wanted, carried: { sha256: EMPTY_SHA, bytes: new Uint8Array(32) } };
      const projection = projectPending(deps, own);
      const run = chainSettlePhases(
        IDLE,
        deps.log,
        () => projection,
        async (projected) => {
          await publishPending(deps, projected);
        },
      );
      const answer = watched(run.answered);
      const drain = watched(run.done);

      try {
        await entered.promise;
        gates.get(f.keys.record)?.resolve(undefined);
        await microtasks();

        expect(answer.settled).toBe(false);
        expect(publish).not.toHaveBeenCalled();

        gates.get(f.keys.tag)?.resolve(undefined);
        await run.answered;

        const projected = await projection;

        expect(projected).toStrictEqual({ early: true, failed: false, continued: false });
        expect(wanted.records.get(f.entryId)?.bytes).toBeInstanceOf(Uint8Array);
        expect(drain.settled).toBe(false);
        expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scopeId }));
      } finally {
        for (const gate of gates.values()) gate.resolve(undefined);
        history.resolve(undefined);
        await run.done;
        wanted.release();
      }
    });
  });

  it('holds a retirement acknowledgment until its scope marker is written', async () => {
    await inScope(async (storage, scopeId) => {
      const f = await fixture(storage, scopeId);
      storage.sql.exec(`UPDATE scope SET status = 'retired', retired_at = ?`, NOW);
      const marker = Promise.withResolvers<undefined>();
      const entered = Promise.withResolvers<undefined>();
      const deps: SettleDeps = {
        ...f.deps,
        kv: {
          ...f.deps.kv,
          put: async (key) => {
            if (key === f.keys.marker) {
              entered.resolve(undefined);
              await marker.promise;
            }
          },
        },
      };
      const run = chainSettlePhases(
        IDLE,
        deps.log,
        () => projectPending(deps, f.own),
        async (projection) => {
          await publishPending(deps, projection);
        },
      );
      const answer = watched(run.answered);
      try {
        await entered.promise;
        await microtasks();

        expect(answer.settled).toBe(false);
      } finally {
        marker.resolve(undefined);
        await run.done;
      }

      await expect(run.answered).resolves.toBeUndefined();
    });
  });

  it('keeps failed projection retry scheduling in the full drain and permits recovery', async () => {
    await inScope(async (storage, scopeId) => {
      const f = await fixture(storage, scopeId);
      const alarm = Promise.withResolvers<undefined>();
      const alarmStarted = Promise.withResolvers<undefined>();
      const failureCounts: number[] = [];
      let refuse = true;
      const deps: SettleDeps = {
        ...f.deps,
        kv: {
          ...f.deps.kv,
          put: () => (refuse ? Promise.reject(new Error('KV refused')) : Promise.resolve()),
        },
      };
      const first = chainSettlePhases(
        IDLE,
        deps.log,
        () => projectPending(deps, f.own),
        async (projection) => {
          const outcome = await publishPending(deps, projection);
          await finishSettle(outcome, f.own.controlTags, async (finished) => {
            failureCounts.push(countSettleFailures(storage.sql, deps.log, finished));
            alarmStarted.resolve(undefined);
            await alarm.promise;
          });
        },
      );
      const answer = watched(first.answered);
      const drained = watched(first.done);

      try {
        await alarmStarted.promise;

        expect(answer.settled).toBe(false);
        expect(drained.settled).toBe(false);
        expect(failureCounts).toStrictEqual([1]);

        refuse = false;
        const recovered = chainSettlePhases(
          first,
          deps.log,
          () => projectPending(deps, f.own),
          async (projection) => {
            const outcome = await publishPending(deps, projection);
            await finishSettle(outcome, f.own.controlTags, (finished) => {
              failureCounts.push(countSettleFailures(storage.sql, deps.log, finished));
              return Promise.resolve();
            });
          },
        );
        await recovered.answered;

        expect(failureCounts).toStrictEqual([1]);

        alarm.resolve(undefined);
        await recovered.done;

        expect(failureCounts).toStrictEqual([1, 0]);
        expect(readMeta(storage.sql, 'settle_failures')).toBeUndefined();
      } finally {
        alarm.resolve(undefined);
        await first.done;
      }
    });
  });

  it('carries a private mark failure into completion and rejects only after its retry is armed', async () => {
    await inScope(async (storage, scopeId) => {
      const f = await fixture(storage, scopeId);
      const tagId = await tagIdFor(scopeId, 'next-explicit', TAG);
      const own = { ...f.own, controlTags: { ids: [tagId], projected: false } };
      const alarm = Promise.withResolvers<undefined>();
      const alarmStarted = Promise.withResolvers<undefined>();
      const deps: SettleDeps = {
        ...f.deps,
        kv: {
          ...f.deps.kv,
          put: (key) => {
            return key === f.keys.tag
              ? Promise.reject(new Error('private mark refused'))
              : Promise.resolve();
          },
        },
      };
      const projection = await projectPending(deps, own);

      expect(projection).toStrictEqual({
        early: false,
        failed: true,
        continued: false,
        controlTagsFailed: true,
      });

      const run = chainSettlePhases(
        IDLE,
        deps.log,
        () => Promise.resolve(projection),
        async (projected) => {
          const outcome = await publishPending(deps, projected);
          await finishSettle(outcome, undefined, async () => {
            alarmStarted.resolve(undefined);
            await alarm.promise;
          });
        },
      );
      const answered = observedResult(run.answered);
      const done = observedResult(run.done);
      const answer = watched(run.answered);
      try {
        await alarmStarted.promise;
        await microtasks();

        expect(answer.settled).toBe(false);
      } finally {
        alarm.resolve(undefined);

        await expect(answered).resolves.toBeInstanceOf(ControlTagProjectionError);
        await expect(done).resolves.toBeInstanceOf(ControlTagProjectionError);
      }
    });
  });
});
