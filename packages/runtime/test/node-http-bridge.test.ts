import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { closeNodeHttpBridge, invokeNodeHandler } from '../src/node-http-bridge.ts';

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

afterAll(closeNodeHttpBridge);

describe('real Node HTTP bridge', () => {
  it('closes the real handler server through a separately evaluated service module copy', async () => {
    vi.resetModules();
    const first = await import('../src/node-http-bridge.ts');
    vi.resetModules();
    const second = await import('../src/node-http-bridge.ts');
    let port: number | undefined;
    const held: Promise<unknown>[] = [];
    const response = await first.invokeNodeHandler({
      request: new Request('https://example.test/'),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: (request, output) => {
        port = request.socket.localPort;
        output.end('separate module');
        return Promise.resolve();
      },
    });

    expect(first.invokeNodeHandler).not.toBe(second.invokeNodeHandler);
    expect(await response.text()).toBe('separate module');

    await Promise.all(held);
    await second.closeNodeHttpBridge();

    expect(port).toBeTypeOf('number');
    await expect(fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toThrow(Error);
  });

  it('restores handler URL, ALS, metadata, body, host, cookies and singleton redirects', async () => {
    const storage = new AsyncLocalStorage<string>();
    const held: Promise<unknown>[] = [];
    const observed: unknown[] = [];
    const run = storage.run('request-A', () => AsyncLocalStorage.snapshot());
    const response = await invokeNodeHandler({
      request: new Request('https://example.test/action', {
        method: 'POST',
        body: 'committed value',
      }),
      url: '/rewritten?from=action',
      requestMeta: { synthetic: true },
      run: (work) => run(work),
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: async (request, output, context) => {
        observed.push({
          scope: storage.getStore(),
          url: request.url,
          host: request.headers.host,
          body: await bodyOf(request),
          metadata: context.requestMeta,
        });
        output.setHeader('set-cookie', ['first=1; Path=/', 'second=2; Path=/']);
        output.appendHeader('location', '/first');
        output.appendHeader('location', '/last');
        output.end('written');
      },
    });

    expect(await response.text()).toBe('written');
    expect(observed).toEqual([
      {
        scope: 'request-A',
        url: '/rewritten?from=action',
        host: 'example.test',
        body: 'committed value',
        metadata: { synthetic: true },
      },
    ]);
    expect(response.headers.getSetCookie()).toEqual(['first=1; Path=/', 'second=2; Path=/']);
    expect(response.headers.get('location')).toBe('/last');

    await Promise.all(held);
  });

  it('delivers the first body bytes before the handler and its mutation task finish', async () => {
    const release = Promise.withResolvers<void>();
    const held: Promise<unknown>[] = [];
    let completed = false;
    const response = await invokeNodeHandler({
      request: new Request('https://example.test/action', { method: 'POST' }),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: async (_request, output) => {
        output.write('first');
        await release.promise;
        output.end('last');
        completed = true;
      },
    });
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();

      expect(new TextDecoder().decode(first.value)).toBe('first');
      expect(completed).toBe(false);
      expect(held).toHaveLength(1);
    } finally {
      release.resolve();
    }
    const last = await reader.read();

    expect(new TextDecoder().decode(last.value)).toBe('last');

    await Promise.all(held);

    expect(completed).toBe(true);
  });

  it('uses the route error handler and ends a callback-only invocation without hanging', async () => {
    const held: Promise<unknown>[] = [];
    const common = {
      request: new Request('https://example.test/'),
      requestMeta: {},
      waitUntil: (promise: Promise<unknown>): void => {
        held.push(promise);
      },
    };
    const failed = await invokeNodeHandler({
      ...common,
      handler: () => Promise.reject(new Error('synthetic private failure')),
      onFailure: (_request, output) => {
        output.statusCode = 503;
        output.end('route fallback');
        return Promise.resolve();
      },
    });
    const captured = await invokeNodeHandler({
      ...common,
      expectNoResponse: true,
      handler: () => Promise.resolve(),
    });

    expect({ status: failed.status, body: await failed.text() }).toEqual({
      status: 503,
      body: 'route fallback',
    });
    expect({ status: captured.status, body: await captured.text() }).toEqual({
      status: 204,
      body: '',
    });

    await Promise.all(held);
  });

  it('retains an accepted mutation when its response consumer disconnects', async () => {
    const release = Promise.withResolvers<void>();
    const held: Promise<unknown>[] = [];
    let committed = false;
    const response = await invokeNodeHandler({
      request: new Request('https://example.test/action', { method: 'POST', body: 'write' }),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: async (request, output) => {
        await bodyOf(request);
        output.write('accepted');
        await release.promise;
        committed = true;
        output.end('committed');
      },
    });
    try {
      await response.body!.cancel();

      expect(committed).toBe(false);
      expect(held).toHaveLength(1);
    } finally {
      release.resolve();
    }
    await Promise.all(held);

    expect(committed).toBe(true);
  });
});
