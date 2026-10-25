import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { gzipSync } from 'node:zlib';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { closeNodeHttpBridge, invokeNodeHandler } from '../src/node-http-bridge.ts';

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString();
}

describe('real Node HTTP bridge', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(closeNodeHttpBridge);

  it('observes handler and fallback exceptions without leaking either through the client response', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {
      // Observe the expected synthetic failures without writing them to the test process's logs.
    });
    const handlerFailure = new Error('private synthetic handler cause');
    const fallbackFailure = new Error('private synthetic fallback cause');
    const held: Promise<unknown>[] = [];
    const response = await invokeNodeHandler({
      request: new Request('https://example.test/action', { method: 'POST' }),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: () => Promise.reject(handlerFailure),
      onFailure: () => Promise.reject(fallbackFailure),
    });
    const body = await response.text();
    const headers = JSON.stringify([...response.headers]);
    await Promise.all(held);

    expect({
      status: response.status,
      body,
      handlerInHeaders: headers.includes(handlerFailure.message),
      fallbackInHeaders: headers.includes(fallbackFailure.message),
    }).toStrictEqual({
      status: 500,
      body: 'Internal Server Error',
      handlerInHeaders: false,
      fallbackInHeaders: false,
    });
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenNthCalledWith(1, 'next-runtime: error page failed', fallbackFailure);
    expect(logged).toHaveBeenNthCalledWith(2, 'next-runtime: handler failed', handlerFailure);
    expect(logged.mock.calls[0]?.[1]).toBe(fallbackFailure);
    expect(logged.mock.calls[1]?.[1]).toBe(handlerFailure);
  });

  it('preserves raw Node handler compression bytes and their wire headers', async () => {
    const encoded = gzipSync('raw Node handler response');
    const held: Promise<unknown>[] = [];
    const response = await invokeNodeHandler({
      request: new Request('https://example.test/compressed'),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: (_request, output) => {
        output.setHeader('content-encoding', 'gzip');
        output.setHeader('content-length', String(encoded.byteLength));
        output.end(encoded);
        return Promise.resolve();
      },
    });

    expect({
      encoding: response.headers.get('content-encoding'),
      length: response.headers.get('content-length'),
    }).toStrictEqual({ encoding: 'gzip', length: String(encoded.byteLength) });
    expect(Buffer.from(await response.arrayBuffer())).toStrictEqual(encoded);

    await Promise.all(held);
  });

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
    await expect(response.text()).resolves.toBe('separate module');

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

    await expect(response.text()).resolves.toBe('written');
    expect(observed).toStrictEqual([
      {
        scope: 'request-A',
        url: '/rewritten?from=action',
        host: 'example.test',
        body: 'committed value',
        metadata: { synthetic: true },
      },
    ]);
    expect(response.headers.getSetCookie()).toStrictEqual(['first=1; Path=/', 'second=2; Path=/']);
    expect(response.headers.get('location')).toBe('/last');

    await Promise.all(held);
  });

  it('delivers the first body bytes before the handler and its mutation task finish', async () => {
    const release = Promise.withResolvers<undefined>();
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
      release.resolve(undefined);
    }
    const last = await reader.read();

    expect(new TextDecoder().decode(last.value)).toBe('last');

    await Promise.all(held);

    expect(completed).toBe(true);
  });

  it('uses the route error handler and ends a callback-only invocation without hanging', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      // The route intentionally fails before its successful error handler answers.
    });
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

    expect({ status: failed.status, body: await failed.text() }).toStrictEqual({
      status: 503,
      body: 'route fallback',
    });
    expect({ status: captured.status, body: await captured.text() }).toStrictEqual({
      status: 204,
      body: '',
    });

    await Promise.all(held);
  });

  it('retains an accepted mutation when its response consumer disconnects', async () => {
    const release = Promise.withResolvers<undefined>();
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
      release.resolve(undefined);
    }
    await Promise.all(held);

    expect(committed).toBe(true);
  });
});
