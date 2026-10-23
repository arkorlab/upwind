import { MAX_PACK_HEADER_BYTES, policyFromBuild } from '@stayingupwind/core/cache';
import { createId } from '@stayingupwind/core/util';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import {
  RepairRowTooLargeError,
  repairSnapshotStep,
  type ArtifactRepair,
} from '../src/scope/artifact-repair.ts';
import {
  artifactRepairMarker,
  artifactVerification,
  forgetVerifiedArtifactFailures,
  rememberArtifactFailure,
} from '../src/scope/artifacts.ts';
import { advanceCommitRepair } from '../src/scope/commit-repair.ts';
import { planSetData } from '../src/scope/data.ts';
import { requireEntry } from '../src/scope/entries.ts';
import { findGeneration } from '../src/scope/generations.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { MutationPipeline } from '../src/scope/mutation-pipeline.ts';
import { ScopeQueue } from '../src/scope/mutations.ts';
import { headerFieldsOf, unwritableRecord } from '../src/scope/records.ts';
import {
  advanceRepairJob,
  beginRepairJob,
  isRepairStart,
  collectRepairGarbage,
  completeRepairJob,
  readRepairJob,
  readRepairValue,
  releaseRepairGroup,
  repairJobResult,
  type RepairGroup,
  type RepairJob,
  writeRepairValue,
} from '../src/scope/repair-jobs.ts';
import { RepairPublicationProbed } from '../src/scope/repair-probes.ts';
import { RepairRunner } from '../src/scope/repair-runner.ts';
import { generationOutputs, type GenerationRow } from '../src/scope/rows.ts';
import { planSeedEntries } from '../src/scope/seed.ts';
import { ownRepairRecordsOf } from '../src/scope/settle.ts';
import { readRevision } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import type { TxInput } from '../src/scope/tx.ts';

const NOW = 1_800_000_000_000;
const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const NEXT = 'replacement/verified';

function entry(index: number): SeedEntryInput {
  const pathname = `/repair-${index}`;
  return {
    descriptor: { kind: 'app-page', route: pathname, pathname },
    groupInstanceId: null,
    generation: {
      generationId: `generation-${index}`,
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: {},
      tags: [],
      dependencyCoverage: 'complete',
      outputs: [
        {
          representationKey: 'html',
          pathname,
          status: 200,
          headers: {},
          compute: 'static',
          response: 'complete',
          htmlSize: null,
          artifacts: [
            {
              role: 'rsc',
              sha256: SHA,
              byteLength: 1,
              contentType: 'text/x-component',
              encoding: 'identity',
              storageRef: 'x',
            },
          ],
        },
      ],
    },
  };
}

async function inScope<T>(action: (tx: TxInput, storage: DurableObjectStorage) => T | Promise<T>) {
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
    entries: Array.from({ length: count }, (_, index) => entry(index)),
  });
  const outcome = storage.transactionSync(apply);
  if (!('inserted' in outcome)) throw new Error('the repair fixture could not be seeded');
  return tx.sql
    .exec<{ entry_id: string; current_generation_id: string }>(
      `SELECT entry_id, current_generation_id FROM entries ORDER BY entry_id`,
    )
    .toArray();
}

function current(tx: TxInput, entryId: string): GenerationRow {
  const id = requireEntry(tx.sql, entryId).current_generation_id;
  const row = id === null ? undefined : findGeneration(tx.sql, id);
  if (row === undefined) throw new Error('the repair fixture has no current generation');
  return row;
}

function repair(): ArtifactRepair {
  return {
    sha256: SHA,
    byteLength: 1,
    previousStorageRef: 'x',
    storageRef: NEXT,
    previouslyOwned: false,
  };
}

function group(): RepairGroup {
  return { entryId: 'not-current', repairs: [repair()], failureMarkers: [] };
}

function begin(tx: TxInput, selected = group()): RepairJob {
  beginRepairJob(tx.sql, {
    operation: 'commit',
    preparedAt: NOW,
    fromRevision: readRevision(tx.sql) + 1,
    limits: tx.limits,
    attemptId: 'accepted-attempt',
    publication: {
      plan: { dependencyTagIds: [], artifactIds: [], missingUploads: [], checkedUploads: [] },
      publication: { repairs: [] },
    },
    groups: [selected],
  });
  const job = readRepairJob(tx.sql);
  if (job === undefined) throw new Error('the fixture job was not persisted');
  return job;
}

/** This fixture isolates shared-row repair from the accepted owner's SQL publication. */
function advanceFixtureCommit(input: TxInput, job: RepairJob) {
  return advanceCommitRepair(input, job, () => ({
    kind: 'published',
    generationId: 'fixture-owner',
    seq: 1,
    revision: input.revision,
    condemned: null,
  }));
}

function refs(row: GenerationRow) {
  return generationOutputs(row).flatMap((output) =>
    output.artifacts.map((artifact) => artifact.storageRef),
  );
}

describe('bounded durable artifact repair continuations', () => {
  it('keeps later writers outside the queue while alarms visit only eight rows at a time', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 24);
      rememberArtifactFailure(tx.sql, { sha256: SHA, byteLength: 1, storageRef: 'x' });
      const prepare = await planSetData(
        { ...tx, revision: readRevision(tx.sql) + 1 },
        {
          key: 'new-data-entry',
          entry: {
            kind: 'data:fetch',
            tags: [],
            stale: 60,
            timestamp: NOW,
            expire: 600,
            revalidate: 60,
            dependencyCoverage: 'complete',
          },
          value: { sha256: SHA, byteLength: 1, contentType: 'text/plain', storageRef: NEXT },
        },
      );
      const start = storage.transactionSync(prepare);
      if (!isRepairStart(start)) throw new Error('the fixture data repair did not prepare');
      storage.transactionSync(() => start.start({ ...tx, revision: readRevision(tx.sql) + 1 }));
      const queue = new ScopeQueue();
      const armed: number[] = [];
      const arm = (at: number): Promise<void> => {
        armed.push(at);
        return Promise.resolve();
      };
      const runner = new RepairRunner({
        storage,
        queue,
        arm,
        input: (now) => ({ ...tx, now, revision: readRevision(tx.sql) + 1 }),
      });
      const pipeline = new MutationPipeline({
        storage,
        queue,
        repairs: runner,
        arm,
        armAnswered: arm,
        mutationHost: () => {
          return {
            storage,
            scopeId: tx.scopeId,
            buildId: tx.buildId,
            kv: env.CACHE_STATE,
            limits: tx.limits,
            history: NO_HISTORY,
            tables: true,
            createdTables: () => {
              throw new Error('unexpected table creation');
            },
          };
        },
        committed: () => {
          throw new Error('the locked mutation does not publish');
        },
        tables: () => true,
        testHooks: () => true,
        settling: () => Promise.resolve(),
        settle: () => {
          throw new Error('the locked mutation does not settle');
        },
      });
      let written = false;
      const later = pipeline.locked(0, () => {
        written = true;
        return 7;
      });
      const outside = await queue.run(() => 'a read can still run');
      const more = await runner.advance(NOW);
      const cursor = readRepairJob(tx.sql);

      expect({ outside, written, more }).toStrictEqual({
        outside: 'a read can still run',
        written: false,
        more: true,
      });
      expect(cursor).toMatchObject({ phase: 'preflight', after: rows[7]?.entry_id });
      expect(rows.every((row) => refs(current(tx, row.entry_id))[0] === 'x')).toBe(true);

      while (readRepairJob(tx.sql) !== undefined) await runner.advance(NOW);
      const result = await later;

      expect({ result, written }).toStrictEqual({ result: 7, written: true });
      expect(armed).not.toHaveLength(0);
      expect(rows.every((row) => refs(current(tx, row.entry_id))[0] === NEXT)).toBe(true);
    });
  });

  it('persists retry backoff instead of repeatedly executing the speculative immediate alarm', async () => {
    await inScope(async (tx, storage) => {
      await seed(tx, storage, 1);
      rememberArtifactFailure(tx.sql, { sha256: SHA, byteLength: 1, storageRef: 'x' });
      const prepare = await planSetData(
        { ...tx, revision: readRevision(tx.sql) + 1 },
        {
          key: 'retry-data-entry',
          entry: {
            kind: 'data:fetch',
            tags: [],
            stale: 60,
            timestamp: NOW,
            expire: 600,
            revalidate: 60,
            dependencyCoverage: 'complete',
          },
          value: { sha256: SHA, byteLength: 1, contentType: 'text/plain', storageRef: NEXT },
        },
      );
      const start = storage.transactionSync(prepare);
      if (!isRepairStart(start)) throw new Error('the fixture data repair did not prepare');
      storage.transactionSync(() => start.start({ ...tx, revision: readRevision(tx.sql) + 1 }));
      tx.sql.exec(`CREATE TRIGGER interrupt_repair BEFORE UPDATE OF outputs ON generations
        BEGIN SELECT RAISE(ABORT, 'temporary repair storage failure'); END`);
      const armed: number[] = [];
      const deferred: number[] = [];
      const runner = new RepairRunner({
        storage,
        queue: new ScopeQueue(),
        input: (now) => ({ ...tx, now, revision: readRevision(tx.sql) + 1 }),
        arm: (at) => {
          armed.push(at);
          return Promise.resolve();
        },
        defer: (at) => {
          deferred.push(at);
          return Promise.resolve();
        },
      });

      await expect(runner.advance(NOW)).rejects.toThrow('temporary repair storage failure');

      const pending = readRepairJob(tx.sql);
      if (pending?.retryAt === undefined) throw new Error('the durable retry time is missing');
      tx.sql.exec(`DROP TRIGGER interrupt_repair`);
      const beforeDue = await runner.advance(NOW);

      expect(pending).toMatchObject({ phase: 'preflight', after: '', failures: 1 });
      expect(pending.retryAt).toBeGreaterThan(NOW);
      expect(deferred).toStrictEqual([pending.retryAt]);
      expect({
        beforeDue,
        after: readRepairJob(tx.sql)?.after,
        armedAt: armed.at(-1),
      }).toStrictEqual({
        beforeDue: true,
        after: '',
        armedAt: pending.retryAt,
      });

      const finished = await runner.advance(pending.retryAt);

      expect({ finished, job: readRepairJob(tx.sql) }).toStrictEqual({
        finished: false,
        job: undefined,
      });
    });
  });

  it('visits skipped and nonmatching primary-key rows before it reaches a later match', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 3);
      const [retired, different, matching] = rows;
      if (retired === undefined || different === undefined || matching === undefined)
        throw new Error('missing fixture entries');
      tx.sql.exec(
        `UPDATE entries SET publication = 'retired' WHERE entry_id = ?`,
        retired.entry_id,
      );
      // A skipped generation must not be parsed merely to find a matching later generation.
      tx.sql.exec(
        `UPDATE generations SET outputs = 'not-json' WHERE generation_id = ?`,
        retired.current_generation_id,
      );
      const outputs = generationOutputs(current(tx, different.entry_id)).map((output) => {
        return {
          ...output,
          artifacts: output.artifacts.map((artifact) => ({ ...artifact, sha256: OTHER_SHA })),
        };
      });
      tx.sql.exec(
        `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
        JSON.stringify(outputs),
        different.current_generation_id,
      );
      const repairs = new Map([[SHA, repair()]]);
      const first = repairSnapshotStep(tx, repairs, {
        after: '',
        excluding: new Set(),
        apply: false,
      });
      const second = repairSnapshotStep(tx, repairs, {
        after: first.after,
        excluding: new Set(),
        apply: false,
      });
      const third = repairSnapshotStep(tx, repairs, {
        after: second.after,
        excluding: new Set(),
        apply: false,
      });

      expect([first, second, third]).toStrictEqual([
        { done: false, after: retired.entry_id, changed: false },
        { done: false, after: different.entry_id, changed: false },
        { done: false, after: matching.entry_id, changed: true },
      ]);
      expect(refs(current(tx, matching.entry_id))).toStrictEqual(['x']);
    });
  });

  it('reconstructs its cursor from SQLite and rolls back cursor plus snapshot together', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 2);
      const firstId = rows[0]?.entry_id;
      if (firstId === undefined) throw new Error('missing fixture entry');
      const job = begin(tx);
      storage.transactionSync(() => {
        return advanceFixtureCommit({ ...tx, revision: readRevision(tx.sql) + 1 }, job);
      });
      const resumed = readRepairJob(tx.sql);
      if (resumed === undefined) throw new Error('missing durable cursor');

      expect(resumed).toMatchObject({ after: firstId, phase: 'preflight' });
      expect(refs(current(tx, firstId))).toStrictEqual(['x']);

      // Recreate every next step from the saved row, as an alarm on another instance must.
      while (readRepairJob(tx.sql)?.phase === 'preflight') {
        const saved = readRepairJob(tx.sql)!;
        try {
          storage.transactionSync(() => {
            return advanceFixtureCommit({ ...tx, revision: readRevision(tx.sql) + 1 }, saved);
          });
        } catch (error) {
          if (!(error instanceof RepairPublicationProbed)) throw error;
          storage.transactionSync(() => {
            advanceRepairJob(tx.sql, error.next);
          });
        }
      }
      const applying = readRepairJob(tx.sql)!;

      expect(() => {
        return storage.transactionSync(() => {
          advanceFixtureCommit({ ...tx, revision: readRevision(tx.sql) + 1 }, applying);
          throw new Error('injected interruption after the snapshot update');
        });
      }).toThrow('injected interruption after the snapshot update');
      expect({
        after: readRepairJob(tx.sql)?.after,
        refs: refs(current(tx, firstId)),
      }).toStrictEqual({
        after: '',
        refs: ['x'],
      });

      storage.transactionSync(() => {
        return advanceFixtureCommit({ ...tx, revision: readRevision(tx.sql) + 1 }, applying);
      });

      expect({
        after: readRepairJob(tx.sql)?.after,
        changed: refs(current(tx, firstId)),
        untouched: refs(current(tx, rows[1]?.entry_id ?? 'missing')),
      }).toStrictEqual({ after: firstId, changed: [NEXT], untouched: ['x'] });
    });
  });

  it('refuses a growing near-limit header before changing any snapshot or failure observation', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 1);
      const entryId = rows[0]?.entry_id;
      if (entryId === undefined) throw new Error('missing fixture entry');
      const old = current(tx, entryId);
      const owner = requireEntry(tx.sql, entryId);
      const outputs = generationOutputs(old);
      let low = 0;
      let high = MAX_PACK_HEADER_BYTES;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = { ...old, headers: JSON.stringify({ 'x-padding': 'x'.repeat(middle) }) };
        if (
          unwritableRecord(
            headerFieldsOf(tx, owner, candidate, outputs),
            tx.limits.maxRecordBytes,
          ) === undefined
        )
          low = middle;
        else high = middle;
      }
      tx.sql.exec(
        `UPDATE generations SET headers = ? WHERE generation_id = ?`,
        JSON.stringify({ 'x-padding': 'x'.repeat(low) }),
        old.generation_id,
      );
      rememberArtifactFailure(tx.sql, { sha256: SHA, byteLength: 1, storageRef: 'x' });
      const marker = artifactRepairMarker(tx.sql, SHA);
      const selected = {
        ...group(),
        failureMarkers: marker === undefined ? [] : [[SHA, marker] as [string, string]],
      };
      const job = begin(tx, selected);
      const outcome = storage.transactionSync(() => {
        return advanceFixtureCommit({ ...tx, revision: readRevision(tx.sql) + 1 }, job);
      });

      expect(outcome).toMatchObject({
        kind: 'completed',
        value: { kind: 'refused', code: 'too_large' },
      });
      expect(refs(current(tx, entryId))).toStrictEqual(['x']);
      expect(artifactRepairMarker(tx.sql, SHA)).toBe(marker);
    });
  });

  it('rolls an actual provider row-limit probe back before any group is applied', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 2);
      const target = rows[0]?.entry_id;
      const untouched = rows[1]?.entry_id;
      if (target === undefined || untouched === undefined)
        throw new Error('missing fixture entries');
      const before = current(tx, target);
      const outputs = generationOutputs(before);
      const padded = (length: number): string => {
        return JSON.stringify(
          outputs.map((output) => {
            return { ...output, headers: { 'x-output-only-padding': 'x'.repeat(length) } };
          }),
        );
      };
      // The provider's actual configured row limit is the contract. Discover its boundary rather
      // than introducing a new protocol ceiling or assuming that a local runtime uses production's.
      const maximumFixturePadding = 12 * 1024 * 1024;
      const fits = (length: number): boolean => {
        try {
          storage.transactionSync(() => {
            return tx.sql.exec(
              `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
              padded(length),
              before.generation_id,
            );
          });
          return true;
        } catch (error) {
          if (!(error instanceof Error) || !/\bSQLITE_TOOBIG\b/u.test(error.message)) throw error;
          return false;
        }
      };
      if (fits(maximumFixturePadding))
        throw new Error('the configured SQL row limit exceeds the fixture search window');
      let low = 0;
      let high = maximumFixturePadding;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (fits(middle)) low = middle;
        else high = middle;
      }
      storage.transactionSync(() => {
        return tx.sql.exec(
          `UPDATE generations SET outputs = ? WHERE generation_id = ?`,
          padded(low),
          before.generation_id,
        );
      });
      const originalLength = current(tx, target).outputs.length;
      rememberArtifactFailure(tx.sql, { sha256: SHA, byteLength: 1, storageRef: 'x' });
      const marker = artifactRepairMarker(tx.sql, SHA);
      const job = begin(tx);
      const original = current(tx, target);
      const originalOutputs = generationOutputs(original);
      const headerFits = unwritableRecord(
        headerFieldsOf(tx, requireEntry(tx.sql, target), original, originalOutputs),
        tx.limits.maxRecordBytes,
      );

      expect(headerFits).toBeUndefined();
      expect(() => {
        return storage.transactionSync(() => {
          return advanceFixtureCommit({ ...tx, revision: readRevision(tx.sql) + 1 }, job);
        });
      }).toThrow(RepairRowTooLargeError);
      expect(readRepairJob(tx.sql)?.after).toBe('');
      expect(current(tx, target).outputs).toHaveLength(originalLength);
      expect(refs(current(tx, target))).toStrictEqual(['x']);
      expect(refs(current(tx, untouched))).toStrictEqual(['x']);
      expect(artifactRepairMarker(tx.sql, SHA)).toBe(marker);
    });
  });

  it('keeps an accepted failure pinned against older verification and preserves a newer ABA marker', async () => {
    await inScope(async (tx, storage) => {
      await seed(tx, storage, 1);
      const identity = { sha256: SHA, byteLength: 1, storageRef: 'x' };
      rememberArtifactFailure(tx.sql, identity);
      const observed = artifactVerification(tx.sql, identity);
      if (observed === undefined) throw new Error('missing failure proof');
      const selected = {
        ...group(),
        failureMarkers: [[SHA, observed.failureMarker] as [string, string]],
      };
      const job = begin(tx, selected);
      forgetVerifiedArtifactFailures(tx.sql, [observed]);

      expect(artifactRepairMarker(tx.sql, SHA)).toBe(observed.failureMarker);

      rememberArtifactFailure(tx.sql, identity);
      const newer = artifactRepairMarker(tx.sql, SHA);
      releaseRepairGroup(tx.sql, job.id, selected, true);

      expect(newer).not.toBe(observed.failureMarker);
      expect(artifactRepairMarker(tx.sql, SHA)).toBe(newer);
    });
  });

  it('round-trips surrogate pairs across metadata chunks without imposing a new batch limit', async () => {
    await inScope((tx) => {
      const job = begin(tx);
      const value = { text: '🪶'.repeat(70_000), tail: 'retained' };
      writeRepairValue(tx.sql, job.id, 'unicode', value);
      const chunks = tx.sql
        .exec<{ value: string }>(
          `SELECT value FROM meta WHERE key >= ? AND key < ?`,
          `artifact_repair_data:${job.id}:unicode:`,
          `artifact_repair_data:${job.id}:unicode:\u{FFFF}`,
        )
        .toArray();

      expect(chunks.length).toBeGreaterThan(2);
      expect(readRepairValue(tx.sql, job.id, 'unicode')).toStrictEqual(value);
      expect(
        chunks.every((chunk) => new TextEncoder().encode(chunk.value).byteLength < 2_000_000),
      ).toBe(true);
    });
  });

  it('bounds cleanup while retaining the durable completion answer', async () => {
    await inScope((tx) => {
      const job = begin(tx);
      writeRepairValue(tx.sql, job.id, 'large', 'x'.repeat(40 * 65_536));
      releaseRepairGroup(tx.sql, job.id, group());
      completeRepairJob(
        tx.sql,
        job,
        { value: { kind: 'published', generationId: 'finished' }, own: null },
        NOW,
      );
      const before = tx.sql
        .exec<{ total: number }>(
          `SELECT COUNT(*) AS total FROM meta WHERE key >= ? AND key < ?`,
          `artifact_repair_data:${job.id}:`,
          `artifact_repair_data:${job.id}:\u{FFFF}`,
        )
        .one().total;
      const more = collectRepairGarbage(tx.sql, NOW);
      const after = tx.sql
        .exec<{ total: number }>(
          `SELECT COUNT(*) AS total FROM meta WHERE key >= ? AND key < ?`,
          `artifact_repair_data:${job.id}:`,
          `artifact_repair_data:${job.id}:\u{FFFF}`,
        )
        .one().total;

      expect(more).toBe(true);
      expect(before - after).toBeLessThanOrEqual(32);
      expect(after).toBeGreaterThan(0);
      expect(repairJobResult(tx.sql, job.id)).toStrictEqual({
        value: { kind: 'published', generationId: 'finished' },
        own: null,
      });
      expect(readRepairJob(tx.sql)).toBeUndefined();
    });
  });

  it('captures pending projections across every revision in a completed job', async () => {
    await inScope(async (tx, storage) => {
      const rows = await seed(tx, storage, 3);
      for (const [index, row] of rows.entries()) {
        tx.sql.exec(
          `UPDATE entries SET revision = ?, record_revision = ?, kv_revision = 0 WHERE entry_id = ?`,
          10 + index,
          10 + index,
          row.entry_id,
        );
      }
      const own = ownRepairRecordsOf(tx.sql, 10, 12);

      expect(own.first).toStrictEqual(rows.map((row) => row.entry_id));
      expect(own.repairWindow).toStrictEqual({
        fromRevision: 10,
        firstAfter: { revision: 12, entryId: rows[2]?.entry_id },
      });
    });
  });
});
