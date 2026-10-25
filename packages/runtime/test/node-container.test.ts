/* eslint-disable unicorn/prefer-dispose -- This server exposes close() with a drain result, not an async-disposal method. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startNodeContainer, type NodeContainerServer } from '../src/node-container.ts';

const TOKEN = 'synthetic-node-control-token-with-32-bytes';
const CONFIGURATION = JSON.stringify({
  v: 1,
  deploymentId: 'synthetic-deployment',
  functionName: 'app',
  controlToken: TOKEN,
  capabilities: { services: {} },
});

function internal(
  server: NodeContainerServer,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-upwind-control-token', TOKEN);
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers,
  });
}

describe('node container HTTP service', () => {
  beforeAll(() => {
    vi.stubEnv('ARKOR_NODE_RUNTIME', CONFIGURATION);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('consumes bootstrap configuration before evaluating the lazy application entry', async () => {
    vi.stubEnv('ARKOR_NODE_RUNTIME', CONFIGURATION);
    const observations: unknown[] = [];
    const server = await startNodeContainer({
      port: 0,
      loadEntry: () => {
        observations.push(process.env['ARKOR_NODE_RUNTIME']);
        return Promise.resolve({ fetch: () => Promise.resolve(new Response('loaded')) });
      },
    });
    try {
      const ready = await internal(server, '/__upwind/ready');

      expect(observations).toStrictEqual([undefined]);
      await expect(ready.json()).resolves.toStrictEqual({ v: 1, ready: true });
    } finally {
      await server.close();
    }
  });

  it('authenticates controls and preserves public routes spelling a control pathname', async () => {
    const observed: unknown[] = [];
    const server = await startNodeContainer({
      port: 0,
      entry: {
        fetch: (request, env, context) => {
          const dump = JSON.stringify(env);
          observed.push({
            url: request.url,
            host: request.headers.get('host'),
            internal: [...request.headers.keys()].filter((name) => name.startsWith('x-upwind-')),
            props: context.props,
            bootstrapVisible: dump.includes('ARKOR_NODE_RUNTIME'),
            tokenVisible: dump.includes(TOKEN),
            processBootstrap: process.env['ARKOR_NODE_RUNTIME'],
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
      await expect(ready.json()).resolves.toStrictEqual({ v: 1, ready: true });
      await expect(customer.text()).resolves.toBe('application');
      expect(observed).toStrictEqual([
        {
          url: 'https://customer.example/__upwind/ready',
          host: 'customer.example',
          internal: [],
          props: undefined,
          bootstrapVisible: false,
          tokenVisible: false,
          processBootstrap: undefined,
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it('streams before completion, preserves separate cookies, and drains waitUntil after the response', async () => {
    const releaseBody = Promise.withResolvers<undefined>();
    const releaseTask = Promise.withResolvers<undefined>();
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
      expect(response.headers.getSetCookie()).toStrictEqual(['one=1; Path=/', 'two=2; Path=/']);
      await expect(pending.json()).resolves.toStrictEqual({
        v: 1,
        activeRequests: 1,
        backgroundTasks: 1,
        draining: false,
      });

      releaseBody.resolve(undefined);
      const last = await reader.read();

      expect(new TextDecoder().decode(last.value)).toBe('last');

      await reader.read();
      releaseTask.resolve(undefined);
      const drained = await internal(server, '/__upwind/drain', { method: 'POST' });

      await expect(drained.json()).resolves.toStrictEqual({
        v: 1,
        drained: true,
        activeRequests: 0,
        backgroundTasks: 0,
        draining: false,
      });
    } finally {
      releaseBody.resolve(undefined);
      releaseTask.resolve(undefined);
      await server.close();
    }
  });

  it('cancels a safe response stream when its consumer disconnects', async () => {
    const canceled = vi.fn();
    const server = await startNodeContainer({
      port: 0,
      entry: {
        fetch: () => {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  controller.enqueue(new Uint8Array([1]));
                },
                cancel: canceled,
              }),
            ),
          );
        },
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
        expect(canceled).toHaveBeenCalledTimes(1);
      });
    } finally {
      await server.close();
    }
  });
});
