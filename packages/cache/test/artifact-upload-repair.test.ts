import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  buildGenerationIdFor,
  decodeGenerationPack,
  deriveEntry,
  kvGenerationKey,
  type OutputSnapshot,
  policyFromBuild,
  tagIdFor,
} from '@stayingupwind/core/cache';
import { createId, decodeUtf8, encodeUtf8 } from '@stayingupwind/core/util';
import { type CommitRequest, type SeedEntryInput, signCacheToken } from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { limitsOf, parseVars } from '../src/env.ts';
import { Gateway } from '../src/function/gateway.ts';
import { createGatewayApp } from '../src/gateway/app.ts';
import { createLogger } from '../src/logger.ts';
import { repairStorageRef } from '../src/scope/artifact-repair.ts';
import { deleteArtifactRow, rememberArtifactFailure } from '../src/scope/artifacts.ts';
import { planCommit } from '../src/scope/commit.ts';
import { findEntry, markRecordWritten } from '../src/scope/entries.ts';
import { findGeneration } from '../src/scope/generations.ts';
import { NO_HISTORY } from '../src/scope/history.ts';
import { blobStore, kvSink } from '../src/scope/io.ts';
import { InvalidArtifactError } from '../src/scope/records.ts';
import { generationOutputs } from '../src/scope/rows.ts';
import { rememberSeedFailure } from '../src/scope/seed-repair.ts';
import { ownRecordsOf, settlePending } from '../src/scope/settle.ts';
import { readRevision } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';

const NOW = 1_800_000_000_000;
const BODY = '<html>same content, new storage</html>';
const TYPE = 'text/html; charset=utf-8';
const LIMITS = limitsOf(parseVars({}));

async function scopeForTest() {
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
  const token = await signCacheToken(
    env.CACHE_TOKEN_KEY ?? '',
    scopeId,
    STANDALONE_AUTHORITY.naming,
  );
  const app = createGatewayApp(STANDALONE_AUTHORITY);
  const send = vi.fn<FetchLike>((request) => {
    const response = app.fetch(request, env, createExecutionContext());
    return Promise.resolve(response);
  });
  const client = new Gateway({
    scopeId,
    token,
    gatewayUrl: 'https://cache.invalid',
    naming: { copyCache: 'artifact-repair-copies', copyKeyOrigin: 'https://copies.invalid' },
    fetchImpl: send,
  });
  return { scopeId, stub, client, send };
}

type Scope = Awaited<ReturnType<typeof scopeForTest>>;

async function planFor(scope: Scope, pathname = '/') {
  const descriptor = { kind: 'app-page', route: pathname, pathname } as const;
  const { entryId } = await deriveEntry(scope.scopeId, descriptor);
  const generationId = await buildGenerationIdFor(scope.scopeId, entryId);
  const bytes = encodeUtf8(BODY);
  const sha256 = await sha256Hex(bytes);
  const artifact = {
    role: 'html' as const,
    sha256,
    byteLength: bytes.byteLength,
    contentType: TYPE,
    encoding: 'identity' as const,
    storageRef: `build/${scope.scopeId}/${sha256}`,
  };
  await env.ARTIFACTS.put(artifact.storageRef, bytes as BufferSource);
  const seed: SeedEntryInput = {
    descriptor,
    groupInstanceId: null,
    generation: {
      generationId,
      cacheTimestamp: NOW,
      producedAt: NOW,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': TYPE },
      tags: [],
      dependencyCoverage: 'complete',
      outputs: [
        {
          representationKey: 'html',
          pathname,
          status: 200,
          headers: { 'content-type': TYPE },
          compute: 'static',
          response: 'complete',
          htmlSize: bytes.byteLength,
          artifacts: [artifact],
        },
      ],
    },
  };
  return { seed, artifact, entryId, generationId, bytes };
}

type Plan = Awaited<ReturnType<typeof planFor>>;
type Mode = 'single' | 'batch';

async function seedBatch(scope: Scope, plan: Plan) {
  return scope.stub.seedEntries(
    { scopeId: scope.scopeId, batchIndex: 0, entries: [plan.seed] },
    NOW,
  );
}

async function lease(scope: Scope, plan: Plan) {
  const started = await scope.stub.startAttempt(
    { entry: plan.seed.descriptor, reason: 'miss' },
    NOW,
  );
  if (started.kind !== 'leased') throw new Error(`the test needs a lease, got ${started.kind}`);
  return started;
}

type Lease = Awaited<ReturnType<typeof lease>>;

async function upload(scope: Scope, plan: Plan, started: Lease, mode: Mode) {
  const artifact = {
    attemptId: started.attemptId,
    fencingToken: started.fencingToken,
    role: 'html' as const,
    contentType: TYPE,
    bytes: plan.bytes,
  };
  return mode === 'single'
    ? [await scope.client.uploadArtifact(artifact)]
    : scope.client.uploadArtifacts([artifact]);
}

function requestFor(plan: Plan, started: Lease, duplicate = false): CommitRequest {
  const artifact = {
    role: plan.artifact.role,
    sha256: plan.artifact.sha256,
    byteLength: plan.artifact.byteLength,
    contentType: plan.artifact.contentType,
    encoding: plan.artifact.encoding,
  };
  const output = {
    representationKey: 'html',
    pathname: '/',
    status: 200,
    headers: { 'content-type': TYPE },
    compute: 'static' as const,
    response: 'complete' as const,
    htmlSize: plan.bytes.byteLength,
    artifacts: [artifact],
  };
  return {
    fencingToken: started.fencingToken,
    observedTagRevision: started.dependencyRevision,
    generation: {
      ...plan.seed.generation,
      cacheTimestamp: NOW,
      producedAt: NOW,
      dependencies: [],
      outputs: duplicate
        ? [output, { ...output, representationKey: 'second', pathname: '/same-bytes' }]
        : [output],
    },
  };
}

async function damage(storageRef: string, fault: string, length: number): Promise<void> {
  if (fault === 'missing') await env.ARTIFACTS.delete(storageRef);
  else {
    const bytes = new Uint8Array(fault === 'length' ? length - 1 : length);
    await env.ARTIFACTS.put(storageRef, bytes as BufferSource);
  }
}

/** Existing location assertions ignore only the new failure-incarnation fence. */
function failureLocation(value: string | undefined): string | undefined {
  if (value === undefined || !value.startsWith('[')) return value;
  const marker: unknown = JSON.parse(value);
  if (
    !Array.isArray(marker) ||
    typeof marker[0] !== 'number' ||
    typeof marker[1] !== 'string' ||
    typeof marker[2] !== 'string'
  )
    throw new Error('the failure marker must name its location and fence');
  return `${String(marker[0])}:${marker[1]}`;
}

function stateFor(scope: Scope, plan: Plan) {
  return runInDurableObject(scope.stub, (_instance, state) => {
    const { sql } = state.storage;
    return {
      artifact: sql
        .exec<{ storage_ref: string; byte_length: number; owned: number; refs: number }>(
          `SELECT storage_ref, byte_length, owned, refs FROM artifacts WHERE sha256 = ?`,
          plan.artifact.sha256,
        )
        .one(),
      bodyBytes: sql.exec<{ body_bytes: number }>(`SELECT body_bytes FROM scope`).one().body_bytes,
      marker: failureLocation(
        sql
          .exec<{ value: string }>(
            `SELECT value FROM meta WHERE key = ?`,
            `artifact_failure:${plan.artifact.sha256}`,
          )
          .toArray()[0]?.value,
      ),
      originalOutputs: sql
        .exec<{ outputs: string }>(
          `SELECT outputs FROM generations WHERE generation_id = ?`,
          plan.generationId,
        )
        .one().outputs,
    };
  });
}

function liveSnapshot(scope: Scope, plan: Plan) {
  return runInDurableObject(scope.stub, (_instance, state) => {
    const entry = findEntry(state.storage.sql, plan.entryId);
    if (entry === undefined) throw new Error('no current entry');
    const current = entry.current_generation_id;
    if (current === null) throw new Error('no current entry');
    const generation = findGeneration(state.storage.sql, current);
    if (generation === undefined) throw new Error('no current generation');
    return {
      generationId: generation.generation_id,
      recordRevision: entry.record_revision,
      kvRevision: entry.kv_revision,
      outputs: generationOutputs(generation),
    };
  });
}

function relocatedOutputs(
  outputs: readonly OutputSnapshot[],
  storageRef: string,
): OutputSnapshot[] {
  return outputs.map((output) => {
    return {
      ...output,
      artifacts: output.artifacts.map((artifact) => ({ ...artifact, storageRef })),
    };
  });
}

async function bodyFor(scope: Scope, plan: Plan): Promise<string> {
  const record = await recordFor(scope, plan);
  return decodeUtf8(record.html);
}

async function recordFor(scope: Scope, plan: Plan) {
  const stored = await env.CACHE_STATE.get(
    kvGenerationKey(scope.scopeId, plan.entryId),
    'arrayBuffer',
  );
  if (stored === null) throw new Error('no delivered generation');
  const decoded = decodeGenerationPack(new Uint8Array(stored));
  if (decoded.kind !== 'ok') throw new Error(`the delivered record is ${decoded.kind}`);
  return decoded.pack;
}

async function brokenSeed(fault = 'missing') {
  const scope = await scopeForTest();
  const plan = await planFor(scope);
  await damage(plan.artifact.storageRef, fault, plan.bytes.byteLength);
  await seedBatch(scope, plan);
  return { scope, plan };
}

async function repairedOwned() {
  const { scope, plan } = await brokenSeed();
  const started = await lease(scope, plan);
  await upload(scope, plan, started, 'single');
  const result = await scope.stub.commit(started.attemptId, requestFor(plan, started), NOW);
  if (!('kind' in result) || result.kind !== 'published') throw new Error('repair did not publish');
  const { artifact } = await stateFor(scope, plan);
  return { scope, plan, storageRef: artifact.storage_ref };
}

async function reproject(scope: Scope, plan: Plan) {
  await runInDurableObject(scope.stub, (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE entries SET record_revision = record_revision + 1, kv_revision = 0 WHERE entry_id = ?`,
      plan.entryId,
    );
  });
  await scope.stub.tick(NOW);
}

/** Exercise the same bounded alarm slices, without assuming one tick drains a whole deployment. */
async function drainRecords(scope: Scope, entries: number): Promise<void> {
  for (let tick = 0; tick <= entries; tick++) {
    const behind = await runInDurableObject(scope.stub, (_instance, state) => {
      return state.storage.sql
        .exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM entries WHERE record_revision > kv_revision`,
        )
        .one().count;
    });
    if (behind === 0) return;
    if (tick === entries) throw new Error('the bounded projection drain did not finish');
    await scope.stub.tick(NOW);
  }
}

type VerificationRace = 'revision' | 'location' | 'marker';

/** Inject a concurrent authority change after the real read/hash/KV write, before its ACK. */
function restoredProjectionRace(scope: Scope, plan: Plan, race: VerificationRace) {
  return runInDurableObject(scope.stub, async (_instance, state) => {
    const { sql } = state.storage;
    const key = kvGenerationKey(scope.scopeId, plan.entryId);
    const marker = () => {
      return sql
        .exec<{ value: string }>(
          `SELECT value FROM meta WHERE key = ?`,
          `artifact_failure:${plan.artifact.sha256}`,
        )
        .toArray()[0]?.value;
    };
    const before = marker();
    const sink = kvSink(env.CACHE_STATE, () => ({}));
    const history: unknown[] = [];
    let changed = false;
    const outcome = await settlePending(
      {
        sql,
        scopeId: scope.scopeId,
        blobs: blobStore(env.ARTIFACTS, () => ({})),
        kv: {
          ...sink,
          put: async (at, value) => {
            await sink.put(at, value);
            if (at !== key || changed) return;
            changed = true;
            state.storage.transactionSync(() => {
              if (race === 'revision') {
                sql.exec(
                  `UPDATE entries SET record_revision = record_revision + 1 WHERE entry_id = ?`,
                  plan.entryId,
                );
              } else {
                const storageRef =
                  race === 'location'
                    ? `${plan.artifact.storageRef}/newer`
                    : plan.artifact.storageRef;
                sql.exec(
                  `UPDATE artifacts SET storage_ref = ? WHERE sha256 = ?`,
                  storageRef,
                  plan.artifact.sha256,
                );
                rememberArtifactFailure(sql, { ...plan.artifact, storageRef });
              }
            });
          },
        },
        history: {
          ...NO_HISTORY,
          append: (_context, event) => {
            if (event.kind === 'entries.projected') history.push(event.payload);
          },
        },
        log: createLogger({ component: 'verified-projection-race' }),
        now: () => NOW,
        transaction: <T>(body: () => T) => state.storage.transactionSync(body),
        sliceMs: 1,
        othersWaiting: () => false,
        continueSoon: () => {
          const done = Promise.resolve();
          return done;
        },
      },
      undefined,
      ownRecordsOf(sql, readRevision(sql)),
    );
    const entry = findEntry(sql, plan.entryId);
    return { before, after: marker(), changed, failed: outcome.failed, entry, history };
  });
}

async function refuseRepair(scope: Scope, kind: string) {
  if (kind === 'stale') {
    const tagId = await tagIdFor(scope.scopeId, 'next-explicit', 'shared');
    await runInDurableObject(scope.stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO invalidations (invalidation_id, revision, target_kind, target_id, target_value, stale_at, hard_expire_at, meaning, expire_seconds, cause, recorded_at)
         VALUES ('new-mark', 100, 'tag', ?, 'shared', ?, ?, 'immediate', NULL, '{}', ?)`,
        tagId,
        NOW,
        NOW,
        NOW,
      );
      state.storage.sql.exec(`UPDATE scope SET revision = 100`);
    });
  }
}

async function limitedCommit(scope: Scope, started: Lease, request: CommitRequest) {
  return runInDurableObject(scope.stub, async (_instance, state) => {
    const { sql } = state.storage;
    const apply = await planCommit(
      {
        sql,
        scopeId: scope.scopeId,
        limits: { ...LIMITS, bodyBytesPerScope: 1 },
        now: NOW,
        revision: readRevision(sql) + 1,
        history: NO_HISTORY,
      },
      started.attemptId,
      request,
      blobStore(env.ARTIFACTS, () => ({})),
    );
    return state.storage.transactionSync(apply);
  });
}

async function uncheckedRepair(scope: Scope, plan: Plan, started: Lease) {
  return runInDurableObject(scope.stub, async (_instance, state) => {
    const { sql } = state.storage;
    const apply = await planCommit(
      {
        sql,
        scopeId: scope.scopeId,
        limits: LIMITS,
        now: NOW,
        revision: readRevision(sql) + 1,
        history: NO_HISTORY,
      },
      started.attemptId,
      requestFor(plan, started),
      blobStore(env.ARTIFACTS, () => ({})),
    );
    await env.ARTIFACTS.delete(plan.artifact.storageRef);
    rememberArtifactFailure(sql, plan.artifact);
    return state.storage.transactionSync(apply);
  });
}

function lateProjectionMarkers(scope: Scope, plan: Plan) {
  return runInDurableObject(scope.stub, (_instance, state) => {
    const { sql } = state.storage;
    const entry = findEntry(sql, plan.entryId);
    const current = findGeneration(sql, plan.generationId);
    const artifact =
      current === undefined ? undefined : generationOutputs(current)[0]?.artifacts[0];
    if (entry === undefined || current === undefined || artifact === undefined)
      throw new Error('no seeded snapshot');
    const error = new InvalidArtifactError('late failure', artifact);
    const deps = { sql, transaction: <T>(body: () => T) => state.storage.transactionSync(body) };
    sql.exec(
      `UPDATE entries SET record_revision = record_revision + 1 WHERE entry_id = ?`,
      plan.entryId,
    );
    rememberSeedFailure(deps, { entry, current }, error);
    const revision = sql
      .exec(`SELECT value FROM meta WHERE key = ?`, `artifact_failure:${artifact.sha256}`)
      .toArray();
    sql.exec(
      `UPDATE entries SET record_revision = ? WHERE entry_id = ?`,
      entry.record_revision,
      plan.entryId,
    );
    sql.exec(`UPDATE entries SET current_generation_id = NULL WHERE entry_id = ?`, plan.entryId);
    rememberSeedFailure(deps, { entry, current }, error);
    const generation = sql
      .exec(`SELECT value FROM meta WHERE key = ?`, `artifact_failure:${artifact.sha256}`)
      .toArray();
    sql.exec(
      `UPDATE entries SET current_generation_id = ? WHERE entry_id = ?`,
      current.generation_id,
      plan.entryId,
    );
    sql.exec(
      `UPDATE artifacts SET storage_ref = 'newer/canonical' WHERE sha256 = ?`,
      artifact.sha256,
    );
    rememberSeedFailure(deps, { entry, current }, error);
    return {
      revision,
      generation,
      location: sql
        .exec(`SELECT value FROM meta WHERE key = ?`, `artifact_failure:${artifact.sha256}`)
        .toArray(),
    };
  });
}

describe('verified uploads repairing a known broken canonical artifact', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { fault: 'missing', mode: 'single' },
    { fault: 'length', mode: 'batch' },
    { fault: 'digest', mode: 'batch' },
  ] as const)(
    'repairs $fault through the $mode HTTP upload once per SHA',
    async ({ fault, mode }) => {
      const { scope, plan } = await brokenSeed(fault);
      const before = await stateFor(scope, plan);
      const started = await lease(scope, plan);

      expect(before.marker).toBe(`${plan.bytes.byteLength}:${plan.artifact.storageRef}`);
      await expect(
        scope.stub.commit(started.attemptId, requestFor(plan, started), NOW),
      ).resolves.toMatchObject({ code: 'artifact_missing' });
      await expect(stateFor(scope, plan)).resolves.toStrictEqual(before);

      await expect(upload(scope, plan, started, mode)).resolves.toStrictEqual([
        { sha256: plan.artifact.sha256, byteLength: plan.bytes.byteLength },
      ]);
      await expect(
        scope.stub.commit(started.attemptId, requestFor(plan, started, true), NOW),
      ).resolves.toMatchObject({ kind: 'published' });

      const after = await stateFor(scope, plan);

      expect(after).toMatchObject({
        artifact: {
          storage_ref: repairStorageRef(scope.scopeId, plan.artifact.sha256, started.attemptId),
          owned: 1,
          refs: 3,
        },
        bodyBytes: plan.bytes.byteLength,
        marker: undefined,
        originalOutputs: before.originalOutputs,
      });
      expect(decodeUtf8((await recordFor(scope, plan)).html)).toBe(BODY);
      expect(scope.send.mock.calls[0]?.[0].method).toBe(mode === 'single' ? 'PUT' : 'POST');
    },
  );

  it('keeps healthy borrowed bytes canonical and uncharged', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    await seedBatch(scope, plan);
    const before = await stateFor(scope, plan);
    const started = await lease(scope, plan);
    await upload(scope, plan, started, 'batch');

    await expect(
      scope.stub.commit(started.attemptId, requestFor(plan, started), NOW),
    ).resolves.toMatchObject({ kind: 'published' });
    await expect(stateFor(scope, plan)).resolves.toMatchObject({
      artifact: { storage_ref: plan.artifact.storageRef, owned: 0, refs: 2 },
      bodyBytes: 0,
      marker: undefined,
      originalOutputs: before.originalOutputs,
    });
    expect(decodeUtf8((await recordFor(scope, plan)).html)).toBe(BODY);
  });

  it('deduplicates a healthy owned upload with HEAD and keeps its existing charge', async () => {
    const { scope, plan, storageRef } = await repairedOwned();
    const started = await lease(scope, plan);
    const put = vi.spyOn(env.ARTIFACTS, 'put');
    const head = vi.spyOn(env.ARTIFACTS, 'head');
    await upload(scope, plan, started, 'single');

    expect(put).not.toHaveBeenCalled();
    expect(head).toHaveBeenCalledExactlyOnceWith(storageRef);
    await expect(
      scope.stub.commit(started.attemptId, requestFor(plan, started), NOW),
    ).resolves.toMatchObject({ kind: 'published' });
    await expect(stateFor(scope, plan)).resolves.toMatchObject({
      artifact: { owned: 1, refs: 3 },
      bodyBytes: plan.bytes.byteLength,
      marker: undefined,
    });
  });

  it.each(['single', 'batch'] as const)(
    'overwrites a same-length corrupt owned key through %s',
    async (mode) => {
      const { scope, plan, storageRef } = await repairedOwned();
      await damage(storageRef, 'digest', plan.bytes.byteLength);
      await reproject(scope, plan);
      const marked = await stateFor(scope, plan);
      const started = await lease(scope, plan);
      const put = vi.spyOn(env.ARTIFACTS, 'put');
      const head = vi.spyOn(env.ARTIFACTS, 'head');
      await upload(scope, plan, started, mode);

      expect(marked.marker).toBe(`${plan.bytes.byteLength}:${storageRef}`);
      expect(put).toHaveBeenCalledTimes(1);
      expect(head).not.toHaveBeenCalled();
      await expect(
        scope.stub.commit(started.attemptId, requestFor(plan, started), NOW),
      ).resolves.toMatchObject({ kind: 'published' });
      expect(decodeUtf8((await recordFor(scope, plan)).html)).toBe(BODY);
      await expect(stateFor(scope, plan)).resolves.toMatchObject({
        artifact: {
          storage_ref: repairStorageRef(scope.scopeId, plan.artifact.sha256, started.attemptId),
          owned: 1,
          refs: 3,
        },
        bodyBytes: plan.bytes.byteLength,
        marker: undefined,
      });
    },
  );

  it.each([
    { kind: 'quota', expected: { code: 'quota_exceeded' } },
    { kind: 'stale', expected: { kind: 'stale-dependencies' } },
    { kind: 'lease', expected: { kind: 'lease-expired' } },
  ])('does not promote or charge a repair refused by $kind', async ({ kind, expected }) => {
    const { scope, plan } = await brokenSeed();
    const started = await lease(scope, plan);
    await upload(scope, plan, started, 'single');
    const before = await stateFor(scope, plan);
    const base = requestFor(plan, started);
    const request: CommitRequest = {
      ...base,
      generation: { ...base.generation, tags: [{ kind: 'next-explicit', value: 'shared' }] },
    };
    await refuseRepair(scope, kind);

    const now = kind === 'lease' ? started.leaseExpiresAt : NOW;
    const outcome =
      kind === 'quota'
        ? limitedCommit(scope, started, request)
        : scope.stub.commit(started.attemptId, request, now);

    await expect(outcome).resolves.toMatchObject(expected);
    await expect(stateFor(scope, plan)).resolves.toStrictEqual(before);
  });

  it('rejects a replacement whose failure marker appeared after the upload HEAD plan', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    await seedBatch(scope, plan);
    const started = await lease(scope, plan);
    await upload(scope, plan, started, 'single');
    const outcome = await uncheckedRepair(scope, plan, started);

    expect(outcome).toMatchObject({ code: 'artifact_missing' });
    await expect(stateFor(scope, plan)).resolves.toMatchObject({
      artifact: { storage_ref: plan.artifact.storageRef, owned: 0, refs: 1 },
      bodyBytes: 0,
      marker: `${plan.bytes.byteLength}:${plan.artifact.storageRef}`,
    });
  });

  it('retargets every other live snapshot across pages and queues all projections', async () => {
    const scope = await scopeForTest();
    const first = await planFor(scope);
    const others = await Promise.all(
      Array.from({ length: 51 }, (_value, index) => planFor(scope, `/shared/${String(index)}`)),
    );
    await damage(first.artifact.storageRef, 'missing', first.bytes.byteLength);
    await scope.stub.seedEntries(
      {
        scopeId: scope.scopeId,
        batchIndex: 0,
        entries: [first.seed, ...others.map((plan) => plan.seed)],
      },
      NOW,
    );
    const before = await Promise.all(others.map((plan) => liveSnapshot(scope, plan)));
    const original = await stateFor(scope, first);
    const started = await lease(scope, first);
    await upload(scope, first, started, 'batch');
    const published = await scope.stub.commit(started.attemptId, requestFor(first, started), NOW);
    await drainRecords(scope, others.length + 1);
    const target = repairStorageRef(scope.scopeId, first.artifact.sha256, started.attemptId);
    const after = await Promise.all(others.map((plan) => liveSnapshot(scope, plan)));
    const bodies = await Promise.all(others.map((plan) => bodyFor(scope, plan)));
    const staleAcknowledged = await runInDurableObject(scope.stub, (_instance, state) => {
      return markRecordWritten(
        state.storage.sql,
        others[0]?.entryId ?? '',
        before[0]?.recordRevision ?? -1,
      );
    });
    const expected = before.map((snapshot) => relocatedOutputs(snapshot.outputs, target));

    expect(published).toMatchObject({ kind: 'published' });
    expect(after.map((snapshot) => snapshot.generationId)).toStrictEqual(
      others.map((plan) => plan.generationId),
    );
    expect(after.map((snapshot) => snapshot.outputs)).toStrictEqual(expected);
    expect(
      after.every((snapshot, index) => {
        const current =
          snapshot.kvRevision === snapshot.recordRevision &&
          snapshot.recordRevision > (before[index]?.recordRevision ?? -1);
        return current;
      }),
    ).toBe(true);
    expect(staleAcknowledged).toBe(false);
    await expect(stateFor(scope, first)).resolves.toMatchObject({
      artifact: { storage_ref: target, owned: 1, refs: 53 },
      bodyBytes: first.bytes.byteLength,
      marker: undefined,
      originalOutputs: original.originalOutputs,
    });
    expect(bodies).toStrictEqual(Array.from({ length: 51 }, () => BODY));
  });

  it('keeps a known bad owned key marked when its replacement PUT overlaps commit or fails', async () => {
    const { scope, plan, storageRef } = await repairedOwned();
    await damage(storageRef, 'digest', plan.bytes.byteLength);
    await reproject(scope, plan);
    const before = await stateFor(scope, plan);
    const started = await lease(scope, plan);
    const entered = Promise.withResolvers<true>();
    const blocked = Promise.withResolvers<never>();
    const put = vi.spyOn(env.ARTIFACTS, 'put').mockImplementationOnce(() => {
      entered.resolve(true);
      return blocked.promise;
    });
    const finished = (async () => {
      try {
        await upload(scope, plan, started, 'single');
        return 'stored';
      } catch {
        return 'failed';
      }
    })();
    try {
      await entered.promise;
      const overlapping = await scope.stub.commit(
        started.attemptId,
        requestFor(plan, started),
        NOW,
      );
      blocked.reject(new Error('replacement PUT failed'));
      const failed = await finished;
      const afterward = await scope.stub.commit(started.attemptId, requestFor(plan, started), NOW);

      expect({ overlapping, failed, afterward }).toMatchObject({
        overlapping: { code: 'artifact_missing' },
        failed: 'failed',
        afterward: { code: 'artifact_missing' },
      });

      await expect(stateFor(scope, plan)).resolves.toStrictEqual(before);

      put.mockRestore();
      await upload(scope, plan, started, 'single');

      await expect(
        scope.stub.commit(started.attemptId, requestFor(plan, started), NOW),
      ).resolves.toMatchObject({ kind: 'published' });

      expect(decodeUtf8((await recordFor(scope, plan)).html)).toBe(BODY);
    } finally {
      blocked.reject(new Error('release replacement fixture'));
      await finished;
      put.mockRestore();
    }
  });

  it('refuses an ordinary admitted upload when a failure is discovered before its commit plan', async () => {
    const { scope, plan, storageRef } = await repairedOwned();
    await damage(storageRef, 'digest', plan.bytes.byteLength);
    const started = await lease(scope, plan);
    const head = vi.spyOn(env.ARTIFACTS, 'head');
    const put = vi.spyOn(env.ARTIFACTS, 'put');
    await upload(scope, plan, started, 'single');
    await reproject(scope, plan);
    const before = await stateFor(scope, plan);

    expect(head).toHaveBeenCalledExactlyOnceWith(storageRef);
    expect(put).not.toHaveBeenCalled();

    await expect(
      scope.stub.commit(started.attemptId, requestFor(plan, started), NOW),
    ).resolves.toMatchObject({ code: 'artifact_missing' });
    await expect(stateFor(scope, plan)).resolves.toStrictEqual(before);

    await upload(scope, plan, started, 'single');

    await expect(
      scope.stub.commit(started.attemptId, requestFor(plan, started), NOW),
    ).resolves.toMatchObject({ kind: 'published' });

    expect(decodeUtf8((await recordFor(scope, plan)).html)).toBe(BODY);
  });

  it('ignores late projection failures for another revision, generation or canonical location', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    await seedBatch(scope, plan);
    const markers = await lateProjectionMarkers(scope, plan);

    expect(markers).toStrictEqual({ revision: [], generation: [], location: [] });
  });

  it('clears a verified same-key restoration on an unchanged seed and keeps borrowed bytes free', async () => {
    const { scope, plan } = await brokenSeed('digest');
    const before = await stateFor(scope, plan);
    await env.ARTIFACTS.put(plan.artifact.storageRef, plan.bytes as BufferSource);
    await seedBatch(scope, plan);
    const restored = await stateFor(scope, plan);
    const started = await lease(scope, plan);
    const put = vi.spyOn(env.ARTIFACTS, 'put');
    await upload(scope, plan, started, 'single');
    const committed = await scope.stub.commit(started.attemptId, requestFor(plan, started), NOW);

    expect(before.marker).toBe(`${plan.bytes.byteLength}:${plan.artifact.storageRef}`);
    expect(restored).toMatchObject({ marker: undefined, bodyBytes: 0, artifact: { owned: 0 } });
    expect(committed).toMatchObject({ kind: 'published' });
    expect(put).not.toHaveBeenCalled();

    await expect(bodyFor(scope, plan)).resolves.toBe(BODY);

    await expect(stateFor(scope, plan)).resolves.toMatchObject({
      marker: undefined,
      bodyBytes: 0,
      artifact: { owned: 0, storage_ref: plan.artifact.storageRef },
    });
  });

  it.each(['revision', 'location', 'marker'] as const)(
    'keeps failure knowledge across a newer $0 during verified projection',
    async (race) => {
      const { scope, plan } = await brokenSeed();
      await env.ARTIFACTS.put(plan.artifact.storageRef, plan.bytes as BufferSource);
      const outcome = await restoredProjectionRace(scope, plan, race);
      const expectedLocation =
        race === 'location' ? `${plan.artifact.storageRef}/newer` : plan.artifact.storageRef;

      expect(outcome).toMatchObject({ changed: true, failed: false });
      expect(failureLocation(outcome.after)).toBe(`${plan.bytes.byteLength}:${expectedLocation}`);
      expect(outcome.after === outcome.before).toBe(race === 'revision');
      expect(outcome.entry?.kv_revision === outcome.entry?.record_revision).toBe(
        race !== 'revision',
      );
      expect(outcome.history).toStrictEqual(
        race === 'revision'
          ? []
          : [{ entries: [{ entryId: plan.entryId, kvRevision: outcome.entry?.kv_revision }] }],
      );
    },
  );

  it('does not clear a marker for a referenced artifact that projection never reads', async () => {
    const scope = await scopeForTest();
    const plan = await planFor(scope);
    const segmentBytes = encodeUtf8('not an inline record body');
    const segment = {
      ...plan.artifact,
      role: 'rsc' as const,
      sha256: await sha256Hex(segmentBytes),
      byteLength: segmentBytes.byteLength,
      storageRef: `${plan.artifact.storageRef}/referenced`,
    };
    plan.seed = {
      ...plan.seed,
      generation: {
        ...plan.seed.generation,
        outputs: plan.seed.generation.outputs.map((output) => ({
          ...output,
          artifacts: [...output.artifacts, segment],
        })),
      },
    };
    await seedBatch(scope, plan);
    await runInDurableObject(scope.stub, (_instance, state) => {
      rememberArtifactFailure(state.storage.sql, plan.artifact);
      rememberArtifactFailure(state.storage.sql, segment);
    });
    const get = vi.spyOn(env.ARTIFACTS, 'get');
    await reproject(scope, plan);
    const remaining = await runInDurableObject(scope.stub, (_instance, state) => {
      return state.storage.sql
        .exec<{ key: string }>(`SELECT key FROM meta WHERE key LIKE 'artifact_failure:%'`)
        .toArray();
    });

    expect(remaining).toStrictEqual([{ key: `artifact_failure:${segment.sha256}` }]);
    expect(get.mock.calls.map(([key]) => key)).toStrictEqual([plan.artifact.storageRef]);

    await expect(bodyFor(scope, plan)).resolves.toBe(BODY);
  });

  it('retains a live row marker and removes it when retention deletes the unreferenced row', async () => {
    const { scope, plan } = await brokenSeed();
    const markers = await runInDurableObject(scope.stub, (_instance, state) => {
      const { sql } = state.storage;
      deleteArtifactRow(sql, plan.artifact.sha256);
      const kept = sql
        .exec(`SELECT value FROM meta WHERE key = ?`, `artifact_failure:${plan.artifact.sha256}`)
        .toArray();
      sql.exec(`UPDATE artifacts SET refs = 0 WHERE sha256 = ?`, plan.artifact.sha256);
      deleteArtifactRow(sql, plan.artifact.sha256);
      return {
        kept,
        remaining: sql
          .exec(`SELECT value FROM meta WHERE key = ?`, `artifact_failure:${plan.artifact.sha256}`)
          .toArray(),
        rows: sql
          .exec(`SELECT sha256 FROM artifacts WHERE sha256 = ?`, plan.artifact.sha256)
          .toArray(),
      };
    });

    expect(markers.kept).toStrictEqual([
      { value: `${plan.bytes.byteLength}:${plan.artifact.storageRef}` },
    ]);
    expect(markers.remaining).toStrictEqual([]);
    expect(markers.rows).toStrictEqual([]);
  });
});
