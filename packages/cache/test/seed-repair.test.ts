import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  artifactIdFor,
  buildGenerationIdFor,
  decodeGenerationPack,
  deriveEntry,
  kvGenerationKey,
  MAX_PACK_HEADER_BYTES,
  type OutputSnapshot,
  policyFromBuild,
  r2BlobKey,
} from '@stayingupwind/core/cache';
import { createId, decodeUtf8, encodeUtf8 } from '@stayingupwind/core/util';
import type { SeedEntriesResult, SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { type EventInput, NO_HISTORY } from '../src/scope/history.ts';
import { MutationPipeline } from '../src/scope/mutation-pipeline.ts';
import { commitMutation, runMutationPreflight, ScopeQueue } from '../src/scope/mutations.ts';
import { headerFieldsOf, recordBytesOf, unwritableRecord } from '../src/scope/records.ts';
import { repairEventHistory } from '../src/scope/repair-events.ts';
import {
  advanceRepairFinalization,
  beginRepairFinalization,
} from '../src/scope/repair-finalize.ts';
import {
  advanceRepairJob,
  completeRepairJob,
  isRepairPending,
  hasRepairValue,
  readRepairJob,
  readRepairValue,
  type RepairJob,
} from '../src/scope/repair-jobs.ts';
import { RepairPublicationProbed } from '../src/scope/repair-probes.ts';
import { RepairRunner } from '../src/scope/repair-runner.ts';
import {
  type EntryRow,
  type EntryStateRow,
  type GenerationRow,
  generationOutputs,
  toEntryState,
} from '../src/scope/rows.ts';
import { prepareSeedPublication } from '../src/scope/seed-repair-job.ts';
import { seedLocationKey, verifySeedLocations } from '../src/scope/seed-repair.ts';
import { advancePreparedSeed, planSeedEntries } from '../src/scope/seed.ts';
import { isRefusal, readRevision, type Refusal } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import type { TxInput } from '../src/scope/tx.ts';
import { withRepairAlarms } from './support/repair-alarm.ts';

const NOW = 1_800_000_000_000;
const HTML_TYPE = 'text/html; charset=utf-8';
const BODY = '<html>the build</html>';
const VERIFIED_READERS = Object.fromEntries(
  ['edge', 'authority', 'gateway', 'readGateway'].map((name) => {
    return [name, { versionId: 'reviewed', moduleSha256: 'a'.repeat(64) }];
  }),
);

async function scopeForTest(compact = false) {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await stub.seedScope(
    {
      scope: {
        scopeId,
        organizationId: 'org_site',
        projectId: 'site',
        environmentId: 'production',
        deploymentId: scopeId,
        keySchemaVersion: 1,
        buildId: 'build-site',
      },
      ...(compact && {
        generationPackReaders: JSON.stringify({
          schemaVersion: 2,
          rolloutId: 'verified-seed-test',
          deploymentId: scopeId,
          buildId: 'build-site',
          platform: VERIFIED_READERS,
          consumers: [
            {
              name: 'app',
              mainModule: 'main.mjs',
              mainModuleSha256: 'a'.repeat(64),
              hostIdentity: 'reviewed-host',
              hostModuleSha256: 'a'.repeat(64),
            },
          ],
        }),
      }),
    },
    NOW,
  );
  return { scopeId, stub };
}

type Scope = Awaited<ReturnType<typeof scopeForTest>>;

async function planFor(scope: Scope, pathname = '/', body = BODY) {
  const descriptor = { kind: 'app-page' as const, route: pathname, pathname };
  const { entryId } = await deriveEntry(scope.scopeId, descriptor);
  const generationId = await buildGenerationIdFor(scope.scopeId, entryId);
  const bytes = encodeUtf8(body);
  const sha256 = await sha256Hex(bytes);
  const storageRef = `build/${scope.scopeId}/${sha256}`;
  await env.ARTIFACTS.put(storageRef, bytes as BufferSource);
  const artifact = {
    role: 'html' as const,
    sha256,
    byteLength: bytes.byteLength,
    contentType: HTML_TYPE,
    encoding: 'identity' as const,
    storageRef,
  };
  const seed: SeedEntryInput = {
    descriptor,
    groupInstanceId: null,
    generation: {
      generationId,
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': HTML_TYPE },
      tags: [],
      dependencyCoverage: 'complete',
      outputs: [
        {
          representationKey: 'html',
          pathname,
          status: 200,
          headers: { 'content-type': HTML_TYPE },
          compute: 'static',
          response: 'complete',
          htmlSize: bytes.byteLength,
          artifacts: [artifact],
        },
      ],
    },
  };
  return { seed, entryId, generationId, artifact };
}

type Plan = Awaited<ReturnType<typeof planFor>>;

function atLocation(plan: Plan, storageRef: string): SeedEntryInput {
  return {
    ...plan.seed,
    generation: {
      ...plan.seed.generation,
      outputs: plan.seed.generation.outputs.map((output) => {
        return {
          ...output,
          artifacts: output.artifacts.map((artifact) => ({ ...artifact, storageRef })),
        };
      }),
    },
  };
}

function seedBatch(scope: Scope, entries: readonly SeedEntryInput[]) {
  return withRepairAlarms(
    scope.stub,
    scope.stub.seedEntries({ scopeId: scope.scopeId, batchIndex: 0, entries: [...entries] }, NOW),
  );
}

async function withSharedRsc(scope: Scope, plan: Plan, storageRef: string) {
  const bytes = encodeUtf8('the shared RSC');
  const sha256 = await sha256Hex(bytes);
  const artifact = {
    ...plan.artifact,
    role: 'rsc' as const,
    sha256,
    byteLength: bytes.byteLength,
    contentType: 'text/x-component',
    storageRef,
  };
  plan.seed.generation.outputs[0]?.artifacts.push(artifact);
  return { artifact, artifactId: await artifactIdFor(scope.scopeId, sha256), bytes };
}

async function recordFor(scope: Scope, entryId: string) {
  const stored = await env.CACHE_STATE.get(kvGenerationKey(scope.scopeId, entryId), 'arrayBuffer');
  if (stored === null) throw new Error('the entry has no delivery record');
  const decoded = decodeGenerationPack(new Uint8Array(stored));
  if (decoded.kind !== 'ok') throw new Error(`the delivery record is ${decoded.kind}`);
  return decoded.pack;
}

function rscOf(seed: SeedEntryInput) {
  const artifact = seed.generation.outputs[0]?.artifacts.find((item) => item.role === 'rsc');
  if (artifact === undefined) throw new Error('the test seed has no RSC artifact');
  return artifact;
}

function rowsFor(scope: Scope, plan: Plan, sha256 = plan.artifact.sha256) {
  return runInDurableObject(scope.stub, (_instance, state) => {
    return {
      revision: state.storage.sql.exec<{ revision: number }>(`SELECT revision FROM scope`).one()
        .revision,
      entry: state.storage.sql
        .exec<{
          kv_revision: number;
          record_revision: number;
          current_generation_id: string;
          regeneration_attempt_id: string | null;
        }>(`SELECT * FROM entries WHERE entry_id = ?`, plan.entryId)
        .one(),
      generation: state.storage.sql
        .exec<GenerationRow>(`SELECT * FROM generations WHERE generation_id = ?`, plan.generationId)
        .one(),
      artifact: state.storage.sql
        .exec<{ storage_ref: string; owned: number; refs: number }>(
          `SELECT storage_ref, owned, refs FROM artifacts WHERE sha256 = ?`,
          sha256,
        )
        .one(),
    };
  });
}

function relocatedArtifact(
  outputs: readonly OutputSnapshot[],
  sha256: string,
  storageRef: string,
): OutputSnapshot[] {
  return outputs.map((output) => {
    const artifacts = output.artifacts.map((artifact) => {
      const located = artifact.sha256 === sha256 ? { ...artifact, storageRef } : artifact;
      return located;
    });
    return { ...output, artifacts };
  });
}

async function badLocationFor(
  scope: Scope,
  fault: string,
  byteLength = encodeUtf8(BODY).byteLength,
) {
  const location = `bad/${scope.scopeId}`;
  if (fault === 'corrupt')
    await env.ARTIFACTS.put(location, new Uint8Array(byteLength) as BufferSource);
  return location;
}

async function lease(scope: Scope, plan: Plan) {
  const started = await scope.stub.startAttempt(
    { entry: plan.seed.descriptor, reason: 'miss' },
    NOW,
  );
  if (started.kind !== 'leased') throw new Error(`the attempt is ${started.kind}`);
  return started;
}

async function damageBlob(plan: Plan, fault: string): Promise<void> {
  if (fault === 'missing') await env.ARTIFACTS.delete(plan.artifact.storageRef);
  else {
    await env.ARTIFACTS.put(
      plan.artifact.storageRef,
      new Uint8Array(plan.artifact.byteLength) as BufferSource,
    );
  }
}

function failureFor(scope: Scope, plan: Plan) {
  return runInDurableObject(scope.stub, (_instance, state) => {
    return (
      state.storage.sql
        .exec<{ value: string }>(
          `SELECT value FROM meta WHERE key = ?`,
          `seed_artifact_failure:${plan.entryId}`,
        )
        .toArray()[0]?.value ?? null
    );
  });
}

interface RecordedEvent {
  readonly revision: number;
  readonly event: EventInput;
}

function byEntity(left: RecordedEvent, right: RecordedEvent): number {
  return left.event.entityId.localeCompare(right.event.entityId);
}

/** Probe success must leave the outer transaction before its durable phase can advance. */
function advanceSeedStep(
  storage: DurableObjectStorage,
  tx: Omit<TxInput, 'revision'>,
  job: RepairJob,
) {
  const input: TxInput = {
    ...tx,
    now: job.preparedAt,
    limits: job.limits,
    revision: job.fromRevision,
    stageRepairRecords: true,
  };
  try {
    return storage.transactionSync(() => {
      if (job.finalizing !== undefined) {
        const step = advanceRepairFinalization(input, job);
        return step.kind === 'pending'
          ? step
          : {
              kind: 'completed' as const,
              value: readRepairValue<SeedEntriesResult | Refusal>(
                storage.sql,
                job.id,
                'pending-result',
              ),
            };
      }
      return advancePreparedSeed(
        job.phase === 'preflight'
          ? input
          : { ...input, history: repairEventHistory(input, job.id) },
        job,
      );
    });
  } catch (error) {
    if (!(error instanceof RepairPublicationProbed)) throw error;
    const current = readRepairJob(storage.sql);
    if (current?.id !== job.id || current.phase !== 'preflight') throw error;
    storage.transactionSync(() => {
      advanceRepairJob(storage.sql, error.next);
    });
    return { kind: 'pending' } as const;
  }
}

/** Reconstruct every step from SQLite, just as a new alarm invocation does after a reset. */
function drainSeedJob(storage: DurableObjectStorage, tx: Omit<TxInput, 'revision'>) {
  const { sql } = storage;
  for (let index = 0; index < 500; index += 1) {
    const job = readRepairJob(sql);
    if (job === undefined) throw new Error('the expected seed continuation disappeared');
    const step = advanceSeedStep(storage, tx, job);
    if (step.kind === 'completed') {
      if (job.finalizing === undefined && !isRefusal(step.value)) {
        storage.transactionSync(() => {
          beginRepairFinalization({ ...tx, revision: job.fromRevision }, job, step.value);
        });
        continue;
      }
      storage.transactionSync(() => {
        completeRepairJob(sql, job, { value: step.value, own: null }, tx.now);
      });
      return step.value;
    }
  }
  throw new Error('the bounded seed continuation did not finish');
}

async function observedSeedRepair(scope: Scope, plans: readonly Plan[], revision: number) {
  const proofs = new Map<string, boolean>();
  await verifySeedLocations(
    (key) => env.ARTIFACTS.get(key),
    plans.map((plan) => plan.artifact),
    proofs,
  );
  return runInDurableObject(scope.stub, async (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(
      'CREATE TABLE seed_test_history (ordinal INTEGER PRIMARY KEY, revision INTEGER, payload TEXT)',
    );
    const historyHost = {
      ...NO_HISTORY,
      append: (context: { readonly revision: number }, event: EventInput) => {
        sql.exec(
          'INSERT INTO seed_test_history (revision, payload) VALUES (?, ?)',
          context.revision,
          JSON.stringify(event),
        );
      },
    };
    const apply = await planSeedEntries(
      {
        sql,
        scopeId: scope.scopeId,
        limits: limitsOf(parseVars({})),
        now: NOW + 1,
        revision,
        history: historyHost,
      },
      {
        scopeId: scope.scopeId,
        batchIndex: 0,
        entries: plans.map((plan) => plan.seed),
      },
      proofs,
    );
    runMutationPreflight(state.storage, apply);
    const prepared = state.storage.transactionSync(apply);
    const result = isRepairPending(prepared)
      ? drainSeedJob(state.storage, {
          sql,
          scopeId: scope.scopeId,
          limits: limitsOf(parseVars({})),
          now: NOW + 1,
          history: historyHost,
        })
      : prepared;
    const states = Array.from(
      sql.exec<EntryStateRow>(`SELECT * FROM entries ORDER BY entry_id`),
      (entry): RecordedEvent => {
        return {
          revision: entry.revision,
          event: {
            entityType: 'entry',
            entityId: entry.entry_id,
            kind: 'entry.state.changed',
            payload: { entryState: toEntryState(entry) },
          },
        };
      },
    );
    const rows = sql
      .exec<{ revision: number; payload: string }>(
        'SELECT revision, payload FROM seed_test_history ORDER BY ordinal',
      )
      .toArray();
    const history: RecordedEvent[] = rows.map((row) => ({
      revision: row.revision,
      event: JSON.parse(row.payload) as EventInput,
    }));
    sql.exec('DROP TABLE seed_test_history');
    return { result, history, states };
  });
}

describe('a seed whose artifact projection could not read', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['missing', 'corrupt'])(
    'immediately reprojects an unchanged seed after its same-key %s blob is restored',
    async (fault) => {
      const scope = await scopeForTest();
      const plan = await planFor(scope);
      await damageBlob(plan, fault);
      await seedBatch(scope, [plan.seed]);
      const before = await rowsFor(scope, plan);

      expect(before.entry.kv_revision).toBe(0);
      await expect(failureFor(scope, plan)).resolves.toBe(plan.generationId);

      await env.ARTIFACTS.put(plan.artifact.storageRef, encodeUtf8(BODY) as BufferSource);
      await seedBatch(scope, [plan.seed]);

      const after = await rowsFor(scope, plan);

      expect(after.generation.outputs).toBe(before.generation.outputs);
      expect(after.entry.kv_revision).toBe(after.entry.record_revision);
      expect(after.entry.record_revision).toBeGreaterThan(before.entry.record_revision);
      expect(decodeUtf8((await recordFor(scope, plan.entryId)).html)).toBe(BODY);
      await expect(failureFor(scope, plan)).resolves.toBeNull();
    },
  );

  it('records another failed projection when a shared proposal keeps its missing canonical key', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first');
    const second = await planFor(scope, '/second');
    const canonical = `missing/canonical/${scope.scopeId}`;
    await seedBatch(scope, [atLocation(first, canonical), atLocation(second, canonical)]);
    const before = await rowsFor(scope, first);

    await expect(failureFor(scope, first)).resolves.toBe(first.generationId);

    await seedBatch(scope, [atLocation(first, `missing/proposal/${scope.scopeId}`)]);

    const failed = await rowsFor(scope, first);

    expect(failed.generation.outputs).toBe(before.generation.outputs);
    expect(failed.entry.record_revision).toBeGreaterThan(before.entry.record_revision);
    expect(failed.entry.kv_revision).toBe(0);
    await expect(failureFor(scope, first)).resolves.toBe(first.generationId);

    await env.ARTIFACTS.put(canonical, encodeUtf8(BODY) as BufferSource);
    await seedBatch(scope, [atLocation(first, canonical)]);

    const repaired = await rowsFor(scope, first);

    expect(repaired.entry.kv_revision).toBe(repaired.entry.record_revision);
    expect(decodeUtf8((await recordFor(scope, first.entryId)).html)).toBe(BODY);
    await expect(failureFor(scope, first)).resolves.toBeNull();
  });

  it('uses one verified canonical location for duplicate SHA roles in a generation', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    plan.seed.generation.outputs[0]?.artifacts.push({ ...plan.artifact, role: 'rsc' });
    await seedBatch(scope, [atLocation(plan, 'missing/shared')]);
    const retry = atLocation(plan, 'missing/shared');
    rscOf(retry).storageRef = plan.artifact.storageRef;

    await seedBatch(scope, [retry]);

    expect(decodeUtf8((await recordFor(scope, plan.entryId)).html)).toBe(BODY);
    await expect(rowsFor(scope, plan)).resolves.toMatchObject({
      artifact: { owned: 0, refs: 2, storage_ref: plan.artifact.storageRef },
    });
  });

  it.each(['unchanged', 'invalid', 'valid'] as const)(
    'reuses the advanced canonical location for a later %s proposal',
    async (proposal) => {
      const scope = await scopeForTest();
      const first = await planFor(scope, '/first');
      const second = await planFor(scope, '/second');
      const locations = {
        unchanged: `missing/shared/${scope.scopeId}`,
        invalid: `missing/proposed/${scope.scopeId}`,
        valid: `build/alternate/${scope.scopeId}`,
      };
      await env.ARTIFACTS.put(locations.valid, BODY);
      await seedBatch(scope, [
        atLocation(first, locations.unchanged),
        atLocation(second, locations.unchanged),
      ]);

      await seedBatch(scope, [first.seed, atLocation(second, locations[proposal])]);

      expect(decodeUtf8((await recordFor(scope, first.entryId)).html)).toBe(BODY);
      expect(decodeUtf8((await recordFor(scope, second.entryId)).html)).toBe(BODY);
      await expect(rowsFor(scope, second)).resolves.toMatchObject({
        artifact: { owned: 0, refs: 2, storage_ref: first.artifact.storageRef },
      });
    },
  );

  it('prepares shared verification without recording anything, then rechecks a newer lease', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first');
    const fresh = await planFor(scope, '/fresh');
    await seedBatch(scope, [atLocation(first, 'missing/shared')]);
    const batch = { scopeId: scope.scopeId, batchIndex: 0, entries: [first.seed, fresh.seed] };
    const prepared = await runInDurableObject(scope.stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const snapshot = () => {
        return [
          sql.exec(`SELECT * FROM scope`).toArray(),
          sql.exec(`SELECT * FROM entries ORDER BY entry_id`).toArray(),
          sql.exec(`SELECT * FROM generations ORDER BY generation_id`).toArray(),
          sql.exec(`SELECT * FROM artifacts ORDER BY artifact_id`).toArray(),
          sql.exec(`SELECT * FROM meta ORDER BY key`).toArray(),
        ];
      };
      const before = snapshot();
      const apply = await planSeedEntries(
        {
          sql,
          scopeId: scope.scopeId,
          limits: limitsOf(parseVars({})),
          now: NOW,
          revision: 100,
          history: {
            ...NO_HISTORY,
            append: () => {
              throw new Error('preparation recorded history');
            },
          },
        },
        batch,
      );
      const result = state.storage.transactionSync(apply);
      return { before, after: snapshot(), result };
    });

    expect(prepared.after).toStrictEqual(prepared.before);
    expect(prepared.result).toMatchObject({
      kind: 'verify-seed-locations',
      locations: [first.artifact],
    });

    await lease(scope, first);
    const before = await rowsFor(scope, first);
    const result = await runInDurableObject(scope.stub, async (_instance, state) => {
      const apply = await planSeedEntries(
        {
          sql: state.storage.sql,
          scopeId: scope.scopeId,
          limits: limitsOf(parseVars({})),
          now: NOW,
          revision: before.revision + 1,
          history: NO_HISTORY,
        },
        { ...batch, entries: [first.seed] },
        new Map([[seedLocationKey(first.artifact), true]]),
      );
      return state.storage.transactionSync(apply);
    });

    expect(result).toMatchObject({ inserted: 0, skipped: 1, revision: before.revision });
    await expect(rowsFor(scope, first)).resolves.toStrictEqual(before);
  });

  it('repairs a shared side artifact while another unacknowledged reference is outside the batch', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first', '<html>first</html>');
    const second = await planFor(scope, '/second', '<html>second</html>');
    const sharedRef = `shared/${scope.scopeId}`;
    const shared = await withSharedRsc(scope, first, sharedRef);
    await withSharedRsc(scope, second, sharedRef);
    await env.ARTIFACTS.put(sharedRef, shared.bytes as BufferSource);
    await seedBatch(scope, [atLocation(first, 'missing/all'), atLocation(second, 'missing/all')]);
    const secondBefore = await rowsFor(scope, second, shared.artifact.sha256);

    await seedBatch(scope, [first.seed]);
    const firstAfter = await rowsFor(scope, first);
    const secondAfter = await rowsFor(scope, second, shared.artifact.sha256);
    const outputs = relocatedArtifact(
      generationOutputs(secondBefore.generation),
      shared.artifact.sha256,
      sharedRef,
    );

    await expect(scope.stub.artifact(shared.artifactId)).resolves.toMatchObject({
      storageRef: sharedRef,
    });
    expect(secondAfter).toStrictEqual({
      ...secondBefore,
      revision: firstAfter.revision,
      entry: {
        ...secondBefore.entry,
        revision: secondAfter.entry.record_revision,
        record_revision: secondAfter.entry.record_revision,
      },
      generation: { ...secondBefore.generation, outputs: JSON.stringify(outputs) },
      artifact: { ...secondBefore.artifact, storage_ref: sharedRef },
    });
    expect(secondAfter.entry.record_revision).toBeGreaterThan(secondBefore.entry.record_revision);
    expect(secondAfter.entry.record_revision).toBe(firstAfter.entry.record_revision);
    expect(decodeUtf8((await recordFor(scope, first.entryId)).html)).toBe('<html>first</html>');

    await seedBatch(scope, [second.seed]);

    const projected = await rowsFor(scope, second, shared.artifact.sha256);

    expect({
      body: decodeUtf8((await recordFor(scope, second.entryId)).html),
      caughtUp: projected.entry.kv_revision === projected.entry.record_revision,
      artifact: projected.artifact,
    }).toStrictEqual({
      body: '<html>second</html>',
      caughtUp: true,
      artifact: { ...secondBefore.artifact, storage_ref: sharedRef },
    });
  });

  it.each(['missing', 'corrupt'])(
    "keeps an acknowledged entry's shared RSC location when another retry proposes %s bytes",
    async (fault) => {
      const scope = await scopeForTest();
      const healthy = await planFor(scope, '/healthy', '<html>healthy</html>');
      const failed = await planFor(scope, '/failed', '<html>failed</html>');
      const sharedRef = `shared/${scope.scopeId}`;
      const shared = await withSharedRsc(scope, healthy, sharedRef);
      await withSharedRsc(scope, failed, sharedRef);
      await env.ARTIFACTS.put(sharedRef, shared.bytes as BufferSource);
      await seedBatch(scope, [healthy.seed]);
      const broken = atLocation(failed, 'missing/html');
      rscOf(broken).storageRef = sharedRef;
      await seedBatch(scope, [broken]);
      const before = await rowsFor(scope, healthy);
      const beforeRecord = await recordFor(scope, healthy.entryId);
      const changed = atLocation(failed, failed.artifact.storageRef);
      rscOf(changed).storageRef = await badLocationFor(scope, fault, shared.bytes.byteLength);

      await seedBatch(scope, [changed]);

      await expect(scope.stub.artifact(shared.artifactId)).resolves.toMatchObject({
        storageRef: sharedRef,
      });
      await expect(rowsFor(scope, healthy)).resolves.toMatchObject({
        entry: before.entry,
        generation: before.generation,
      });
      await expect(recordFor(scope, healthy.entryId)).resolves.toStrictEqual(beforeRecord);
      expect(decodeUtf8((await recordFor(scope, failed.entryId)).html)).toBe('<html>failed</html>');

      const row = await runInDurableObject(scope.stub, (_instance, state) => {
        return state.storage.sql
          .exec<{ storage_ref: string; owned: number; refs: number }>(
            `SELECT storage_ref, owned, refs FROM artifacts WHERE sha256 = ?`,
            shared.artifact.sha256,
          )
          .one();
      });

      expect(row).toStrictEqual({ storage_ref: sharedRef, owned: 0, refs: 2 });
    },
  );

  it.each([-1, 1])(
    'refuses an artifact whose declared length differs by %i bytes',
    async (difference) => {
      const scope = await scopeForTest();
      const plan = await planFor(scope);
      plan.artifact.byteLength += difference;
      await seedBatch(scope, [plan.seed]);

      await expect(
        env.CACHE_STATE.get(kvGenerationKey(scope.scopeId, plan.entryId)),
      ).resolves.toBeNull();
      await expect(rowsFor(scope, plan)).resolves.toMatchObject({ entry: { kv_revision: 0 } });

      const failure = await runInDurableObject(scope.stub, (_instance, state) => {
        return state.storage.sql
          .exec<{ value: string }>(
            `SELECT value FROM meta WHERE key = ?`,
            `seed_artifact_failure:${plan.entryId}`,
          )
          .one().value;
      });

      expect(failure).toBe(plan.generationId);
    },
  );

  it('keeps the failed generation unchanged when a retry names other bytes', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    await seedBatch(scope, [atLocation(plan, 'missing/build')]);
    const before = await rowsFor(scope, plan);
    const changed = atLocation(plan, plan.artifact.storageRef);
    for (const output of changed.generation.outputs) {
      for (const artifact of output.artifacts) artifact.sha256 = 'f'.repeat(64);
    }

    await expect(seedBatch(scope, [changed])).resolves.toMatchObject({
      inserted: 0,
      skipped: 1,
      revision: before.revision,
    });
    await expect(rowsFor(scope, plan)).resolves.toStrictEqual(before);
  });

  it.each(['missing', 'corrupt'])(
    'repairs a %s location shared by build entries on a corrected retry',
    async (fault) => {
      const scope = await scopeForTest();
      const first = await planFor(scope, '/first');
      const second = await planFor(scope, '/second');
      const badLocation = await badLocationFor(scope, fault);
      const seeded = await seedBatch(scope, [
        atLocation(first, badLocation),
        atLocation(second, badLocation),
      ]);
      const before = await rowsFor(scope, first);

      expect(seeded).toMatchObject({ inserted: 2, skipped: 0, refused: [] });
      expect(before).toMatchObject({
        entry: { kv_revision: 0 },
        artifact: { owned: 0, refs: 2, storage_ref: badLocation },
      });

      const retried = await seedBatch(scope, [first.seed, second.seed]);
      const repaired = await rowsFor(scope, first);
      const record = await recordFor(scope, first.entryId);

      expect({ reply: retried, ...repaired }).toMatchObject({
        reply: { inserted: 0, skipped: 2, refused: [] },
        entry: {
          kv_revision: repaired.entry.record_revision,
          current_generation_id: first.generationId,
        },
        artifact: { owned: 0, refs: 2, storage_ref: first.artifact.storageRef },
      });
      expect({
        newer: repaired.entry.record_revision > before.entry.record_revision,
        committed: retried.revision >= repaired.entry.record_revision,
        projected: retried.revision <= repaired.revision,
      }).toStrictEqual({ newer: true, committed: true, projected: true });
      expect({
        generationId: record.header.generationId,
        html: decodeUtf8(record.html),
      }).toStrictEqual({
        generationId: first.generationId,
        html: BODY,
      });
      expect(decodeUtf8((await recordFor(scope, second.entryId)).html)).toBe(BODY);

      const previousOutputs = JSON.parse(before.generation.outputs) as [{ outputId: string }];
      const repairedOutputs = JSON.parse(repaired.generation.outputs) as [{ outputId: string }];

      expect(repairedOutputs[0].outputId).toBe(previousOutputs[0].outputId);
    },
  );

  it('records durable shared-repair states while retaining both seed generation events', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first');
    const second = await planFor(scope, '/second');

    const outside = await planFor(scope, '/outside');
    const badLocation = await badLocationFor(scope, 'missing');
    await seedBatch(scope, [
      atLocation(first, badLocation),
      atLocation(second, badLocation),
      atLocation(outside, badLocation),
    ]);
    const before = await rowsFor(scope, first);

    await expect(failureFor(scope, second)).resolves.toBe(second.generationId);

    const observed = await observedSeedRepair(scope, [first, second], before.revision + 1);
    const states = observed.history.filter(({ event }) => event.kind === 'entry.state.changed');
    const generations = observed.history.filter(
      ({ event }) => event.kind === 'generation.committed',
    );
    const repaired = await rowsFor(scope, outside);

    expect(observed.result).toStrictEqual({
      inserted: 0,
      skipped: 2,
      refused: [],
      revision: repaired.revision,
    });

    const finalStates = new Map(states.map((state) => [state.event.entityId, state]));

    expect([...finalStates.values()].toSorted(byEntity)).toStrictEqual(
      observed.states.toSorted(byEntity),
    );
    expect(new Set(states.map((state) => `${state.event.entityId}:${state.revision}`)).size).toBe(
      states.length,
    );
    expect(
      generations
        .map(({ event }) => event.entityId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(
      [first.generationId, second.generationId].toSorted((left, right) => {
        return left.localeCompare(right);
      }),
    );
    expect(states.length).toBeGreaterThanOrEqual(3);
    expect({ count: generations.length, artifact: repaired.artifact }).toStrictEqual({
      count: 2,
      artifact: {
        storage_ref: first.artifact.storageRef,
        owned: 0,
        refs: 3,
      },
    });
    expect(generationOutputs(repaired.generation)[0]?.artifacts[0]?.storageRef).toBe(
      first.artifact.storageRef,
    );
  });

  it('copies a v2 borrowed retry to a fresh fixed locator and reuses it for a later duplicate seed', async () => {
    const scope = await scopeForTest(true);
    const failed = await planFor(scope, '/failed');
    await seedBatch(scope, [atLocation(failed, 'x')]);
    await seedBatch(scope, [failed.seed]);
    const repaired = await rowsFor(scope, failed);
    const location = repaired.artifact.storage_ref;

    expect(location).toMatch(/^r\/[a-f0-9]{32}\/[a-f0-9]{32}$/u);
    expect(repaired.artifact).toMatchObject({ owned: 0, refs: 1 });

    const copied = await env.ARTIFACTS.get(location);
    const borrowed = await env.ARTIFACTS.get(failed.artifact.storageRef);

    await expect(copied?.text()).resolves.toBe(BODY);
    await expect(borrowed?.text()).resolves.toBe(BODY);

    const fresh = await planFor(scope, '/fresh');
    await seedBatch(scope, [atLocation(fresh, 'x')]);
    const duplicate = await rowsFor(scope, fresh);

    expect(duplicate.artifact).toMatchObject({ storage_ref: location, owned: 0, refs: 2 });
    expect(generationOutputs(duplicate.generation)[0]?.artifacts[0]?.storageRef).toBe(location);
    expect(
      Array.isArray(
        (JSON.parse(duplicate.generation.outputs) as { artifacts: unknown[] }[])[0]?.artifacts[0],
      ),
    ).toBe(true);
    expect(decodeUtf8((await recordFor(scope, fresh.entryId)).html)).toBe(BODY);
  });

  it.each(['missing', 'corrupt'])(
    'preserves a healthy fresh seed location after its canonical copy becomes %s',
    async (fault) => {
      const scope = await scopeForTest(true);
      const first = await planFor(scope, '/first');
      await seedBatch(scope, [atLocation(first, 'x')]);
      await seedBatch(scope, [first.seed]);
      const repaired = await rowsFor(scope, first);
      const copy = repaired.artifact.storage_ref;
      if (fault === 'missing') await env.ARTIFACTS.delete(copy);
      else await env.ARTIFACTS.put(copy, new Uint8Array(first.artifact.byteLength) as BufferSource);
      // The next projection supplies the existing checksum-verified failure observation.
      const probe = await planFor(scope, '/probe');
      await seedBatch(scope, [probe.seed]);

      await expect(failureFor(scope, probe)).resolves.toBe(probe.generationId);

      const fresh = await planFor(scope, '/fresh');
      await seedBatch(scope, [fresh.seed]);
      const rows = await rowsFor(scope, fresh);
      const record = await recordFor(scope, fresh.entryId);

      expect(generationOutputs(rows.generation)[0]?.artifacts[0]?.storageRef).toBe(
        fresh.artifact.storageRef,
      );
      expect(decodeUtf8(record.html)).toBe(BODY);
      expect(rows.artifact).toMatchObject({ storage_ref: copy, owned: 0, refs: 3 });
    },
  );

  it('resumes a shared seed repair from durable cursors and keeps fences until all publications finish', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first');
    const second = await planFor(scope, '/second');
    await seedBatch(scope, [atLocation(first, 'x'), atLocation(second, 'x')]);
    const prepared = await runInDurableObject(scope.stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const tx = {
        sql,
        scopeId: scope.scopeId,
        now: NOW + 1,
        limits: limitsOf(parseVars({})),
        revision: readRevision(sql) + 1,
        history: NO_HISTORY,
      };
      const apply = await planSeedEntries(
        tx,
        {
          scopeId: scope.scopeId,
          batchIndex: 0,
          entries: [first.seed, second.seed],
        },
        new Map([[seedLocationKey(first.artifact), true]]),
      );
      runMutationPreflight(state.storage, apply);
      const pending = state.storage.transactionSync(apply);
      if (!isRepairPending(pending)) throw new Error('expected a durable seed repair');
      // Lose this invocation after a committed shared-snapshot update, before its owner publishes.
      for (let index = 0; index < 20; index += 1) {
        const job = readRepairJob(sql);
        if (job === undefined) throw new Error('expected the active repair');
        advanceSeedStep(state.storage, tx, job);
        const latest = readRepairJob(sql);
        if (latest?.group === 0 && latest.phase === 'publish') break;
      }
      return {
        id: pending.jobId,
        job: readRepairJob(sql),
        failure: sql
          .exec<{ value: string }>(
            'SELECT value FROM meta WHERE key = ?',
            `artifact_failure:${first.artifact.sha256}`,
          )
          .one().value,
        pin: sql
          .exec<{ value: string }>(
            'SELECT value FROM meta WHERE key = ?',
            `artifact_repair_pin:${first.artifact.sha256}`,
          )
          .one().value,
      };
    });

    expect(prepared.job).toMatchObject({ group: 0, phase: 'publish' });
    expect(prepared.pin).toBe(prepared.id);
    expect(prepared.failure.length).toBeGreaterThan(0);

    const resumed = await runInDurableObject(scope.stub, (_instance, state) => {
      const sql = state.storage.sql;
      const restored = readRepairJob(sql);
      const result = drainSeedJob(state.storage, {
        sql,
        scopeId: scope.scopeId,
        now: NOW + 2,
        limits: limitsOf(parseVars({})),
        history: NO_HISTORY,
      });
      return {
        restored,
        result,
        remainingFences: sql
          .exec(
            'SELECT key FROM meta WHERE key IN (?, ?)',
            `artifact_failure:${first.artifact.sha256}`,
            `artifact_repair_pin:${first.artifact.sha256}`,
          )
          .toArray(),
      };
    });

    expect(resumed.restored).toStrictEqual(prepared.job);
    expect(resumed.result).toMatchObject({ inserted: 0, skipped: 2, refused: [] });
    expect(resumed.remainingFences).toStrictEqual([]);
    await expect(rowsFor(scope, first)).resolves.toMatchObject({
      artifact: { storage_ref: first.artifact.storageRef, owned: 0 },
    });

    const outside = await rowsFor(scope, second);

    expect(generationOutputs(outside.generation)[0]?.artifacts[0]?.storageRef).toBe(
      first.artifact.storageRef,
    );
  });

  it('keeps an initially leased retry excluded after its heartbeat expires during another repair', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first');
    const leased = await planFor(scope, '/lease');
    await seedBatch(scope, [atLocation(first, 'x'), atLocation(leased, 'x')]);
    const started = await lease(scope, leased);
    const pending = await runInDurableObject(scope.stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const apply = await planSeedEntries(
        {
          sql,
          scopeId: scope.scopeId,
          now: NOW + 1,
          revision: readRevision(sql) + 1,
          limits: limitsOf(parseVars({})),
          history: NO_HISTORY,
        },
        { scopeId: scope.scopeId, batchIndex: 0, entries: [first.seed, leased.seed] },
        new Map([[seedLocationKey(first.artifact), true]]),
      );
      const value = state.storage.transactionSync(apply);
      if (!isRepairPending(value)) throw new Error('expected the first seed repair');
      return readRepairJob(sql);
    });

    expect(pending).toMatchObject({ groupCount: 1 });

    vi.mocked(Date.now).mockReturnValue(started.leaseExpiresAt + 1);

    await expect(
      scope.stub.heartbeat(started.attemptId, started.fencingToken, started.leaseExpiresAt + 1),
    ).resolves.toMatchObject({ kind: 'refused', code: 'lease_expired' });

    const result = await runInDurableObject(scope.stub, (_instance, state) => {
      return drainSeedJob(state.storage, {
        sql: state.storage.sql,
        scopeId: scope.scopeId,
        now: started.leaseExpiresAt + 2,
        limits: limitsOf(parseVars({})),
        history: NO_HISTORY,
      });
    });

    expect(result).toMatchObject({ inserted: 0, skipped: 2, refused: [] });
    await expect(failureFor(scope, leased)).resolves.toBe(leased.generationId);
    await expect(failureFor(scope, first)).resolves.toBeNull();

    const healed = await rowsFor(scope, leased);

    expect({
      deferredAttempt: healed.entry.regeneration_attempt_id,
      storageRef: generationOutputs(healed.generation)[0]?.artifacts[0]?.storageRef,
    }).toStrictEqual({
      deferredAttempt: started.attemptId,
      storageRef: first.artifact.storageRef,
    });
    await expect(
      scope.stub.heartbeat(started.attemptId, started.fencingToken, started.leaseExpiresAt + 2),
    ).resolves.toMatchObject({ kind: 'refused', code: 'lease_expired' });
    await expect(rowsFor(scope, leased)).resolves.toMatchObject({
      entry: { regeneration_attempt_id: null },
    });
  });

  it('skips an oversized publishing row before shared writes and finishes a later seed repair', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first');
    const later = await planFor(scope, '/later', 'independent bytes');
    await seedBatch(scope, [atLocation(first, 'x'), atLocation(later, 'y')]);
    const result = await runInDurableObject(scope.stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const original = sql
        .exec<GenerationRow>(
          'SELECT * FROM generations WHERE generation_id = ?',
          first.generationId,
        )
        .one();
      const padded = padGenerationToSqlLimit(state.storage, original);
      const tx = {
        sql,
        scopeId: scope.scopeId,
        now: NOW + 1,
        limits: limitsOf(parseVars({})),
        revision: readRevision(sql) + 1,
        history: NO_HISTORY,
      };
      const proposed = relocatedArtifact(
        generationOutputs(padded),
        first.artifact.sha256,
        'longer',
      );
      const entry = sql
        .exec<EntryRow>('SELECT * FROM entries WHERE entry_id = ?', first.entryId)
        .one();
      const headerFailure = unwritableRecord(
        headerFieldsOf(tx, entry, padded, proposed),
        tx.limits.maxRecordBytes,
      );
      const laterGeneration = sql
        .exec<GenerationRow>(
          'SELECT * FROM generations WHERE generation_id = ?',
          later.generationId,
        )
        .one();
      const laterOutputs = relocatedArtifact(
        generationOutputs(laterGeneration),
        later.artifact.sha256,
        later.artifact.storageRef,
      );
      const pending = state.storage.transactionSync(() => {
        return prepareSeedPublication(
          tx,
          [
            { entry: first.seed, identity: { entryId: first.entryId }, outputs: proposed },
            {
              entry: later.seed,
              identity: { entryId: later.entryId },
              outputs: laterOutputs,
            },
          ],
          new Map([[seedLocationKey(later.artifact), true]]),
          { inserted: 0, skipped: 2, refused: [], revision: tx.revision },
        );
      });
      const runner = new RepairRunner({
        storage: state.storage,
        queue: new ScopeQueue(),
        input: () => ({ ...tx, revision: readRevision(sql) + 1 }),
        arm: () => Promise.resolve(),
      });
      for (let index = 0; index < 50 && readRepairJob(sql) !== undefined; index += 1) {
        await runner.advance(NOW + 1);
      }
      return {
        headerFailure,
        active: readRepairJob(sql),
        skipped: !hasRepairValue(sql, pending.jobId, 'seed-moved-0'),
        laterMoved: readRepairValue<boolean>(sql, pending.jobId, 'seed-moved-1'),
        outputs:
          sql
            .exec<GenerationRow>(
              'SELECT * FROM generations WHERE generation_id = ?',
              first.generationId,
            )
            .one().outputs === padded.outputs,
      };
    });

    expect(result).toStrictEqual({
      headerFailure: undefined,
      active: undefined,
      skipped: true,
      laterMoved: true,
      outputs: true,
    });
    await expect(failureFor(scope, first)).resolves.toBe(first.generationId);
    await expect(rowsFor(scope, later)).resolves.toMatchObject({
      artifact: { storage_ref: later.artifact.storageRef },
    });
  });

  it('keeps a fresh near-limit entry and skips only the oversized retry before a later shared repair', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first');
    const second = await planFor(scope, '/other');
    const fresh = await planFor(scope, '/fresh');
    await seedBatch(scope, [atLocation(first, 'x'), atLocation(second, 'x')]);
    const before = await rowsFor(scope, first);
    const owner = await runInDurableObject(scope.stub, (_instance, state) => {
      return state.storage.sql
        .exec<EntryRow>('SELECT * FROM entries WHERE entry_id = ?', first.entryId)
        .one();
    });
    const padding =
      MAX_PACK_HEADER_BYTES - recordBytesOf(scope.scopeId, owner, before.generation) - 400;
    fresh.seed.generation.headers['x-padding'] = 'a'.repeat(padding);
    const long = 'l'.repeat(900);
    const short = 'repaired/shared';
    const firstRetry = atLocation(first, long);
    const secondRetry = atLocation(second, short);
    const proofs = new Map([
      [seedLocationKey({ ...first.artifact, storageRef: long }), true],
      [seedLocationKey({ ...second.artifact, storageRef: short }), true],
    ]);
    const outcome = await runInDurableObject(scope.stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const tx = {
        sql,
        scopeId: scope.scopeId,
        limits: limitsOf(parseVars({})),
        now: NOW + 1,
        revision: readRevision(sql) + 1,
        history: NO_HISTORY,
      };
      const apply = await planSeedEntries(
        tx,
        {
          scopeId: scope.scopeId,
          batchIndex: 0,
          entries: [atLocation(fresh, 'x'), firstRetry, secondRetry],
        },
        proofs,
      );
      runMutationPreflight(state.storage, apply);
      const pending = state.storage.transactionSync(apply);
      if (!isRepairPending(pending)) throw new Error('expected ordered durable retries');
      const freshEntry = sql
        .exec<EntryRow>('SELECT * FROM entries WHERE entry_id = ?', fresh.entryId)
        .one();
      const freshGeneration = sql
        .exec<GenerationRow>(
          'SELECT * FROM generations WHERE generation_id = ?',
          fresh.generationId,
        )
        .one();
      const previous = generationOutputs(freshGeneration);
      const admitted = unwritableRecord(
        headerFieldsOf(tx, freshEntry, freshGeneration, previous),
        tx.limits.maxRecordBytes,
      );
      const oversized = unwritableRecord(
        headerFieldsOf(
          tx,
          freshEntry,
          freshGeneration,
          relocatedArtifact(previous, first.artifact.sha256, long),
        ),
        tx.limits.maxRecordBytes,
      );
      const result = drainSeedJob(state.storage, tx);
      return {
        result,
        admitted,
        oversized,
        firstMoved: hasRepairValue(sql, pending.jobId, 'seed-moved-0'),
        secondMoved: readRepairValue<boolean>(sql, pending.jobId, 'seed-moved-1'),
      };
    });

    expect(outcome.admitted).toBeUndefined();
    expect(outcome.oversized).toBeTypeOf('string');
    expect(outcome.result).toMatchObject({ inserted: 1, skipped: 2, refused: [] });
    expect(outcome.firstMoved).toBe(false);
    expect(outcome.secondMoved).toBe(true);

    const final = await rowsFor(scope, fresh);

    expect(final.artifact).toMatchObject({ storage_ref: short, refs: 3, owned: 0 });
    expect(generationOutputs(final.generation)[0]?.artifacts[0]?.storageRef).toBe(short);
  });

  it('rolls back fresh rows and a repair job when the initial host history exceeds the actual SQL limit', async () => {
    const scope = await scopeForTest();
    const retry = await planFor(scope, '/retry');
    const fresh = await planFor(scope, '/fresh', '<html>fresh independent bytes</html>');
    await seedBatch(scope, [atLocation(retry, 'missing/initial-history')]);
    await scope.stub.testSettled();
    const proofs = new Map([[seedLocationKey(retry.artifact), true]]);
    const result = await runInDurableObject(scope.stub, async (_instance, state) => {
      const { sql } = state.storage;
      sql.exec('CREATE TABLE seed_initial_history_test (payload TEXT)');
      const snapshot = () => ({
        scope: sql.exec('SELECT revision, entry_count, body_bytes FROM scope').toArray(),
        entries: sql.exec('SELECT * FROM entries ORDER BY entry_id').toArray(),
        generations: sql.exec('SELECT * FROM generations ORDER BY generation_id').toArray(),
        artifacts: sql.exec('SELECT * FROM artifacts ORDER BY sha256').toArray(),
        events: sql.exec('SELECT * FROM seed_initial_history_test').toArray(),
        job: readRepairJob(sql),
      });
      const before = snapshot();
      const history = {
        ...NO_HISTORY,
        append(context: { readonly sql: SqlStorage }, event: EventInput): void {
          // Ask the provider's own row limit; this is not a protocol admission ceiling.
          context.sql.exec(
            'INSERT INTO seed_initial_history_test (payload) VALUES (?)',
            JSON.stringify({ event, padding: 'x'.repeat(3 * 1024 * 1024) }),
          );
        },
      };
      const mutation = commitMutation(
        {
          storage: state.storage,
          scopeId: scope.scopeId,
          buildId: 'build-site',
          kv: env.CACHE_STATE,
          limits: limitsOf(parseVars({})),
          history,
          tables: true,
          createdTables: () => {
            throw new Error('unexpected table creation');
          },
        },
        NOW + 1,
        (input) =>
          planSeedEntries(
            input,
            {
              scopeId: scope.scopeId,
              batchIndex: 0,
              entries: [fresh.seed, retry.seed],
            },
            proofs,
          ),
        { empty: { inserted: 0, skipped: 0, refused: [], revision: 0 } },
      );

      await expect(mutation).rejects.toThrow(/SQLITE_TOOBIG/u);

      return { before, after: snapshot() };
    });

    expect(result.after).toStrictEqual(result.before);
    expect(result.after.events).toStrictEqual([]);
    expect(result.after.job).toBeUndefined();
    await expect(failureFor(scope, retry)).resolves.toBe(retry.generationId);
  });

  it.each([false, true])(
    'prepares a seed repair discovered after planning, with oversized history=%s',
    async (oversized) => {
      const scope = await scopeForTest();
      const retry = await planFor(scope, '/late-retry');
      const fresh = await planFor(scope, '/late-fresh', '<html>late fresh</html>');
      await seedBatch(scope, [atLocation(retry, 'missing/late-seed')]);
      await scope.stub.testSettled();
      const observed = await runInDurableObject(scope.stub, async (_instance, state) => {
        const { sql } = state.storage;
        sql.exec('CREATE TABLE seed_late_history_test (payload TEXT)');
        const history = {
          ...NO_HISTORY,
          append(context: { readonly sql: SqlStorage }, event: EventInput): void {
            context.sql.exec(
              'INSERT INTO seed_late_history_test (payload) VALUES (?)',
              JSON.stringify({ event, ...(oversized && { padding: 'x'.repeat(3 * 1024 * 1024) }) }),
            );
          },
        };
        const before = readRevision(sql);
        const snapshots: { fresh: boolean; job: boolean; revision: number }[] = [];
        const snapshot = () => ({
          fresh:
            sql.exec('SELECT 1 FROM entries WHERE entry_id = ?', fresh.entryId).toArray().length >
            0,
          job: readRepairJob(sql) !== undefined,
          revision: readRevision(sql),
        });
        const arm = (): Promise<void> => {
          snapshots.push(snapshot());
          return Promise.resolve();
        };
        const queue = new ScopeQueue();
        const settled = Promise.resolve();
        const runner = new RepairRunner({
          storage: state.storage,
          queue,
          arm,
          input: (now) => ({
            sql,
            scopeId: scope.scopeId,
            now,
            history,
            limits: limitsOf(parseVars({})),
            revision: readRevision(sql) + 1,
          }),
        });
        const pipeline = new MutationPipeline({
          storage: state.storage,
          queue,
          repairs: runner,
          arm,
          armAnswered: () => Promise.resolve(),
          mutationHost: () => ({
            storage: state.storage,
            scopeId: scope.scopeId,
            kv: env.CACHE_STATE,
            limits: limitsOf(parseVars({})),
            history,
            tables: true,
            createdTables: () => {
              throw new Error('unexpected table creation');
            },
          }),
          tables: () => true,
          committed: () => {
            /* The fixture already owns its tables. */
          },
          testHooks: () => true,
          settling: () => settled,
          settle: () => ({
            answered: Promise.resolve(),
            done: Promise.resolve(),
            answerNow() {
              /* No KV projection in this boundary fixture. */
            },
          }),
        });
        let initiallyProbed = true;
        const pending = pipeline.run(
          NOW + 1,
          async (input) => {
            sql.exec('DELETE FROM meta WHERE key = ?', `seed_artifact_failure:${retry.entryId}`);
            const apply = await planSeedEntries(
              input,
              { scopeId: scope.scopeId, batchIndex: 0, entries: [fresh.seed, retry.seed] },
              new Map([[seedLocationKey(retry.artifact), true]]),
            );
            initiallyProbed = apply.preflight !== undefined;
            // An older asynchronous projection finishes after planning and before its SQL body.
            sql.exec(
              'INSERT INTO meta (key, value) VALUES (?, ?)',
              `seed_artifact_failure:${retry.entryId}`,
              retry.generationId,
            );
            return apply;
          },
          { empty: { inserted: 0, skipped: 0, refused: [], revision: 0 } },
        );
        const receiving = pending.then(
          (value) => ({ value, failed: false }),
          (error: unknown) => ({
            failed: error instanceof Error && /SQLITE_TOOBIG/u.test(error.message),
          }),
        );
        await queue.run(() => undefined);
        for (let index = 0; index < 100 && readRepairJob(sql) !== undefined; index += 1)
          await runner.advance(NOW + 1);
        const answer = await receiving;
        return {
          before,
          firstPreparation: snapshots[0],
          initiallyProbed,
          answer,
          after: snapshot(),
        };
      });

      expect(observed.initiallyProbed).toBe(false);
      expect(observed.firstPreparation).toStrictEqual({
        fresh: false,
        job: false,
        revision: observed.before,
      });
      expect(observed.answer).toMatchObject({ failed: oversized });
      expect(observed.after).toStrictEqual({
        fresh: !oversized,
        job: false,
        revision: observed.before + (oversized ? 0 : 1),
      });
    },
  );

  it('exposes one final record revision after two ordered SHA repairs of the same entry', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope, '/first-sha', '<html>first SHA</html>');
    const second = await planFor(scope, '/second-sha', '<html>second SHA</html>');
    const consumer = await planFor(scope, '/both-shas', '<html>both SHA references</html>');
    const oldFirst = `missing/${scope.scopeId}/first`;
    const oldSecond = `missing/${scope.scopeId}/second`;
    const output = consumer.seed.generation.outputs[0];
    if (output === undefined) throw new Error('the consumer output is missing');
    output.artifacts.push({ ...first.artifact, role: 'rsc', storageRef: oldFirst });
    consumer.seed.generation.outputs.push({
      ...output,
      representationKey: 'second-rsc',
      htmlSize: null,
      artifacts: [{ ...second.artifact, role: 'rsc', storageRef: oldSecond }],
    });
    await seedBatch(scope, [
      atLocation(first, oldFirst),
      atLocation(second, oldSecond),
      consumer.seed,
    ]);
    await scope.stub.testSettled();
    const before = await rowsFor(scope, consumer);
    const historyHost = (sql: SqlStorage) => ({
      ...NO_HISTORY,
      append(
        context: { readonly sql: SqlStorage; readonly revision: number },
        event: EventInput,
      ): void {
        sql.exec(
          'INSERT INTO seed_cursor_history (revision, payload) VALUES (?, ?)',
          context.revision,
          JSON.stringify(event),
        );
      },
    });
    const accepted = await runInDurableObject(scope.stub, async (_instance, state) => {
      const { sql } = state.storage;
      sql.exec(
        'CREATE TABLE seed_cursor_history (ordinal INTEGER PRIMARY KEY, revision INTEGER, payload TEXT)',
      );
      const input = {
        sql,
        scopeId: scope.scopeId,
        buildId: 'build-site',
        limits: limitsOf(parseVars({})),
        now: NOW + 1,
        revision: readRevision(sql) + 1,
        history: historyHost(sql),
      };
      const apply = await planSeedEntries(
        input,
        {
          scopeId: scope.scopeId,
          batchIndex: 0,
          entries: [first.seed, second.seed],
        },
        new Map([
          [seedLocationKey(first.artifact), true],
          [seedLocationKey(second.artifact), true],
        ]),
      );
      runMutationPreflight(state.storage, apply);
      const pending = state.storage.transactionSync(apply);
      if (!isRepairPending(pending)) throw new Error('the ordered SHA repair did not persist');
      return { revision: input.revision, jobId: pending.jobId };
    });
    const observations: {
      readonly refs: readonly string[];
      readonly recordRefs?: readonly string[];
      readonly revision?: number;
    }[] = [];
    let active = true;
    for (let index = 0; index < 200 && active; index += 1) {
      const snapshot = await runInDurableObject(scope.stub, (_instance, state) => {
        const { sql } = state.storage;
        const tx = {
          sql,
          scopeId: scope.scopeId,
          limits: limitsOf(parseVars({})),
          now: NOW + 1,
          history: historyHost(sql),
        };
        const job = readRepairJob(sql);
        if (job === undefined) throw new Error('the ordered SHA repair disappeared');
        const step = advanceSeedStep(state.storage, tx, job);
        if (step.kind === 'completed') {
          state.storage.transactionSync(() => {
            if (job.finalizing === undefined)
              beginRepairFinalization({ ...tx, revision: job.fromRevision }, job, step.value);
            else completeRepairJob(sql, job, { value: step.value, own: null }, NOW + 1);
          });
        }
        const generation = sql
          .exec<GenerationRow>(
            'SELECT * FROM generations WHERE generation_id = ?',
            consumer.generationId,
          )
          .one();
        return {
          active: readRepairJob(sql) !== undefined,
          refs: generationOutputs(generation)
            .flatMap((item) => item.artifacts)
            .filter(
              (artifact) =>
                artifact.sha256 === first.artifact.sha256 ||
                artifact.sha256 === second.artifact.sha256,
            )
            .map((artifact) => artifact.storageRef),
        };
      });
      active = snapshot.active;
      const bytes = await scope.stub.currentRecord(consumer.entryId, before.entry.record_revision);
      if (bytes === undefined) observations.push({ refs: snapshot.refs });
      else {
        const record = decodeGenerationPack(new Uint8Array(bytes));
        if (record.kind !== 'ok') throw new Error(`the current record is ${record.kind}`);
        observations.push({
          refs: snapshot.refs,
          revision: record.pack.header.revision,
          recordRefs: record.pack.header.artifacts
            .filter(
              (artifact) =>
                artifact.sha256 === first.artifact.sha256 ||
                artifact.sha256 === second.artifact.sha256,
            )
            .map((artifact) => artifact.storageRef ?? ''),
        });
      }
    }
    const expected = [first.artifact.storageRef, second.artifact.storageRef];
    const mixed = observations.filter(
      ({ refs }) => refs[0] === expected[0] && refs[1] === oldSecond,
    );
    const delivered = observations.filter(({ recordRefs }) => recordRefs !== undefined);
    const events = await runInDurableObject(scope.stub, (_instance, state) => {
      return state.storage.sql
        .exec<{ revision: number; payload: string }>(
          'SELECT revision, payload FROM seed_cursor_history ORDER BY ordinal',
        )
        .toArray()
        .map((row) => ({ revision: row.revision, event: JSON.parse(row.payload) as EventInput }))
        .filter(
          ({ event }) =>
            event.entityId === consumer.entryId && event.kind === 'entry.state.changed',
        );
    });

    expect(active).toBe(false);
    expect(mixed.length).toBeGreaterThan(0);
    expect(mixed.every(({ recordRefs }) => recordRefs === undefined)).toBe(true);
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered).toStrictEqual(
      delivered.map(() => ({
        refs: expected,
        recordRefs: expected,
        revision: accepted.revision,
      })),
    );
    expect(events).toMatchObject([
      {
        revision: accepted.revision,
        event: { payload: { entryState: { revision: accepted.revision } } },
      },
    ]);
    await expect(
      scope.stub.currentRecord(consumer.entryId, accepted.revision),
    ).resolves.toBeUndefined();
  });

  it('leaves a seed whose record was delivered unchanged on a later retry', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    await seedBatch(scope, [plan.seed]);
    const before = await rowsFor(scope, plan);
    const record = await recordFor(scope, plan.entryId);

    await expect(
      seedBatch(scope, [atLocation(plan, 'missing/replacement')]),
    ).resolves.toMatchObject({
      inserted: 0,
      skipped: 1,
      revision: before.revision,
    });
    await expect(rowsFor(scope, plan)).resolves.toStrictEqual(before);
    await expect(recordFor(scope, plan.entryId)).resolves.toStrictEqual(record);
  });

  it('leaves an active render its lease, and permits the repair after it has ended', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    await seedBatch(scope, [atLocation(plan, 'missing/first')]);
    const started = await lease(scope, plan);
    const before = await rowsFor(scope, plan);

    await expect(seedBatch(scope, [plan.seed])).resolves.toMatchObject({ inserted: 0, skipped: 1 });
    await expect(rowsFor(scope, plan)).resolves.toStrictEqual(before);
    expect(before.entry.regeneration_attempt_id).toBe(started.attemptId);

    await scope.stub.fail(
      started.attemptId,
      { fencingToken: started.fencingToken, outcome: 'skipped' },
      NOW,
    );
    await seedBatch(scope, [plan.seed]);

    expect(decodeUtf8((await recordFor(scope, plan.entryId)).html)).toBe(BODY);
  });

  it('leaves the newer generation a render published unchanged by a corrected seed', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    await seedBatch(scope, [atLocation(plan, 'missing/build')]);
    const started = await lease(scope, plan);
    const bytes = encodeUtf8('<html>the render</html>');
    const sha256 = await sha256Hex(bytes);
    const artifact = { ...plan.artifact, sha256, byteLength: bytes.byteLength };
    const storageRef = r2BlobKey(scope.scopeId, sha256);
    await env.ARTIFACTS.put(storageRef, bytes as BufferSource);
    await scope.stub.recordArtifact(
      started.attemptId,
      { ...artifact, storageRef, fencingToken: started.fencingToken },
      NOW,
    );
    const committed = await scope.stub.commit(
      started.attemptId,
      {
        fencingToken: started.fencingToken,
        observedTagRevision: started.dependencyRevision,
        generation: {
          ...plan.seed.generation,
          cacheTimestamp: NOW,
          producedAt: NOW,
          dependencies: [],
          outputs: plan.seed.generation.outputs.map((output) => {
            return {
              ...output,
              // This fixture is an App Router page, with no Pages Router authority to inherit.
              staticPagePrivacy: undefined,
              htmlSize: bytes.byteLength,
              artifacts: [artifact],
            };
          }),
        },
      },
      NOW,
    );

    expect(committed).toMatchObject({ kind: 'published' });

    const before = await rowsFor(scope, plan);
    const record = await recordFor(scope, plan.entryId);

    await seedBatch(scope, [plan.seed]);

    await expect(rowsFor(scope, plan)).resolves.toStrictEqual(before);
    await expect(recordFor(scope, plan.entryId)).resolves.toStrictEqual(record);
    expect(decodeUtf8(record.html)).toBe('<html>the render</html>');
  });
});

/** Discover the provider row boundary without adding a new admission ceiling. */
function padGenerationToSqlLimit(
  storage: DurableObjectStorage,
  generation: GenerationRow,
): GenerationRow {
  const outputs = generationOutputs(generation);
  const padded = (length: number): string => {
    return JSON.stringify(
      outputs.map((output) => {
        return { ...output, headers: { 'x-output-only-padding': 'x'.repeat(length) } };
      }),
    );
  };
  const fits = (length: number): boolean => {
    try {
      storage.transactionSync(() => {
        return storage.sql.exec(
          'UPDATE generations SET outputs = ? WHERE generation_id = ?',
          padded(length),
          generation.generation_id,
        );
      });
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !/\bSQLITE_TOOBIG\b/u.test(error.message)) throw error;
      return false;
    }
  };
  const maximumFixturePadding = 12 * 1024 * 1024;
  if (fits(maximumFixturePadding))
    throw new Error('the configured SQL row limit exceeds the fixture search window');
  let low = 0;
  let high = maximumFixturePadding;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  const encoded = padded(low);
  storage.sql.exec(
    'UPDATE generations SET outputs = ? WHERE generation_id = ?',
    encoded,
    generation.generation_id,
  );
  return { ...generation, outputs: encoded };
}
