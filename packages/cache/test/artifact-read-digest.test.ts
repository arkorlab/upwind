import { sha256Hex } from '@stayingupwind/core/artifact';
import {
  artifactIdFor,
  buildGenerationIdFor,
  deriveEntry,
  policyFromBuild,
  r2BlobKey,
} from '@stayingupwind/core/cache';
import { createId, encodeUtf8, toHex } from '@stayingupwind/core/util';
import { gatewayScopePath, type SeedEntryInput, signCacheToken } from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';
import { createGatewayApp } from '../src/gateway/app.ts';
import { artifactFailed, findArtifactBySha } from '../src/scope/artifacts.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';

/**
 * An artifact read checks what storage keeps of the bytes against what the authority names, with
 * nothing of the body read (Codex): bytes storage says are other bytes are refused before any of
 * them goes out, and the authority is told, so that the next upload of the bytes repairs them.
 */

const NOW = 1_800_000_000_000;
const BODY = '<html>the bytes the scope names</html>';
const OTHER = '<html>other bytes, of the same size</html>'.slice(0, BODY.length);
const TYPE = 'text/html; charset=utf-8';

async function scopeWithArtifact(stored: { readonly bytes: string; readonly digest: boolean }) {
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
  const bytes = encodeUtf8(BODY);
  const sha256 = await sha256Hex(bytes);
  const storageRef = `build/${scopeId}/${sha256}`;
  // Seeded as the scope names the bytes, then written over as the case has storage hold them.
  await env.ARTIFACTS.put(storageRef, bytes as BufferSource, { sha256 });
  const descriptor = { kind: 'app-page', route: '/', pathname: '/' } as const;
  const { entryId } = await deriveEntry(scopeId, descriptor);
  const artifact = {
    role: 'html' as const,
    sha256,
    byteLength: bytes.byteLength,
    contentType: TYPE,
    encoding: 'identity' as const,
    storageRef,
  };
  const seed: SeedEntryInput = {
    descriptor,
    groupInstanceId: null,
    generation: {
      generationId: await buildGenerationIdFor(scopeId, entryId),
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
          pathname: '/',
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
  await stub.seedEntries({ scopeId, batchIndex: 0, entries: [seed] }, NOW);
  const held = encodeUtf8(stored.bytes);
  await env.ARTIFACTS.put(
    storageRef,
    held as BufferSource,
    stored.digest ? { sha256: await sha256Hex(held) } : {},
  );
  const token = await signCacheToken(
    env.CACHE_TOKEN_KEY ?? '',
    scopeId,
    STANDALONE_AUTHORITY.naming,
  );
  return {
    scopeId,
    stub,
    token,
    sha256,
    artifactId: await artifactIdFor(scopeId, sha256),
    descriptor,
  };
}

type Scope = Awaited<ReturnType<typeof scopeWithArtifact>>;

const app = createGatewayApp(STANDALONE_AUTHORITY);

/** The gateway's answer to a read of the artifact, as the Function's client asks it. */
async function read(scope: Scope): Promise<Response> {
  const url = `https://cache.invalid${gatewayScopePath(scope.scopeId)}/artifacts/${scope.artifactId}`;
  return app.fetch(
    new Request(url, { headers: { authorization: `Bearer ${scope.token}` } }),
    env,
    createExecutionContext(),
  );
}

/** A lease on the scope's one entry, to upload under. */
async function lease(scope: Scope) {
  const started = await scope.stub.startAttempt({ entry: scope.descriptor, reason: 'miss' }, NOW);
  if (started.kind !== 'leased') throw new Error(`the test needs a lease, got ${started.kind}`);
  return started;
}

/** The digest storage keeps of an object, as hex; nothing where it keeps none. */
async function storedDigest(key: string): Promise<string | undefined> {
  const digest = (await env.ARTIFACTS.head(key))?.checksums.sha256;
  return digest === undefined ? undefined : toHex(new Uint8Array(digest));
}

async function failed(scope: Scope): Promise<boolean> {
  return runInDurableObject(scope.stub, (_instance, state) => {
    const row = findArtifactBySha(state.storage.sql, scope.sha256);
    return row !== undefined && artifactFailed(state.storage.sql, row);
  });
}

describe('an artifact read, against what storage keeps of the bytes', () => {
  it('serves bytes storage says are the ones named, and marks nothing', async () => {
    const scope = await scopeWithArtifact({ bytes: BODY, digest: true });
    const response = await read(scope);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(BODY);
    await expect(failed(scope)).resolves.toBe(false);
  });

  it('refuses bytes storage says are others, and marks the artifact for its repair', async () => {
    const scope = await scopeWithArtifact({ bytes: OTHER, digest: true });
    const response = await read(scope);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'artifact_mismatch' },
    });
    await expect(failed(scope)).resolves.toBe(true);
  });

  it('answers bytes stored without a digest as their length allows, as before', async () => {
    const scope = await scopeWithArtifact({ bytes: OTHER, digest: false });
    const response = await read(scope);

    // Nothing to compare without reading the body: the Function hashes what it keeps of it.
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(OTHER);
    await expect(failed(scope)).resolves.toBe(false);
  });

  it('stores an upload with its digest, for a read to compare', async () => {
    const scope = await scopeWithArtifact({ bytes: BODY, digest: true });
    const started = await lease(scope);
    const send = vi.fn<FetchLike>((request) =>
      Promise.resolve(app.fetch(request, env, createExecutionContext())),
    );
    const client = new Gateway({
      scopeId: scope.scopeId,
      token: scope.token,
      gatewayUrl: 'https://cache.invalid',
      naming: { copyCache: 'artifact-read-digest', copyKeyOrigin: 'https://copies.invalid' },
      fetchImpl: send,
    });
    const bytes = encodeUtf8('<html>an upload of its own</html>');
    await client.uploadArtifact({
      attemptId: started.attemptId,
      fencingToken: started.fencingToken,
      role: 'html',
      contentType: TYPE,
      bytes,
    });
    const sha256 = await sha256Hex(bytes);

    await expect(storedDigest(r2BlobKey(scope.scopeId, sha256))).resolves.toBe(sha256);
  });
});
