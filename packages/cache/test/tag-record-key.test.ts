import { kvTagKey, tagIdFor, tagKindOf } from '@stayingupwind/core/cache';
import { signCacheToken, type TagDeltaEntry } from '@stayingupwind/host/cache';
import type { FetchLike } from '@stayingupwind/runtime/cache-host';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import { Gateway } from '../src/function/gateway.ts';
import { createGatewayApp } from '../src/gateway/app.ts';
import { createReadGateway } from '../src/read-gateway.ts';
import { STANDALONE_AUTHORITY } from '../src/standalone/host.ts';

type GatewayKind = 'authority' | 'read';

async function gatewayFor(kind: GatewayKind) {
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
  const send = vi.fn<FetchLike>((request) => {
    const response = app.fetch(request, env, createExecutionContext());
    return Promise.resolve(response);
  });
  const client = new Gateway({
    gatewayUrl: 'https://cache.invalid',
    scopeId,
    token,
    naming: { copyCache: 'tag-identity-copies', copyKeyOrigin: 'https://copies.invalid' },
    fetchImpl: send,
  });
  return { scopeId, client, send };
}

async function recordOf(scopeId: string, value: string): Promise<TagDeltaEntry> {
  const kind = tagKindOf(value);
  return {
    tagId: await tagIdFor(scopeId, kind, value),
    kind,
    value,
    revision: 3,
    staleAt: 1_800_000_000_000,
    hardExpireAt: null,
    meaning: 'immediate',
  };
}

async function keep(scopeId: string, keyTagId: string, record: TagDeltaEntry): Promise<void> {
  await env.CACHE_STATE.put(kvTagKey(scopeId, keyTagId), JSON.stringify(record));
}

describe.each(['authority', 'read'] as const)('tag identities at the %s gateway', (kind) => {
  it('refuses a requested tag replaced by another requested tag, then reads its repair', async () => {
    const { scopeId, client, send } = await gatewayFor(kind);
    const a = await recordOf(scopeId, 'A');
    const b = await recordOf(scopeId, 'B');
    await keep(scopeId, a.tagId, b);
    await keep(scopeId, b.tagId, b);

    await expect(client.getTags(['A', 'B'])).rejects.toMatchObject({
      code: 'internal',
      status: 500,
    });
    expect(send).toHaveBeenCalledTimes(1);

    await keep(scopeId, a.tagId, a);
    const repaired = await client.getTags(['A', 'B']);

    expect(repaired.tags).toHaveLength(2);
    expect(repaired.tags).toStrictEqual(expect.arrayContaining([a, b]));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('refuses a matching value whose embedded tag id belongs to another scope', async () => {
    const { scopeId, client } = await gatewayFor(kind);
    const a = await recordOf(scopeId, 'A');
    const foreign = await recordOf(`${scopeId}_other`, 'A');
    await keep(scopeId, a.tagId, foreign);

    await expect(client.getTags(['A'])).rejects.toMatchObject({ code: 'internal', status: 500 });
  });

  it('keeps explicit, implicit, duplicate and absent tag reads under their own keys', async () => {
    const { scopeId, client, send } = await gatewayFor(kind);
    const explicit = await recordOf(scopeId, 'A');
    const implicit = await recordOf(scopeId, '_N_T_/layout');
    await keep(scopeId, explicit.tagId, explicit);
    await keep(scopeId, implicit.tagId, implicit);
    const answer = await client.getTags(['A', '_N_T_/layout', 'missing', 'A']);

    expect(answer.tags).toHaveLength(2);
    expect(answer.tags).toStrictEqual(expect.arrayContaining([explicit, implicit]));
    expect(send).toHaveBeenCalledTimes(1);
  });
});
