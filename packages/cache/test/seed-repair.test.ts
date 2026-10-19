import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  artifactIdFor,
  buildGenerationIdFor,
  decodeGenerationPack,
  deriveEntry,
  kvGenerationKey,
  type OutputSnapshot,
  policyFromBuild,
  r2BlobKey,
} from '@stayingupwind/core/cache';
import { createId, decodeUtf8, encodeUtf8 } from '@stayingupwind/core/util';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { type EventInput, NO_HISTORY } from '../src/scope/history.ts';
import {
  type EntryStateRow,
  type GenerationRow,
  generationOutputs,
  toEntryState,
} from '../src/scope/rows.ts';
import { seedLocationKey, verifySeedLocations } from '../src/scope/seed-repair.ts';
import { planSeedEntries } from '../src/scope/seed.ts';
import { scopeStub } from '../src/scope/stub.ts';

const NOW = 1_800_000_000_000;
const HTML_TYPE = 'text/html; charset=utf-8';
const BODY = '<html>the build</html>';

async function scopeForTest() {
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
  return scope.stub.seedEntries(
    { scopeId: scope.scopeId, batchIndex: 0, entries: [...entries] },
    NOW,
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

async function observedSeedRepair(scope: Scope, plans: readonly Plan[], revision: number) {
  const proofs = new Map<string, boolean>();
  await verifySeedLocations(
    (key) => env.ARTIFACTS.get(key),
    plans.map((plan) => plan.artifact),
    proofs,
  );
  return runInDurableObject(scope.stub, async (_instance, state) => {
    const sql = state.storage.sql;
    const history: RecordedEvent[] = [];
    const apply = await planSeedEntries(
      {
        sql,
        scopeId: scope.scopeId,
        limits: limitsOf(parseVars({})),
        now: NOW + 1,
        revision,
        history: {
          ...NO_HISTORY,
          append: (context, event) => {
            history.push({ revision: context.revision, event });
          },
        },
      },
      {
        scopeId: scope.scopeId,
        batchIndex: 0,
        entries: plans.map((plan) => plan.seed),
      },
      proofs,
    );
    const result = state.storage.transactionSync(apply);
    const states = Array.from(
      sql.exec<EntryStateRow>(`SELECT * FROM entries ORDER BY entry_id`),
      (entry): RecordedEvent => {
        return {
          revision,
          event: {
            entityType: 'entry',
            entityId: entry.entry_id,
            kind: 'entry.state.changed',
            payload: { entryState: toEntryState(entry) },
          },
        };
      },
    );
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
        revision: firstAfter.entry.record_revision,
        record_revision: firstAfter.entry.record_revision,
      },
      generation: { ...secondBefore.generation, outputs: JSON.stringify(outputs) },
      artifact: { ...secondBefore.artifact, storage_ref: sharedRef },
    });
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
        reply: { inserted: 0, skipped: 2, refused: [], revision: repaired.entry.record_revision },
        entry: {
          kv_revision: repaired.entry.record_revision,
          current_generation_id: first.generationId,
        },
        artifact: { owned: 0, refs: 2, storage_ref: first.artifact.storageRef },
      });
      expect(repaired.entry.record_revision).toBeGreaterThan(before.entry.record_revision);
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

  it('records each shared-repair entry state once while retaining both seed generation events', async () => {
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
      revision: before.revision + 1,
    });
    expect(states.toSorted(byEntity)).toStrictEqual(observed.states.toSorted(byEntity));
    expect(
      generations
        .map(({ event }) => event.entityId)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(
      [first.generationId, second.generationId].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    );
    expect(observed.history).toHaveLength(5);
    expect(repaired.artifact).toStrictEqual({
      storage_ref: first.artifact.storageRef,
      owned: 0,
      refs: 3,
    });
    expect(generationOutputs(repaired.generation)[0]?.artifacts[0]?.storageRef).toBe(
      first.artifact.storageRef,
    );
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
