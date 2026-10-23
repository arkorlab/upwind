import { policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { artifactRepairMarker, rememberArtifactFailure } from '../src/scope/artifacts.ts';
import { planSetData } from '../src/scope/data.ts';
import { markRecordWritten } from '../src/scope/entries.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { ScopeQueue } from '../src/scope/mutations.ts';
import { isRepairStart, readRepairJob, repairJobResult } from '../src/scope/repair-jobs.ts';
import { RepairRunner } from '../src/scope/repair-runner.ts';
import type { EntryRow } from '../src/scope/rows.ts';
import { planSeedEntries } from '../src/scope/seed.ts';
import { readRevision } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import type { TxInput } from '../src/scope/tx.ts';

const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(64);

async function inScope(action: (tx: TxInput, storage: DurableObjectStorage) => Promise<void>) {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await stub.seedScope(
    {
      scope: {
        scopeId,
        deploymentId: scopeId,
        organizationId: 'owner',
        projectId: 'site',
        environmentId: 'production',
        keySchemaVersion: 1,
        buildId: 'build',
      },
    },
    NOW,
  );
  await runInDurableObject(stub, (_instance, state) => {
    return action(
      {
        sql: state.storage.sql,
        scopeId,
        buildId: 'build',
        now: NOW,
        revision: readRevision(state.storage.sql) + 1,
        limits: limitsOf(parseVars({})),
        history: NO_HISTORY,
      },
      state.storage,
    );
  });
}

async function seed(tx: TxInput, storage: DurableObjectStorage, count: number) {
  const apply = await planSeedEntries(tx, {
    scopeId: tx.scopeId,
    batchIndex: 0,
    entries: Array.from({ length: count }, (_, index) => ({
      descriptor: { kind: 'app-page' as const, route: `/row-${index}`, pathname: `/row-${index}` },
      groupInstanceId: null,
      generation: {
        generationId: `row-generation-${index}`,
        cacheTimestamp: NOW,
        producedAt: NOW,
        policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
        status: 200,
        headers: {},
        tags: [],
        dependencyCoverage: 'complete' as const,
        outputs: [
          {
            representationKey: 'rsc',
            pathname: `/row-${index}`,
            status: 200,
            headers: {},
            compute: 'static' as const,
            response: 'complete' as const,
            htmlSize: null,
            artifacts: [
              {
                role: 'rsc' as const,
                sha256: SHA,
                byteLength: 1,
                contentType: 'text/x-component',
                encoding: 'identity' as const,
                storageRef: 'x',
              },
            ],
          },
        ],
      },
    })),
  });
  storage.transactionSync(apply);
  return tx.sql.exec<EntryRow>('SELECT * FROM entries ORDER BY entry_id').toArray();
}

/** groupInstanceId is accepted metadata absent from the delivery pack; ask the actual row limit. */
function padEntry(storage: DurableObjectStorage, entryId: string): string {
  const fits = (length: number): boolean => {
    try {
      storage.transactionSync(() => {
        storage.sql.exec(
          'UPDATE entries SET group_instance_id = ? WHERE entry_id = ?',
          'x'.repeat(length),
          entryId,
        );
      });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !/\bSQLITE_TOOBIG\b/u.test(error.message)) throw error;
      return false;
    }
  };
  const maximum = 12 * 1024 * 1024;
  if (fits(maximum)) throw new Error('the SQL row limit exceeds the fixture search window');
  let low = 0;
  let high = maximum;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  const value = 'x'.repeat(low);
  storage.sql.exec('UPDATE entries SET group_instance_id = ? WHERE entry_id = ?', value, entryId);
  return value;
}

async function beginDataRepair(tx: TxInput, storage: DurableObjectStorage): Promise<string> {
  rememberArtifactFailure(tx.sql, { sha256: SHA, byteLength: 1, storageRef: 'x' });
  const prepare = await planSetData(
    { ...tx, revision: readRevision(tx.sql) + 1 },
    {
      key: 'another-data-entry',
      entry: {
        kind: 'data:fetch',
        tags: [],
        stale: 60,
        timestamp: NOW,
        expire: 600,
        revalidate: 60,
        dependencyCoverage: 'complete',
      },
      value: { sha256: SHA, byteLength: 1, contentType: 'text/plain', storageRef: 'replacement' },
    },
  );
  const start = storage.transactionSync(prepare);
  if (!isRepairStart(start)) throw new Error('the fixture repair did not prepare');
  storage.transactionSync(() => {
    return start.start({ ...tx, revision: readRevision(tx.sql) + 1 });
  });
  const job = readRepairJob(tx.sql);
  if (job === undefined) throw new Error('the repair did not persist');
  return job.id;
}

function runnerFor(tx: TxInput, storage: DurableObjectStorage) {
  return new RepairRunner({
    storage,
    queue: new ScopeQueue(),
    arm: () => Promise.resolve(),
    input: (now) => ({ ...tx, now, revision: readRevision(tx.sql) + 1 }),
  });
}

async function finishRepair(tx: TxInput, runner: RepairRunner, now: number): Promise<boolean> {
  let active = await runner.advance(now);
  while (readRepairJob(tx.sql) !== undefined) active = await runner.advance(now);
  return active;
}

describe('exact repair entry row preflight', () => {
  it('accepts a full row when its exact future widths fit and preserves the accepted clock', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 1);
      const target = rows[0]?.entry_id;
      if (target === undefined) throw new Error('missing fixture entry');
      tx.sql.exec('UPDATE scope SET revision = 126');
      tx.sql.exec('UPDATE entries SET revision = 126, record_revision = 126, kv_revision = 126');
      const original = padEntry(storage, target);
      const jobId = await beginDataRepair(tx, storage);
      const runner = runnerFor(tx, storage);
      const active = await finishRepair(tx, runner, NOW + 10_000);
      const after = tx.sql.exec<EntryRow>('SELECT * FROM entries WHERE entry_id = ?', target).one();
      const canonical = tx.sql
        .exec<{ storage_ref: string }>('SELECT storage_ref FROM artifacts WHERE sha256 = ?', SHA)
        .one();

      expect(active).toBe(false);
      expect(repairJobResult(tx.sql, jobId)?.value).toMatchObject({
        retainedStorageRef: 'replacement',
      });
      expect([
        after.revision,
        after.record_revision,
        after.kv_revision,
        after.updated_at,
      ]).toStrictEqual([127, 127, 126, NOW]);
      expect(after.group_instance_id).toBe(original);
      expect(canonical.storage_ref).toBe('replacement');
      expect(readRevision(tx.sql)).toBe(127);
    });
  });

  it('keeps the original revision width for every shared row instead of refusing a later match', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 2);
      const target = rows[1]?.entry_id;
      if (target === undefined) throw new Error('missing fixture entry');
      tx.sql.exec('UPDATE scope SET revision = 126');
      tx.sql.exec('UPDATE entries SET revision = 126, record_revision = 126, kv_revision = 126');
      const original = padEntry(storage, target);
      const jobId = await beginDataRepair(tx, storage);
      const runner = runnerFor(tx, storage);
      const active = await finishRepair(tx, runner, NOW + 10_000);
      const entries = tx.sql.exec<EntryRow>('SELECT * FROM entries ORDER BY entry_id').toArray();
      const canonical = tx.sql
        .exec<{ storage_ref: string }>('SELECT storage_ref FROM artifacts WHERE sha256 = ?', SHA)
        .one();

      expect({ active, job: readRepairJob(tx.sql), revision: readRevision(tx.sql) }).toStrictEqual({
        active: false,
        job: undefined,
        revision: 127,
      });
      expect(repairJobResult(tx.sql, jobId)?.value).toMatchObject({
        retainedStorageRef: 'replacement',
      });
      expect(
        entries.map((entry) => [entry.revision, entry.record_revision, entry.kv_revision]),
      ).toStrictEqual([
        [127, 127, 126],
        [127, 127, 126],
      ]);
      expect(entries[1]?.group_instance_id).toBe(original);
      expect(canonical.storage_ref).toBe('replacement');
      expect(artifactRepairMarker(tx.sql, SHA)).toBeUndefined();
    });
  });

  it('preserves accepted publication when a later KV acknowledgment alone exceeds the row limit', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 1);
      const target = rows[0]?.entry_id;
      if (target === undefined) throw new Error('missing fixture entry');
      tx.sql.exec('UPDATE scope SET revision = 128');
      tx.sql.exec('UPDATE entries SET revision = 128, record_revision = 128, kv_revision = 127');
      const original = padEntry(storage, target);
      const jobId = await beginDataRepair(tx, storage);
      const runner = runnerFor(tx, storage);
      const active = await finishRepair(tx, runner, NOW);
      const after = tx.sql.exec<EntryRow>('SELECT * FROM entries WHERE entry_id = ?', target).one();

      expect(active).toBe(false);
      expect(repairJobResult(tx.sql, jobId)?.value).toMatchObject({
        retainedStorageRef: 'replacement',
      });
      expect([after.revision, after.record_revision, after.kv_revision]).toStrictEqual([
        129, 129, 127,
      ]);
      expect(after.group_instance_id).toBe(original);
      expect(readRevision(tx.sql)).toBe(129);
      expect(() => {
        storage.transactionSync(() => markRecordWritten(tx.sql, target, 129));
      }).toThrow(/SQLITE_TOOBIG/u);
    });
  });
});
