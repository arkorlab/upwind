import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { fetchRewrite } from '../../src/native/rewrite-fetch.ts';

const encoder = new TextEncoder();
const servers: ReturnType<typeof createServer>[] = [];

async function upstream(handler: RequestListener): Promise<URL> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no upstream address');
  return new URL(`http://127.0.0.1:${address.port}/rewritten`);
}

describe('native external rewrite fetch', () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
      server.closeAllConnections();
      await closed;
    }
  });

  it('streams POST uploads before the source has finished', async () => {
    const received = Promise.withResolvers<undefined>();
    const target = await upstream((request, response) => {
      request.once('data', () => {
        received.resolve(undefined);
      });
      request.pipe(response);
    });
    let producer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        producer = controller;
        controller.enqueue(encoder.encode('first '));
      },
    });
    const pending = fetchRewrite(target, { method: 'POST', body, redirect: 'manual' });
    await received.promise;
    producer.enqueue(encoder.encode('last'));
    producer.close();

    await expect((await pending).text()).resolves.toBe('first last');
  });

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
    ['zstd', zstdCompressSync],
  ] as const)(
    'normalizes decoded %s bytes without buffering the body',
    async (coding, compress) => {
      const bytes = compress('rewritten response');
      const finish = Promise.withResolvers<undefined>();
      const target = await upstream((_request, response) => {
        response.writeHead(200, {
          'content-encoding': coding,
          'content-length': bytes.byteLength,
          'set-cookie': ['first=1; Path=/', 'second=2; Path=/'],
        });
        response.flushHeaders();
        void finish.promise.then(() => response.end(bytes)).catch(() => response.destroy());
      });
      try {
        // Resolves while the upstream body is gated: the adapter must not await decoded bytes.
        const response = await fetchRewrite(target, { redirect: 'manual' });

        expect(response.headers.get('content-encoding')).toBeNull();
        expect(response.headers.get('content-length')).toBeNull();
        expect(response.headers.getSetCookie()).toStrictEqual([
          'first=1; Path=/',
          'second=2; Path=/',
        ]);

        finish.resolve(undefined);

        await expect(response.text()).resolves.toBe('rewritten response');
      } finally {
        finish.resolve(undefined);
      }
    },
  );

  it('preserves representation metadata for HEAD and unknown encodings', async () => {
    const target = await upstream((request, response) => {
      const head = request.method === 'HEAD';
      response.writeHead(200, {
        'content-encoding': head ? 'gzip' : 'custom',
        'content-length': 3,
      });
      response.end(head ? undefined : 'raw');
    });
    const head = await fetchRewrite(target, { method: 'HEAD' });

    expect(Object.fromEntries(head.headers)).toMatchObject({
      'content-encoding': 'gzip',
      'content-length': '3',
    });

    const unknown = await fetchRewrite(target, {});

    expect(Object.fromEntries(unknown.headers)).toMatchObject({
      'content-encoding': 'custom',
      'content-length': '3',
    });
    await expect(unknown.text()).resolves.toBe('raw');
  });
});
