import { sha256Hex } from '@stayingupwind/core/artifact';
import { buildGenerationIdFor, deriveEntry, policyFromBuild } from '@stayingupwind/core/cache';
import { TEST_CLOCK_HEADER } from '@stayingupwind/core/paas';
import { createId, fromBase64, toBase64 } from '@stayingupwind/core/util';
import {
  type DataSetRequest,
  MAX_INLINE_DATA_VALUE_BYTES,
  signCacheToken,
} from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import {
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';
import { createGatewayApp } from '../src/gateway/app.ts';
import { artifactFailed, findArtifactBySha } from '../src/scope/artifacts.ts';
import { requireActiveScope, writeMeta } from '../src/scope/state.ts';
import { scopeStub } from '../src/scope/stub.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';

const NOW = 1_800_000_000_000;
const ABOVE_CARRIED_BYTES = 65 * 1024;
const KIND = 'data:fetch';

/** Real gateway upload/adoption and real DO tables; only its dispatch transport is in process. */
async function fixture(length: number, borrowed: boolean) {
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
  const bytes = new TextEncoder().encode('x'.repeat(length));
  const sha256 = await sha256Hex(bytes);
  const descriptor = { kind: 'app-page', route: '/', pathname: '/' } as const;
  const { entryId } = await deriveEntry(scopeId, descriptor);
  if (borrowed) {
    const storageRef = `build/${scopeId}/${sha256}`;
    await env.ARTIFACTS.put(storageRef, bytes);
    await stub.seedEntries(
      {
        scopeId,
        batchIndex: 0,
        entries: [
          {
            descriptor,
            groupInstanceId: null,
            generation: {
              generationId: await buildGenerationIdFor(scopeId, entryId),
              cacheTimestamp: NOW,
              producedAt: NOW,
              policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
              status: 200,
              headers: { 'content-type': 'text/html' },
              tags: [],
              dependencyCoverage: 'complete',
              outputs: [
                {
                  representationKey: 'html',
                  pathname: '/',
                  status: 200,
                  headers: {},
                  compute: 'static',
                  response: 'complete',
                  htmlSize: bytes.byteLength,
                  artifacts: [
                    {
                      role: 'html',
                      sha256,
                      byteLength: bytes.byteLength,
                      contentType: 'text/html',
                      encoding: 'identity',
                      storageRef,
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
      NOW,
    );
  }
  const token = await signCacheToken(
    env.CACHE_TOKEN_KEY ?? '',
    scopeId,
    STANDALONE_AUTHORITY.naming,
  );
  const app = createGatewayApp(STANDALONE_AUTHORITY);
  const contexts: ExecutionContext[] = [];
  const send: FetchLike = (request) => {
    const ctx = createExecutionContext();
    contexts.push(ctx);
    const headers = new Headers(request.headers);
    headers.set(TEST_CLOCK_HEADER, String(NOW));
    const response = app.fetch(new Request(request, { headers }), env, ctx);
    return Promise.resolve(response);
  };
  const client = new Gateway({
    scopeId,
    token,
    gatewayUrl: 'https://cache.invalid',
    naming: { copyCache: 'data-repair-copies', copyKeyOrigin: 'https://copies.invalid' },
    fetchImpl: send,
  });
  return {
    scopeId,
    stub,
    client,
    bytes,
    sha256,
    seedEntryId: borrowed ? entryId : undefined,
    async drain() {
      await Promise.all(contexts.splice(0).map((ctx) => waitOnExecutionContext(ctx)));
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function requestFor(
  test: Fixture,
  key: string,
  timestamp: number,
  order?: DataSetRequest['order'],
): DataSetRequest {
  return {
    key,
    entry: {
      kind: KIND,
      tags: ['shared'],
      stale: 300,
      timestamp,
      expire: 900,
      revalidate: 60,
      dependencyCoverage: 'complete',
    },
    valueBase64: toBase64(test.bytes),
    ...(order !== undefined && { order }),
  };
}

function stateFor(test: Fixture) {
  return runInDurableObject(test.stub, (_instance, state) => {
    const { sql } = state.storage;
    const artifact = findArtifactBySha(sql, test.sha256);
    if (artifact === undefined) throw new Error('the fixture has no artifact');
    const scope = requireActiveScope(sql);
    if ('kind' in scope) throw new Error('the fixture scope is unavailable');
    const locations = sql
      .exec<{ storage_ref: string }>(
        `SELECT json_extract(a.value, '$.storageRef') AS storage_ref FROM entries e
         JOIN generations g ON g.generation_id = e.current_generation_id,
         json_each(g.outputs) o, json_each(o.value, '$.artifacts') a
         WHERE json_extract(a.value, '$.sha256') = ? ORDER BY e.entry_id`,
        test.sha256,
      )
      .toArray();
    return {
      artifact,
      bodyBytes: scope.body_bytes,
      failed: artifactFailed(sql, artifact),
      locations,
    };
  });
}

/** Queue a real projection so its existing blob read, length and digest check record the failure. */
async function breakValue(test: Fixture, entryId: string, fault: 'missing' | 'digest') {
  const before = await stateFor(test);
  if (fault === 'missing') await env.ARTIFACTS.delete(before.artifact.storage_ref);
  else await env.ARTIFACTS.put(before.artifact.storage_ref, new Uint8Array(test.bytes.length));
  await runInDurableObject(test.stub, (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE entries SET record_revision = record_revision + 1, kv_revision = 0 WHERE entry_id = ?`,
      test.seedEntryId ?? entryId,
    );
  });
  await test.stub.tick(NOW);
  return stateFor(test);
}

async function valueOf(test: Fixture, key: string): Promise<Uint8Array> {
  const response = await test.client.getData({ key, kind: KIND });
  if (response === undefined) throw new Error('the fixture value was not projected');
  if (response.value.kind === 'inline') return fromBase64(response.value.base64);
  const bytes = await test.client.readArtifact(response.value.artifactId);
  if (bytes === undefined) throw new Error('the referenced value was not readable');
  return bytes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a data upload replacing a known broken canonical artifact', () => {
  it.each([
    { kind: 'inline above the carried limit', length: ABOVE_CARRIED_BYTES },
    { kind: 'reference', length: MAX_INLINE_DATA_VALUE_BYTES + 1 },
  ])(
    'repairs a borrowed $kind and every live reference without replacing its generation',
    async ({ length }) => {
      const test = await fixture(length, true);
      const first = await test.client.setData(requestFor(test, 'first', NOW));
      await test.client.setData(requestFor(test, 'second', NOW));
      const broken = await breakValue(test, first.entryId, 'missing');
      const put = vi.spyOn(env.ARTIFACTS, 'put');

      const rewritten = await test.client.setData(requestFor(test, 'first', NOW));
      await test.drain();
      await test.stub.tick(NOW);
      const repaired = await stateFor(test);

      expect(broken).toMatchObject({ artifact: { owned: 0 }, bodyBytes: 0, failed: true });
      expect(rewritten.generationId).toBe(first.generationId);
      expect(put).toHaveBeenCalledTimes(1);
      expect(repaired).toMatchObject({
        artifact: { owned: 1, refs: broken.artifact.refs },
        bodyBytes: length,
        failed: false,
        locations: Array.from({ length: 3 }, () => ({
          storage_ref: repaired.artifact.storage_ref,
        })),
      });
      expect(repaired.artifact.storage_ref).not.toBe(broken.artifact.storage_ref);
      await expect(valueOf(test, 'first')).resolves.toStrictEqual(test.bytes);
      await expect(valueOf(test, 'second')).resolves.toStrictEqual(test.bytes);
    },
  );

  it('replaces a corrupt owned value with one PUT and no extra body-byte charge', async () => {
    const test = await fixture(ABOVE_CARRIED_BYTES, false);
    const first = await test.client.setData(requestFor(test, 'value', NOW));
    const broken = await breakValue(test, first.entryId, 'digest');
    const put = vi.spyOn(env.ARTIFACTS, 'put');

    const rewritten = await test.client.setData(requestFor(test, 'value', NOW + 1));
    await test.drain();
    const repaired = await stateFor(test);

    expect(broken.failed).toBe(true);
    expect(rewritten.generationId).not.toBe(first.generationId);
    expect(put).toHaveBeenCalledTimes(1);
    expect(repaired.bodyBytes).toBe(broken.bodyBytes);
    expect(repaired.artifact.storage_ref).not.toBe(broken.artifact.storage_ref);
    expect(repaired.failed).toBe(false);
    await expect(valueOf(test, 'value')).resolves.toStrictEqual(test.bytes);
  });

  it('keeps healthy deduplication and unchanged-generation replies', async () => {
    const test = await fixture(ABOVE_CARRIED_BYTES, false);
    const request = requestFor(test, 'value', NOW);
    const first = await test.client.setData(request);
    const before = await stateFor(test);
    const put = vi.spyOn(env.ARTIFACTS, 'put');

    const repeated = await test.client.setData(request);
    await test.drain();

    expect(repeated).toStrictEqual(first);
    expect(put).toHaveBeenCalledTimes(1);
    await expect(stateFor(test)).resolves.toStrictEqual(before);
    await expect(valueOf(test, 'value')).resolves.toStrictEqual(test.bytes);
  });

  it('does not adopt a superseded writer upload even when the canonical value failed', async () => {
    const test = await fixture(ABOVE_CARRIED_BYTES, false);
    const first = await test.client.setData(
      requestFor(test, 'value', NOW, { writer: 'writer', seq: 2 }),
    );
    const broken = await breakValue(test, first.entryId, 'missing');

    const superseded = await test.client.setData(
      requestFor(test, 'value', NOW, { writer: 'writer', seq: 1 }),
    );
    await test.drain();

    expect(superseded).toMatchObject({ generationId: first.generationId, superseded: true });
    await expect(stateFor(test)).resolves.toStrictEqual(broken);
  });

  it('refuses a borrowed-to-owned repair before changing quota or any references', async () => {
    const test = await fixture(ABOVE_CARRIED_BYTES, true);
    const first = await test.client.setData(requestFor(test, 'value', NOW));
    const broken = await breakValue(test, first.entryId, 'missing');
    await test.stub.setTestLimits({ bodyBytesPerScope: test.bytes.length - 1 });

    await expect(test.client.setData(requestFor(test, 'value', NOW))).rejects.toMatchObject({
      code: 'quota_exceeded',
    });
    await test.drain();

    await expect(stateFor(test)).resolves.toStrictEqual(broken);
  });

  it('keeps the control-fence refusal ahead of repair adoption', async () => {
    const test = await fixture(ABOVE_CARRIED_BYTES, false);
    const first = await test.client.setData(requestFor(test, 'value', NOW));
    const broken = await breakValue(test, first.entryId, 'missing');
    await runInDurableObject(test.stub, (_instance, state) => {
      writeMeta(
        state.storage.sql,
        'control_tag_fence_floor',
        JSON.stringify({ revision: 100, timestamp: NOW }),
      );
    });

    await expect(test.client.setData(requestFor(test, 'value', NOW))).rejects.toMatchObject({
      code: 'lease_expired',
    });
    await test.drain();

    await expect(stateFor(test)).resolves.toStrictEqual(broken);
  });
});
