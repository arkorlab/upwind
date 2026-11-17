import type { ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { startNodeContainer, type NodeContainerServer } from '../src/node-container.ts';
import { invokeNodeHandler } from '../src/node-http-bridge.ts';

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

/** A container whose application is one Node.js handler, reached through the loopback bridge. */
function nodeHandlerContainer(
  handler: (output: ServerResponse) => void,
): Promise<NodeContainerServer> {
  return startNodeContainer({
    port: 0,
    entry: {
      fetch: (request, _env, context) => {
        return invokeNodeHandler({
          request,
          requestMeta: {},
          waitUntil: context.waitUntil,
          handler: (_request, output) => {
            handler(output);
            return Promise.resolve();
          },
        });
      },
    },
  });
}

describe('node container HTTP service', () => {
  beforeAll(() => {
    vi.stubEnv('ARKOR_NODE_RUNTIME', CONFIGURATION);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('logs the original Function failure while returning only a generic client response', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // Capture the private cause without writing expected failures to the test process.
    });
    const failure = new Error('private synthetic Function cause');
    const server = await startNodeContainer({
      port: 0,
      entry: { fetch: () => Promise.reject(failure) },
    });
    try {
      const response = await internal(server, '/failure', {
        headers: { 'x-upwind-request-url': 'https://example.test/failure' },
      });
      const body = await response.text();

      expect({ status: response.status, body }).toStrictEqual({
        status: 500,
        body: 'Internal Server Error',
      });
      expect(JSON.stringify([...response.headers])).not.toContain(failure.message);
      expect(logged).toHaveBeenCalledWith('next-runtime: Function failed', failure);
    } finally {
      await server.close();
    }
  });

  it('logs a response forwarding failure without replacing the committed response', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // Capture the private stream cause without writing the expected failure.
    });
    const failure = new Error('private synthetic response stream cause');
    const release = Promise.withResolvers<undefined>();
    let started = false;
    const server = await startNodeContainer({
      port: 0,
      entry: {
        fetch: () => {
          return Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull: async (controller) => {
                  if (!started) {
                    started = true;
                    controller.enqueue(new TextEncoder().encode('first'));
                    return;
                  }
                  await release.promise;
                  throw failure;
                },
              }),
            ),
          );
        },
      },
    });
    try {
      const response = await internal(server, '/stream', {
        headers: { 'x-upwind-request-url': 'https://example.test/stream' },
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      release.resolve(undefined);

      expect(response.status).toBe(200);
      expect(new TextDecoder().decode(first.value)).toBe('first');
      await expect(reader.read()).rejects.toThrow(TypeError);

      await vi.waitFor(() => {
        expect(logged).toHaveBeenCalledWith('next-runtime: Function failed', failure);
      });

      expect(JSON.stringify([...response.headers])).not.toContain(failure.message);
    } finally {
      release.resolve(undefined);
      await server.close();
    }
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

  it('sends a Node.js handler’s own gzip coding and the length Node counted with its bytes', async () => {
    const plain = 'a route that compresses its own answer';
    const encoded = gzipSync(plain);
    const server = await nodeHandlerContainer((output) => {
      output.setHeader('content-encoding', 'gzip');
      output.end(encoded);
    });
    try {
      const response = await internal(server, '/compressed', {
        headers: { 'x-upwind-request-url': 'https://example.test/compressed' },
      });

      expect({
        encoding: response.headers.get('content-encoding'),
        length: response.headers.get('content-length'),
        // Fetch decodes it once: the bytes went out as the handler compressed them.
        body: await response.text(),
      }).toStrictEqual({ encoding: 'gzip', length: String(encoded.byteLength), body: plain });
    } finally {
      await server.close();
    }
  });

  it('keeps a Node.js handler’s gzip coding and bytes where it named a length of its own', async () => {
    const plain = 'a route that names its own encoded length';
    const encoded = gzipSync(plain);
    const server = await nodeHandlerContainer((output) => {
      output.setHeader('content-encoding', 'gzip');
      output.setHeader('content-length', String(encoded.byteLength));
      output.end(encoded);
    });
    try {
      const response = await internal(server, '/named', {
        headers: { 'x-upwind-request-url': 'https://example.test/named' },
      });

      // The loopback bridge frames the body by what is written, not by the length the handler
      // named (`ownFraming`), so it leaves chunked; its coding and bytes are the handler's.
      expect({
        encoding: response.headers.get('content-encoding'),
        body: await response.text(),
      }).toStrictEqual({ encoding: 'gzip', body: plain });
    } finally {
      await server.close();
    }
  });

  it('sends a Node.js handler’s download with the length Node counted', async () => {
    const file = Buffer.alloc(64 * 1024, 65);
    const server = await nodeHandlerContainer((output) => {
      output.setHeader('content-type', 'application/pdf');
      output.end(file);
    });
    try {
      const response = await internal(server, '/file.pdf', {
        headers: { 'x-upwind-request-url': 'https://example.test/file.pdf' },
      });

      expect({
        length: response.headers.get('content-length'),
        bytes: (await response.arrayBuffer()).byteLength,
      }).toStrictEqual({ length: String(file.byteLength), bytes: file.byteLength });
    } finally {
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
