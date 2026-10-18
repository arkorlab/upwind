import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  buildGenerationIdFor,
  decodeGenerationPack,
  deriveEntry,
  kvGenerationKey,
  policyFromBuild,
  r2BlobKey,
} from '@stayingupwind/core/cache';
import { createId, decodeUtf8, encodeUtf8 } from '@stayingupwind/core/util';
import type { SeedEntryInput } from '@stayingupwind/host/cache';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

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

async function planFor(scope: Scope, pathname = '/') {
  const descriptor = { kind: 'app-page' as const, route: pathname, pathname };
  const { entryId } = await deriveEntry(scope.scopeId, descriptor);
  const generationId = await buildGenerationIdFor(scope.scopeId, entryId);
  const bytes = encodeUtf8(BODY);
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

async function recordFor(scope: Scope, entryId: string) {
  const stored = await env.CACHE_STATE.get(kvGenerationKey(scope.scopeId, entryId), 'arrayBuffer');
  if (stored === null) throw new Error('the entry has no delivery record');
  const decoded = decodeGenerationPack(new Uint8Array(stored));
  if (decoded.kind !== 'ok') throw new Error(`the delivery record is ${decoded.kind}`);
  return decoded.pack;
}

function rowsFor(scope: Scope, plan: Plan) {
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
        .exec<{ outputs: string }>(
          `SELECT outputs FROM generations WHERE generation_id = ?`,
          plan.generationId,
        )
        .one(),
      artifact: state.storage.sql
        .exec<{ storage_ref: string; owned: number; refs: number }>(
          `SELECT storage_ref, owned, refs FROM artifacts WHERE sha256 = ?`,
          plan.artifact.sha256,
        )
        .one(),
    };
  });
}

async function badLocationFor(scope: Scope, fault: string) {
  const location = `bad/${scope.scopeId}`;
  if (fault === 'corrupt') await env.ARTIFACTS.put(location, 'other bytes');
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

describe('a seed whose artifact projection could not read', () => {
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
