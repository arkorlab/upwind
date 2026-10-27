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

function framingHeaders(contentLength: string | null): Headers {
  const headers = new Headers();
  if (contentLength !== null) headers.set('content-length', contentLength);
  return headers;
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

  it('rejects a Node-only status without an uncaught callback error and keeps the bridge usable', async () => {
    const held: Promise<unknown>[] = [];
    const disconnected = Promise.withResolvers<undefined>();
    const invalid = invokeNodeHandler({
      request: new Request('https://example.test/invalid-status', { method: 'POST' }),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: (_request, output) => {
        output.statusCode = 700;
        output.once('close', () => {
          disconnected.resolve(undefined);
        });
        output.write('unrepresentable response');
        return Promise.resolve();
      },
    });

    await expect(invalid).rejects.toThrow(RangeError);

    await disconnected.promise;
    const response = await invokeNodeHandler({
      request: new Request('https://example.test/after-invalid-status'),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: (_request, output) => {
        output.statusCode = 201;
        output.end('still available');
        return Promise.resolve();
      },
    });

    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe('still available');

    await Promise.all(held);
  });

  it('discards abandoned representation headers before the route error handler', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      // This route intentionally fails before its error page answers.
    });
    const held: Promise<unknown>[] = [];
    const observed: unknown[] = [];
    const response = await invokeNodeHandler({
      request: new Request('https://example.test/failure', { method: 'POST' }),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: (_request, output) => {
        output.setHeader('content-length', '0');
        output.setHeader('content-encoding', 'gzip');
        output.setHeader('content-range', 'bytes 0-9/10');
        output.setHeader('content-type', 'application/octet-stream');
        output.setHeader('etag', 'abandoned-entity');
        output.setHeader('last-modified', 'Tue, 01 Jan 2030 00:00:00 GMT');
        output.setHeader('transfer-encoding', 'chunked');
        output.setHeader('set-cookie', 'retained=1; Path=/');
        return Promise.reject(new Error('synthetic private handler failure'));
      },
      onFailure: (_request, output) => {
        observed.push(
          Object.fromEntries(
            [
              'content-length',
              'content-encoding',
              'content-range',
              'content-type',
              'etag',
              'last-modified',
              'transfer-encoding',
            ].map((name) => [name, output.getHeader(name)]),
          ),
        );
        output.statusCode = 503;
        output.setHeader('content-type', 'text/plain');
        output.end('route fallback');
        return Promise.resolve();
      },
    });
    const body = await response.text();
    await Promise.all(held);

    expect(observed).toStrictEqual([
      {
        'content-length': undefined,
        'content-encoding': undefined,
        'content-range': undefined,
        'content-type': undefined,
        etag: undefined,
        'last-modified': undefined,
        'transfer-encoding': undefined,
      },
    ]);
    expect({ status: response.status, body }).toStrictEqual({
      status: 503,
      body: 'route fallback',
    });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.getSetCookie()).toStrictEqual(['retained=1; Path=/']);
  });

  it('clears a failed error handler representation before the generic fallback body', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {
      // Both authored handlers intentionally fail before the generic response.
    });
    const held: Promise<unknown>[] = [];
    const response = await invokeNodeHandler({
      request: new Request('https://example.test/failure', { method: 'POST' }),
      requestMeta: {},
      waitUntil: (promise) => {
        held.push(promise);
      },
      handler: (_request, output) => {
        output.setHeader('content-length', '900');
        output.setHeader('content-encoding', 'gzip');
        return Promise.reject(new Error('synthetic private handler failure'));
      },
      onFailure: (_request, output) => {
        output.setHeader('content-length', '0');
        output.setHeader('content-encoding', 'br');
        output.setHeader('etag', 'abandoned-fallback');
        return Promise.reject(new Error('synthetic private fallback failure'));
      },
    });
    const body = await response.text();
    await Promise.all(held);

    expect({ status: response.status, body }).toStrictEqual({
      status: 500,
      body: 'Internal Server Error',
    });
    expect([null, String(Buffer.byteLength(body))]).toContain(
      response.headers.get('content-length'),
    );
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('etag')).toBeNull();
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
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

  // Real loopback regression coverage belongs to the Node runtime CI suite, not source-only checks.
  it.each([
    { method: 'DELETE', contentLength: null },
    { method: 'DELETE', contentLength: '0' },
    { method: 'OPTIONS', contentLength: null },
    { method: 'OPTIONS', contentLength: '0' },
  ])(
    'frames a streamed $method body independently of content-length=$contentLength',
    async ({ method, contentLength }) => {
      const chunks = ['first:α|', 'middle'.repeat(4096), '|last:終'];
      const headers = framingHeaders(contentLength);
      headers.set('content-type', 'text/plain; charset=utf-8');
      const init: RequestInit & { duplex: 'half' } = {
        method,
        headers,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        duplex: 'half',
      };
      const request = new Request('https://example.test/streamed', init);
      const held: Promise<unknown>[] = [];
      const observed: unknown[] = [];
      const response = await invokeNodeHandler({
        request,
        requestMeta: {},
        waitUntil: (promise) => {
          held.push(promise);
        },
        handler: async (incoming, output) => {
          observed.push({
            method: incoming.method,
            length: incoming.headers['content-length'],
            transfer: incoming.headers['transfer-encoding'],
            body: await bodyOf(incoming),
          });
          output.end('received');
        },
      });

      await expect(response.text()).resolves.toBe('received');
      expect(observed).toStrictEqual([
        {
          method,
          length: undefined,
          transfer: 'chunked',
          body: chunks.join(''),
        },
      ]);
      expect(request.headers.get('content-length')).toBe(contentLength);
      expect(request.headers.has('transfer-encoding')).toBe(false);

      await Promise.all(held);
    },
  );

  it.each([
    { method: 'DELETE', contentLength: null },
    { method: 'DELETE', contentLength: '0' },
    { method: 'OPTIONS', contentLength: null },
    { method: 'OPTIONS', contentLength: '0' },
  ])(
    'does not add streamed framing to a bodyless $method with length=$contentLength',
    async ({ method, contentLength }) => {
      const headers = framingHeaders(contentLength);
      const request = new Request('https://example.test/bodyless', { method, headers });
      const observed: unknown[] = [];
      const held: Promise<unknown>[] = [];
      const response = await invokeNodeHandler({
        request,
        requestMeta: {},
        waitUntil: (promise) => {
          held.push(promise);
        },
        handler: async (incoming, output) => {
          observed.push({
            method: incoming.method,
            length: incoming.headers['content-length'],
            transfer: incoming.headers['transfer-encoding'],
            body: await bodyOf(incoming),
          });
          output.end('empty');
        },
      });

      await expect(response.text()).resolves.toBe('empty');
      expect(observed).toStrictEqual([
        {
          method,
          length: contentLength ?? undefined,
          transfer: undefined,
          body: '',
        },
      ]);
      expect(request.body).toBeNull();
      expect(request.headers.get('content-length')).toBe(contentLength);

      await Promise.all(held);
    },
  );

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
