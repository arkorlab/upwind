import { timingSafeEqual } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface Agent {
  fetch: (request: Request, env: Record<string, unknown>) => Promise<Response>;
}

// This suite runs under Node; the Worker is typechecked separately with workerd's globals.
const agentPath = '../src/workers/agent.ts';
const { default: agent } = (await import(agentPath)) as { default: Agent };

describe('the local deployment agent credential', () => {
  beforeAll(() => vi.stubGlobal('crypto', { subtle: { timingSafeEqual } }));

  afterAll(() => vi.unstubAllGlobals());

  it.each([
    ['GET', '/kv/key'],
    ['PUT', '/kv/key'],
    ['GET', '/blob/key'],
    ['PUT', '/blob/key'],
    ['POST', '/cache/seed-scope'],
    ['POST', '/cache/seed-entries'],
  ])(
    'refuses unauthenticated %s %s before reading storage or parsing a body',
    async (method, route) => {
      const env = { DEPLOY_AGENT_TOKEN: 'only-this-stack' } as Parameters<typeof agent.fetch>[1];
      const request = new Request(`http://localhost${route}`, {
        method,
        ...(method !== 'GET' && { body: 'not JSON' }),
      });

      expect((await agent.fetch(request, env)).status).toBe(401);

      request.headers.set('authorization', 'Bearer another-stack');

      expect((await agent.fetch(request, env)).status).toBe(401);
    },
  );

  it('accepts the credential of this stack and fails closed without an agent binding', async () => {
    const get = vi.fn().mockResolvedValue('value');
    const env = {
      DEPLOY_AGENT_TOKEN: 'only-this-stack',
      EDGE_STATE: { get },
    } as unknown as Parameters<typeof agent.fetch>[1];
    const request = new Request('http://localhost/kv/key', {
      headers: { authorization: 'Bearer only-this-stack' },
    });

    await expect((await agent.fetch(request, env)).text()).resolves.toBe('value');
    expect(get).toHaveBeenCalledExactlyOnceWith('key', 'arrayBuffer');

    request.headers.set('authorization', 'Bearer only-this-stacx');

    expect((await agent.fetch(request, env)).status).toBe(401);
    expect((await agent.fetch(request, {})).status).toBe(401);
  });
});
