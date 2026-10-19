import { sha256Hex } from '@stayingupwind/core/artifact';
import { encodeGenerationPack, kvGenerationKey, policyFromBuild } from '@stayingupwind/core/cache';
import { encodeUtf8 } from '@stayingupwind/core/util';
import { signCacheToken } from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';
import { createGatewayApp } from '../src/gateway/app.ts';
import { readRecordAnswer } from '../src/gateway/record-answer.ts';
import { createReadGateway } from '../src/read-gateway.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';

async function pack(scopeId: string, entryId: string): Promise<Uint8Array> {
  const html = encodeUtf8(`<p>${scopeId}/${entryId}</p>`);
  return encodeGenerationPack(
    {
      schemaVersion: 1,
      scopeId,
      entryId,
      generationId: 'generation',
      seq: 1,
      revision: 1,
      source: 'build',
      kind: 'app-page',
      route: '/',
      pathname: '/',
      cacheTimestamp: 100,
      producedAt: 100,
      policy: policyFromBuild({ initialRevalidate: 60, initialExpiration: 600 }),
      status: 200,
      headers: { 'content-type': 'text/html' },
      tags: [],
      htmlSha256: await sha256Hex(html),
      htmlLength: html.byteLength,
      postponedSha256: null,
      postponedLength: 0,
      artifacts: [],
    },
    html,
    undefined,
  );
}

async function gatewayFor(kind: 'authority' | 'read') {
  const scopeId = `scope_${crypto.randomUUID()}`;
  const token = await signCacheToken(
    env.CACHE_TOKEN_KEY ?? '',
    scopeId,
    STANDALONE_AUTHORITY.naming,
  );
  const app =
    kind === 'authority'
      ? createGatewayApp(STANDALONE_AUTHORITY)
      : createReadGateway(STANDALONE_AUTHORITY);
  const send = vi.fn<FetchLike>((request) =>
    Promise.resolve(app.fetch(request, env, createExecutionContext())),
  );
  const client = new Gateway({
    gatewayUrl: 'https://cache.invalid',
    scopeId,
    token,
    naming: { copyCache: 'record-identity-copies', copyKeyOrigin: 'https://copies.invalid' },
    fetchImpl: send,
  });
  return { scopeId, client, send };
}

describe.each(['authority', 'read'] as const)('delivery identities at the %s gateway', (kind) => {
  it.each(['entry', 'scope'] as const)(
    'refuses another %s at the requested key and reads its repair',
    async (mismatch) => {
      const { scopeId, client, send } = await gatewayFor(kind);
      const entryId = 'requested';
      const wrong = await pack(
        mismatch === 'scope' ? `${scopeId}_other` : scopeId,
        mismatch === 'entry' ? 'other' : entryId,
      );
      const key = kvGenerationKey(scopeId, entryId);
      await env.CACHE_STATE.put(key, wrong);

      await expect(client.readRecord(entryId)).rejects.toMatchObject({
        code: 'internal',
        status: 500,
      });
      expect(send).toHaveBeenCalledTimes(1);

      const correct = await pack(scopeId, entryId);
      await env.CACHE_STATE.put(key, correct);
      const repaired = await client.readRecord(entryId);

      expect(repaired).toStrictEqual(correct);
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps a matching record and an absent entry distinct', async () => {
    const { scopeId, client, send } = await gatewayFor(kind);
    const bytes = await pack(scopeId, 'present');
    await env.CACHE_STATE.put(kvGenerationKey(scopeId, 'present'), bytes);

    await expect(client.readRecord('present')).resolves.toStrictEqual(bytes);
    await expect(client.readRecord('absent')).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('a mismatched delivery header', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['entry', 'scope'] as const)(
    'cancels a wrong %s before reading its body',
    async (kind) => {
      const bytes = await pack(
        kind === 'scope' ? 'other' : 'scope',
        kind === 'entry' ? 'other' : 'entry',
      );
      const headerEnd = 9 + new DataView(bytes.buffer, bytes.byteOffset, 9).getUint32(5, true);
      const tailRead = vi.fn();
      const cancelled = vi.fn();
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(bytes.subarray(0, headerEnd));
          },
          pull(controller) {
            tailRead();
            controller.enqueue(bytes.subarray(headerEnd));
            controller.close();
          },
          cancel: cancelled,
        },
        { highWaterMark: 0 },
      );
      const kv: {
        get(
          key: string,
          options: { type: 'stream'; cacheTtl?: number },
        ): Promise<ReadableStream<Uint8Array> | null>;
      } = env.CACHE_STATE;
      const get = vi.spyOn(kv, 'get').mockResolvedValue(stream);

      await expect(readRecordAnswer(env.CACHE_STATE, 'key', 'scope', 'entry')).rejects.toThrow(
        'the delivery record does not belong to the requested scope and entry',
      );
      expect(get).toHaveBeenCalledExactlyOnceWith('key', { type: 'stream', cacheTtl: 30 });
      expect(tailRead).not.toHaveBeenCalled();
      expect(cancelled).toHaveBeenCalledTimes(1);
    },
  );
});
