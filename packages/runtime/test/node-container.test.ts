import { afterAll, describe, expect, it, vi } from 'vitest';

import { startNodeContainer, type NodeContainerServer } from '../src/node-container.ts';

const TOKEN = 'synthetic-node-control-token-with-32-bytes';
const oldConfiguration = process.env['ARKOR_NODE_RUNTIME'];
process.env['ARKOR_NODE_RUNTIME'] = JSON.stringify({
  v: 1,
  deploymentId: 'synthetic-deployment',
  functionName: 'app',
  controlToken: TOKEN,
  capabilities: { services: {} },
});

afterAll(() => {
  if (oldConfiguration === undefined) delete process.env['ARKOR_NODE_RUNTIME'];
  else process.env['ARKOR_NODE_RUNTIME'] = oldConfiguration;
});

function internal(
  server: NodeContainerServer,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: { 'x-upwind-control-token': TOKEN, ...init.headers },
  });
}

describe('Node container HTTP service', () => {
  it('authenticates controls and preserves public routes spelling a control pathname', async () => {
    const observed: unknown[] = [];
    const server = await startNodeContainer({
      port: 0,
      entry: {
        fetch: (request, _env, context) => {
          observed.push({
            url: request.url,
            host: request.headers.get('host'),
            internal: [...request.headers.keys()].filter((name) => name.startsWith('x-upwind-')),
            props: context.props,
          });
          return Promise.resolve(new Response('application'));
        },
      },
    });
    try {
      const refused = await fetch(`http://127.0.0.1:${server.port}/__upwind/ready`);
      const ready = await internal(server, '/__upwind/ready');
      const customer = await internal(server, '/__upwind/ready', {
        headers: {
          'x-upwind-request-url': 'https://customer.example/__upwind/ready',
          'x-upwind-client-props': '{"resourceWarm":true}',
        },
      });

      expect(refused.status).toBe(403);
      expect(await ready.json()).toEqual({ v: 1, ready: true });
      expect(await customer.text()).toBe('application');
      expect(observed).toEqual([
        {
          url: 'https://customer.example/__upwind/ready',
          host: 'customer.example',
          internal: [],
          props: undefined,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('streams before completion, preserves separate cookies, and drains waitUntil after the response', async () => {
    const releaseBody = Promise.withResolvers<void>();
    const releaseTask = Promise.withResolvers<void>();
    const server = await startNodeContainer({
      port: 0,
      entry: {
        fetch: (_request, _env, context) => {
          context.waitUntil(releaseTask.promise);
          const body = new ReadableStream<Uint8Array>({
            start: async (controller) => {
              controller.enqueue(new TextEncoder().encode('first'));
              await releaseBody.promise;
              controller.enqueue(new TextEncoder().encode('last'));
              controller.close();
            },
          });
          const headers = new Headers();
          headers.append('set-cookie', 'one=1; Path=/');
          headers.append('set-cookie', 'two=2; Path=/');
          return Promise.resolve(new Response(body, { headers }));
        },
      },
    });
    try {
      const response = await internal(server, '/page', {
        headers: { 'x-upwind-request-url': 'https://example.test/page' },
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      const pending = await internal(server, '/__upwind/tasks');

      expect(new TextDecoder().decode(first.value)).toBe('first');
      expect(response.headers.getSetCookie()).toEqual(['one=1; Path=/', 'two=2; Path=/']);
      expect(await pending.json()).toEqual({
        v: 1,
        activeRequests: 1,
        backgroundTasks: 1,
        draining: false,
      });

      releaseBody.resolve();
      const last = await reader.read();

      expect(new TextDecoder().decode(last.value)).toBe('last');

      await reader.read();
      releaseTask.resolve();
      const drained = await internal(server, '/__upwind/drain', { method: 'POST' });

      expect(await drained.json()).toEqual({
        v: 1,
        drained: true,
        activeRequests: 0,
        backgroundTasks: 0,
        draining: false,
      });
    } finally {
      releaseBody.resolve();
      releaseTask.resolve();
      await server.close();
    }
  });

  it('cancels a safe response stream when its consumer disconnects', async () => {
    const canceled = vi.fn();
    const server = await startNodeContainer({
      port: 0,
      entry: {
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  controller.enqueue(new Uint8Array([1]));
                },
                cancel: canceled,
              }),
            ),
          ),
      },
    });
    try {
      const abort = new AbortController();
      const response = await internal(server, '/', {
        signal: abort.signal,
        headers: { 'x-upwind-request-url': 'https://example.test/' },
      });
      const reader = response.body!.getReader();
      await reader.read();
      abort.abort();

      await vi.waitFor(() => {
        expect(canceled).toHaveBeenCalledOnce();
      });
    } finally {
      await server.close();
    }
  });
});
