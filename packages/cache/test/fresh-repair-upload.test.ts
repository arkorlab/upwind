import { sha256Hex } from '@stayingupwind/core/artifact';
import { createRepairStorageRef, r2BlobKey } from '@stayingupwind/core/cache';
import { createId, encodeUtf8 } from '@stayingupwind/core/util';
import { signCacheToken } from '@stayingupwind/host/cache';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';
import { createGatewayApp } from '../src/gateway/app.ts';
import { rememberArtifactFailure } from '../src/scope/artifacts.ts';
import { blobStore } from '../src/scope/io.ts';
import {
  copyRepairBlob,
  repairUploadMatches,
  repairUploadMetadata,
} from '../src/scope/repair-upload.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';

const NOW = 1_800_000_000_000;
const BYTES = encodeUtf8('verified fresh replacement');
const TYPE = 'text/html';
const DIGEST = 'a'.repeat(64);
const READER = { versionId: 'reviewed', moduleSha256: DIGEST };

async function freshScope() {
  const scopeId = createId('dpl');
  const stub = scopeStub(env, scopeId);
  await stub.seedScope(
    {
      scope: {
        scopeId,
        organizationId: 'owner',
        projectId: 'project',
        environmentId: 'production',
        deploymentId: scopeId,
        buildId: 'build',
        keySchemaVersion: 1,
      },
      generationPackReaders: JSON.stringify({
        schemaVersion: 2,
        rolloutId: 'trusted-admin-test',
        deploymentId: scopeId,
        buildId: 'build',
        platform: { edge: READER, authority: READER, gateway: READER, readGateway: READER },
        consumers: [
          {
            name: 'app',
            mainModule: 'main.mjs',
            mainModuleSha256: DIGEST,
            hostIdentity: 'reviewed-host',
            hostModuleSha256: DIGEST,
          },
        ],
      }),
    },
    NOW,
  );
  const started = await stub.startAttempt(
    {
      entry: { kind: 'app-page', route: '/', pathname: '/' },
      reason: 'miss',
    },
    NOW,
  );
  if (started.kind !== 'leased') throw new Error('expected a lease');
  const sha256 = await sha256Hex(BYTES);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO artifacts
       (artifact_id, sha256, storage_ref, byte_length, owned, refs, referenced_at)
       VALUES (?, ?, 'borrowed/broken', ?, 0, 1, ?)`,
      'borrowed-artifact',
      sha256,
      BYTES.byteLength,
      NOW,
    );
    rememberArtifactFailure(state.storage.sql, {
      sha256,
      byteLength: BYTES.byteLength,
      storageRef: 'borrowed/broken',
    });
  });
  const upload = {
    sha256,
    byteLength: BYTES.byteLength,
    contentType: TYPE,
    role: 'html',
    encoding: 'identity' as const,
    storageRef: r2BlobKey(scopeId, sha256),
    fencingToken: started.fencingToken,
  };
  const recorded = await stub.recordArtifact(started.attemptId, upload, NOW);
  if (!('fresh' in recorded) || recorded.fresh !== true || recorded.storageRef === undefined)
    throw new Error('expected a fresh reservation');
  const token = await signCacheToken(
    env.CACHE_TOKEN_KEY ?? '',
    scopeId,
    STANDALONE_AUTHORITY.naming,
  );
  const app = createGatewayApp(STANDALONE_AUTHORITY);
  const client = new Gateway({
    scopeId,
    token,
    gatewayUrl: 'https://cache.invalid',
    naming: { copyCache: 'fresh-repair-copies', copyKeyOrigin: 'https://copies.invalid' },
    fetchImpl: (request) => Promise.resolve(app.fetch(request, env, createExecutionContext())),
  });
  return { scopeId, stub, started, upload, client, reserved: recorded.storageRef };
}

async function reservedRefs(scope: Awaited<ReturnType<typeof freshScope>>) {
  return runInDurableObject(scope.stub, (_instance, state) =>
    state.storage.sql
      .exec<{ storage_ref: string }>(
        'SELECT storage_ref FROM attempt_artifacts WHERE attempt_id = ? ORDER BY role',
        scope.started.attemptId,
      )
      .toArray()
      .map((row) => row.storage_ref),
  );
}

describe('fresh repair upload ownership and provider receipts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each(['single', 'batch'] as const)(
    'leaves an unrelated object intact through %s collision retries',
    async (mode) => {
      const scope = await freshScope();
      await env.ARTIFACTS.put(scope.reserved, 'unrelated object');
      const artifact = {
        attemptId: scope.started.attemptId,
        fencingToken: scope.started.fencingToken,
        role: 'html' as const,
        contentType: TYPE,
        bytes: BYTES,
      };
      const send = () =>
        mode === 'single'
          ? scope.client.uploadArtifact(artifact)
          : scope.client.uploadArtifacts([artifact, { ...artifact, role: 'rsc' }]);
      await send();
      const refs = await reservedRefs(scope);
      const key = refs[0];
      if (key === undefined) throw new Error('no reservation');
      expect(key).not.toBe(scope.reserved);
      expect(key.length).toBe(67);
      expect(new Set(refs).size).toBe(1);
      expect(await (await env.ARTIFACTS.get(scope.reserved))?.text()).toBe('unrelated object');
      expect(await (await env.ARTIFACTS.get(key))?.text()).toBe('verified fresh replacement');
      const namespace = key.split('/')[1];
      if (namespace === undefined) throw new Error('no namespace');
      const proof = {
        namespace,
        scopeOwner: scope.stub.id.toString(),
        attemptId: scope.started.attemptId,
        sha256: scope.upload.sha256,
        byteLength: BYTES.byteLength,
      };
      const blobs = blobStore(env.ARTIFACTS, () => ({}), { repairOwner: scope.stub.id.toString() });
      expect(await blobs.verifiedRepair?.(key, proof)).toBe(true);
      expect(await blobs.verifiedRepair?.(key, { ...proof, attemptId: 'another-attempt' })).toBe(
        false,
      );
      expect(await blobs.verifiedRepair?.(key, { ...proof, sha256: '0'.repeat(64) })).toBe(false);
      await send();
      expect(await reservedRefs(scope)).toStrictEqual(refs);
    },
  );

  it('rescues a same-key rate limit only with a matching positive receipt', async () => {
    const scope = await freshScope();
    const artifact = {
      attemptId: scope.started.attemptId,
      fencingToken: scope.started.fencingToken,
      role: 'html' as const,
      contentType: TYPE,
      bytes: BYTES,
    };
    await scope.client.uploadArtifact(artifact);
    const refs = await reservedRefs(scope);
    // The competing create completed after this request observed absence.
    vi.spyOn(env.ARTIFACTS, 'head').mockResolvedValueOnce(null);
    const put = vi
      .spyOn(env.ARTIFACTS, 'put')
      .mockRejectedValue(new Error('put: TooManyRequests (10058)'));
    await expect(scope.client.uploadArtifact(artifact)).resolves.toMatchObject({
      byteLength: BYTES.byteLength,
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(await reservedRefs(scope)).toStrictEqual(refs);
  });

  it('does not rotate or accept an unrelated key after a rate-limit error', async () => {
    const scope = await freshScope();
    await env.ARTIFACTS.put(scope.reserved, 'unrelated bytes');
    vi.spyOn(env.ARTIFACTS, 'put').mockRejectedValue(new Error('put: TooManyRequests (10058)'));
    await expect(
      scope.client.uploadArtifact({
        attemptId: scope.started.attemptId,
        fencingToken: scope.started.fencingToken,
        role: 'html',
        contentType: TYPE,
        bytes: BYTES,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(await reservedRefs(scope)).toStrictEqual([scope.reserved]);
    expect(await (await env.ARTIFACTS.get(scope.reserved))?.text()).toBe('unrelated bytes');
  });

  it('streams a borrowed source into a fixed-width location without changing its source', async () => {
    const namespace = crypto.randomUUID().replaceAll('-', '');
    const source = `borrowed/${crypto.randomUUID()}`;
    const owner = { namespace, scopeOwner: 'a'.repeat(64), attemptId: crypto.randomUUID() };
    const location = {
      storageRef: source,
      sha256: await sha256Hex(BYTES),
      byteLength: BYTES.byteLength,
      contentType: TYPE,
    };
    await env.ARTIFACTS.put(source, BYTES as BufferSource);
    const copied = await copyRepairBlob(env.ARTIFACTS, location, owner);
    if (copied === undefined) throw new Error('no copied artifact');
    expect(copied.length).toBe(67);
    expect(copied.startsWith(`r/${namespace}/`)).toBe(true);
    expect(await (await env.ARTIFACTS.get(copied))?.text()).toBe('verified fresh replacement');
    expect(await (await env.ARTIFACTS.get(source))?.text()).toBe('verified fresh replacement');
    expect(
      repairUploadMatches(await env.ARTIFACTS.head(copied), {
        ...owner,
        sha256: location.sha256,
        byteLength: location.byteLength,
      }),
    ).toBe(true);
    expect(
      await copyRepairBlob(
        env.ARTIFACTS,
        { ...location, byteLength: location.byteLength + 1 },
        owner,
      ),
    ).toBeUndefined();
    expect(
      await copyRepairBlob(env.ARTIFACTS, { ...location, storageRef: 'missing/source' }, owner),
    ).toBeUndefined();
    await expect(
      copyRepairBlob(env.ARTIFACTS, { ...location, sha256: '0'.repeat(64) }, owner),
    ).resolves.toBeUndefined();
  });

  it('requires a positive checksum receipt, not merely matching caller metadata', async () => {
    const namespace = crypto.randomUUID().replaceAll('-', '');
    const key = createRepairStorageRef(namespace);
    const proof = {
      namespace,
      scopeOwner: 'a'.repeat(64),
      attemptId: 'attempt',
      sha256: await sha256Hex(BYTES),
      byteLength: BYTES.byteLength,
    };
    await env.ARTIFACTS.put(key, BYTES as BufferSource, {
      customMetadata: repairUploadMetadata(proof),
    });
    expect(repairUploadMatches(await env.ARTIFACTS.head(key), proof)).toBe(false);
    const object = await env.ARTIFACTS.put(key, BYTES as BufferSource, {
      sha256: proof.sha256,
      customMetadata: repairUploadMetadata(proof),
    });
    expect(repairUploadMatches(object, proof)).toBe(true);
    expect(repairUploadMatches(object, { ...proof, byteLength: proof.byteLength + 1 })).toBe(false);
  });

  it('keeps unrelated objects in the repair namespace during both sweeps and retirement', async () => {
    const namespace = crypto.randomUUID().replaceAll('-', '');
    const prefix = `r/${namespace}/`;
    const owned = createRepairStorageRef(namespace);
    const unknown = createRepairStorageRef(namespace);
    const wrongOwner = createRepairStorageRef(namespace);
    const sameNamespaceOtherScope = createRepairStorageRef(namespace);
    const proof = {
      namespace,
      scopeOwner: 'a'.repeat(64),
      attemptId: 'attempt',
      sha256: await sha256Hex(BYTES),
      byteLength: BYTES.byteLength,
    };
    await env.ARTIFACTS.put(owned, BYTES as BufferSource, {
      sha256: proof.sha256,
      customMetadata: repairUploadMetadata(proof),
    });
    await env.ARTIFACTS.put(unknown, 'unrelated');
    await env.ARTIFACTS.put(wrongOwner, 'other scope', {
      customMetadata: repairUploadMetadata({ ...proof, namespace: '0'.repeat(32) }),
    });
    await env.ARTIFACTS.put(sameNamespaceOtherScope, 'different scope with same namespace', {
      customMetadata: repairUploadMetadata({ ...proof, scopeOwner: 'b'.repeat(64) }),
    });
    const blobs = blobStore(env.ARTIFACTS, () => ({}), { repairOwner: proof.scopeOwner });
    const page = await blobs.listPage({ prefix, cursor: undefined, limit: 1000 });
    expect(page.objects.map((object) => object.key)).toStrictEqual([owned]);
    await blobs.deletePrefix(prefix);
    expect(await env.ARTIFACTS.head(owned)).toBeNull();
    expect(await env.ARTIFACTS.head(unknown)).not.toBeNull();
    expect(await env.ARTIFACTS.head(wrongOwner)).not.toBeNull();
    expect(await env.ARTIFACTS.head(sameNamespaceOtherScope)).not.toBeNull();
  });
});
