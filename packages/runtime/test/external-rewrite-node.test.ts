import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { MIDDLEWARE_DONE_HEADER } from '@stayingupwind/core/paas';
import { describe, expect, it, vi } from 'vitest';

import { externalRewrite } from '../src/serve.ts';

// This suite uses native Node HTTP/fetch. No Next render or Worker-only bridge is invoked.
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));
vi.mock(import('../src/rewrite-fetch.ts'), () => import('../src/node-rewrite-fetch.ts'));

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null)
    throw new Error('The synthetic origin did not listen');
  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

async function origin(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  response.setHeader('content-type', 'application/json');
  response.setHeader('set-cookie', ['one=1; Path=/', 'two=2; Path=/']);
  response.end(
    JSON.stringify({
      method: request.method,
      url: request.url,
      body: Buffer.concat(chunks).toString(),
      host: request.headers.host,
      platform: request.headers[MIDDLEWARE_DONE_HEADER],
      custom: request.headers['x-custom'],
    }),
  );
}

describe('external rewrites over real Node HTTP', () => {
  it.each([
    { method: 'GET', body: undefined, expectedBody: '' },
    { method: 'POST', body: 'streamed request body', expectedBody: 'streamed request body' },
  ])(
    'forwards $method without buffering or losing its streamed body',
    async ({ method, body, expectedBody }) => {
      let calls = 0;
      const server = createServer((request, response) => {
        calls += 1;
        // eslint-disable-next-line unicorn/prefer-await -- node:http owns this response, independently of the caller.
        origin(request, response).catch(() => {
          response.destroy();
        });
      });
      const port = await listen(server);
      try {
        const target = new URL(`http://127.0.0.1:${port}/target?q=1`);
        const request = new Request('https://incoming.example/source', {
          method,
          ...(body === undefined ? undefined : { body }),
          headers: { host: 'incoming.example', [MIDDLEWARE_DONE_HEADER]: '1', 'x-custom': 'kept' },
        });
        const response = await externalRewrite(request, target);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({
          method,
          url: '/target?q=1',
          body: expectedBody,
          host: target.host,
          custom: 'kept',
        });
        expect(response.headers.getSetCookie()).toStrictEqual(['one=1; Path=/', 'two=2; Path=/']);
        expect(calls).toBe(1);
      } finally {
        await close(server);
      }
    },
  );

  it.each([
    { encoding: 'gzip', compress: gzipSync },
    { encoding: 'br', compress: brotliCompressSync },
  ])(
    'forwards native-fetch decoded $encoding with correct headers and one instrumented fetch',
    async ({ encoding, compress }) => {
      const encoded = compress('decoded rewrite response');
      let calls = 0;
      const server = createServer((_request, response) => {
        calls += 1;
        response.writeHead(200, {
          'content-encoding': encoding,
          'content-length': String(encoded.byteLength),
          'set-cookie': ['one=1; Path=/', 'two=2; Path=/'],
          'x-origin': 'kept',
        });
        response.end(encoded);
      });
      const port = await listen(server);
      const instrumented = vi.spyOn(globalThis, 'fetch');
      try {
        const response = await externalRewrite(
          new Request('https://incoming.example/compressed'),
          new URL(`http://127.0.0.1:${port}/compressed`),
        );

        expect({
          status: response.status,
          encoding: response.headers.get('content-encoding'),
          length: response.headers.get('content-length'),
          origin: response.headers.get('x-origin'),
          cookies: response.headers.getSetCookie(),
        }).toStrictEqual({
          status: 200,
          encoding: null,
          length: null,
          origin: 'kept',
          cookies: ['one=1; Path=/', 'two=2; Path=/'],
        });
        await expect(response.text()).resolves.toBe('decoded rewrite response');
        expect(instrumented).toHaveBeenCalledTimes(1);
        expect(calls).toBe(1);
      } finally {
        instrumented.mockRestore();
        await close(server);
      }
    },
  );
});
