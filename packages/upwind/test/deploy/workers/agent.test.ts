import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AGENT_PATHS } from '../../../src/deploy/workers/protocol.ts';
import { AGENT_KEY, type RunningStack, runStack } from './stack.ts';

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('the deploy agent', () => {
  let stack: RunningStack;
  let unkeyed: RunningStack;

  const ask = async (
    path: string,
    init: RequestInit & { readonly key?: string; readonly on?: string } = {},
  ): Promise<Response> => {
    const { key = AGENT_KEY, on = 'agent', ...rest } = init;
    return fetch(new URL(path, await stack.url(on)), {
      ...rest,
      headers: { ...(rest.headers as Record<string, string>), authorization: `Bearer ${key}` },
    });
  };

  beforeAll(async () => {
    stack = await runStack();
    unkeyed = await runStack({ agentKey: '' });
  }, 60_000);

  afterAll(async () => {
    await stack.dispose();
    await unkeyed.dispose();
  });

  it('answers nothing without a key of its own, and nobody without the key it holds', async () => {
    const without = await fetch(new URL(AGENT_PATHS.health, await unkeyed.url('agent')), {
      headers: { authorization: `Bearer ${AGENT_KEY}` },
    });

    expect(without.status).toBe(503);
    expect((await ask(AGENT_PATHS.health, { key: 'x'.repeat(48) })).status).toBe(401);
    expect((await ask(AGENT_PATHS.health, { key: '' })).status).toBe(401);
    expect((await ask(AGENT_PATHS.health)).status).toBe(204);
  });

  it('stores an artifact under its own digest, and nothing else under it', async () => {
    const text = 'a shell';
    const artifact = `art:${sha256(text)}`;
    const key = `${AGENT_PATHS.kv}${encodeURIComponent(artifact)}`;

    expect((await ask(key, { method: 'PUT', body: text })).status).toBe(204);
    await expect((await ask(key)).text()).resolves.toBe(text);
    expect((await ask(key, { method: 'PUT', body: text })).status).toBe(204);
    expect(
      (await ask(`${AGENT_PATHS.kv}art:${sha256('other')}`, { method: 'PUT', body: text })).status,
    ).toBe(422);
  });

  it('writes a policy once, and refuses what no deployment writes', async () => {
    const policy = `${AGENT_PATHS.kv}${encodeURIComponent('policy:custom')}`;

    expect((await ask(policy, { method: 'PUT', body: '{"a":1}' })).status).toBe(204);
    expect((await ask(policy, { method: 'PUT', body: '{"a":1}' })).status).toBe(204);
    expect((await ask(policy, { method: 'PUT', body: '{"a":2}' })).status).toBe(409);
    expect((await ask(`${AGENT_PATHS.kv}pointer`, { method: 'PUT', body: '{}' })).status).toBe(403);
    expect((await ask(`${AGENT_PATHS.blob}anything`, { method: 'PUT', body: '' })).status).toBe(
      403,
    );
  });

  it('stores a blob under its digest, and says which of a list it does not hold', async () => {
    const text = 'a file';
    const held = `blobs/${sha256(text)}`;
    const absent = `blobs/${sha256('absent')}`;

    expect(
      (
        await ask(`${AGENT_PATHS.blob}${encodeURIComponent(held)}`, {
          method: 'PUT',
          body: text,
          headers: { 'content-type': 'text/plain' },
        })
      ).status,
    ).toBe(204);
    expect(
      (await ask(`${AGENT_PATHS.blob}${encodeURIComponent(absent)}`, { method: 'PUT', body: text }))
        .status,
    ).toBe(422);

    const missing = await ask(AGENT_PATHS.missing, {
      method: 'POST',
      body: JSON.stringify({ keys: [held, absent] }),
    });

    await expect(missing.json()).resolves.toStrictEqual({ missing: [absent] });
  });

  it('writes a build once, and deletes only for a project being destroyed', async () => {
    const bundle = `${AGENT_PATHS.blob}${encodeURIComponent(
      'deployments/shop/dpl_4Fixture2Minima1AppXy/bundle.json',
    )}`;

    expect((await ask(bundle, { method: 'PUT', body: '{"v":1}' })).status).toBe(204);
    expect((await ask(bundle, { method: 'PUT', body: '{"v":2}' })).status).toBe(409);
    expect((await ask(AGENT_PATHS.purge, { method: 'POST' })).status).toBe(403);

    const purged = await ask(AGENT_PATHS.purge, { method: 'POST', on: 'agent-destroying' });

    await expect(purged.json()).resolves.toMatchObject({ more: false });
    expect((await ask(bundle)).status).toBe(404);
  });
});
