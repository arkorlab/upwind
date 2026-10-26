import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { Readable } from 'node:stream';
import {
  brotliCompressSync,
  deflateRawSync,
  deflateSync,
  gzipSync,
  zstdCompressSync,
} from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageDestinationError } from '../../src/image-source-error.ts';
import {
  createImageSourceTransport,
  DeflateDecoder,
  guardedImageLookup,
  type ImageSourceTransport,
} from '../../src/native/image-source-fetch.ts';

const servers: ReturnType<typeof createServer>[] = [];
const transports: ImageSourceTransport[] = [];

async function upstream(handler: RequestListener): Promise<URL> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no upstream address');
  return new URL(`http://127.0.0.1:${address.port}/source`);
}

function transport(): ImageSourceTransport {
  const value = createImageSourceTransport();
  transports.push(value);
  return value;
}

describe('native image source destinations', () => {
  type Resolver = NonNullable<Parameters<typeof guardedImageLookup>[0]>;

  afterEach(async () => {
    for (const value of transports.splice(0)) value.close();
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

  it('returns exactly the checked addresses to the socket without another resolution', () => {
    const addresses = [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    const resolver = vi.fn<Resolver>((_hostname, options, callback) => {
      expect(options).toMatchObject({ all: true, family: 0 });

      callback(null, addresses);
    });
    const callback = vi.fn();

    guardedImageLookup(resolver)('images.example', { all: true, family: 0 }, callback);

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]?.[0]).toBe('images.example');
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, addresses);
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1'])(
    'rejects DNS answers containing %s before connecting',
    (address) => {
      const callback = vi.fn();
      guardedImageLookup((_hostname, _options, resolved) => {
        resolved(null, [
          { address: '8.8.8.8', family: 4 },
          { address, family: address.includes(':') ? 6 : 4 },
        ]);
      })('images.example', { all: true }, callback);

      expect(callback).toHaveBeenCalledExactlyOnceWith(expect.any(ImageDestinationError), []);
    },
  );

  it('rejects a rebound address on a later connection', () => {
    let calls = 0;
    const guarded = guardedImageLookup((_hostname, _options, resolved) => {
      calls += 1;
      resolved(null, [{ address: calls === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
    });
    const first = vi.fn();
    const second = vi.fn();
    guarded('images.example', {}, first);
    guarded('images.example', {}, second);

    expect(first).toHaveBeenCalledExactlyOnceWith(null, '8.8.8.8', 4);
    expect(second).toHaveBeenCalledExactlyOnceWith(expect.any(ImageDestinationError), []);
    expect(calls).toBe(2);
  });

  it('rejects an empty answer and propagates lookup errors', () => {
    const empty = vi.fn();
    guardedImageLookup((_hostname, _options, resolved) => {
      resolved(null, []);
    })('images.example', {}, empty);

    expect(empty).toHaveBeenCalledExactlyOnceWith(expect.any(ImageDestinationError), []);

    const missing = new Error('no DNS answer');
    const failed = vi.fn();
    guardedImageLookup((_hostname, _options, resolved) => {
      resolved(missing, []);
    })('images.example', {}, failed);

    expect(failed).toHaveBeenCalledExactlyOnceWith(missing, []);
  });

  it('does not reuse an opted-in local socket for a protected request', async () => {
    const answer = vi.fn<RequestListener>((_request, response) => {
      response.end('local image');
    });
    const url = await upstream(answer);
    const client = transport();

    await expect((await client.fetch(url, AbortSignal.timeout(5000), true)).text()).resolves.toBe(
      'local image',
    );

    await expect(client.fetch(url, AbortSignal.timeout(5000), false)).rejects.toBeInstanceOf(
      ImageDestinationError,
    );
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it('does not turn URL credentials into an Authorization header', async () => {
    const answer = vi.fn<RequestListener>((_request, response) => {
      response.end('private');
    });
    const url = await upstream(answer);
    url.username = 'visitor';
    url.password = 'secret';

    await expect(transport().fetch(url, AbortSignal.timeout(5000), true)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(answer).not.toHaveBeenCalled();
  });

  it('refuses a hostname resolving to loopback before any request is sent', async () => {
    const answer = vi.fn<RequestListener>((_request, response) => {
      response.end('private');
    });
    const url = await upstream(answer);
    url.hostname = 'images.example';
    const resolver = vi.fn<Resolver>((_hostname, _options, resolved) => {
      resolved(null, [{ address: '127.0.0.1', family: 4 }]);
    });
    const client = createImageSourceTransport(resolver);
    transports.push(client);

    await expect(client.fetch(url, AbortSignal.timeout(5000), false)).rejects.toBeInstanceOf(
      ImageDestinationError,
    );
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(answer).not.toHaveBeenCalled();
  });

  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['deflate', deflateRawSync],
    ['br', brotliCompressSync],
    ['zstd', zstdCompressSync],
  ] as const)(
    'streams and decodes %s while preserving redirects and headers',
    async (coding, compress) => {
      const finish = Promise.withResolvers<undefined>();
      const bytes = compress('image bytes');
      const url = await upstream((_request, response) => {
        response.writeHead(200, { 'content-encoding': coding, 'cache-control': 'max-age=60' });
        response.flushHeaders();
        void finish.promise.then(() => response.end(bytes)).catch(() => response.destroy());
      });
      try {
        const response = await transport().fetch(url, AbortSignal.timeout(5000), true);

        expect(response.headers.get('cache-control')).toBe('max-age=60');

        finish.resolve(undefined);

        await expect(response.text()).resolves.toBe('image bytes');
      } finally {
        finish.resolve(undefined);
      }
    },
  );

  it('returns redirects for per-hop destination validation', async () => {
    const url = await upstream((_request, response) => {
      response.writeHead(302, { location: 'http://private.example/source' });
      response.end();
    });
    const response = await transport().fetch(url, AbortSignal.timeout(5000), true);

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('http://private.example/source');

    await response.body?.cancel();
  });

  it('honors the supplied abort reason', async () => {
    const url = await upstream(() => {
      // Remain open until the client aborts its request.
    });
    const controller = new AbortController();
    const pending = transport().fetch(url, controller.signal, true);
    const reason = new Error('image deadline');
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('bounds deflate output while its consumer is paused and resumes on demand', async () => {
    const decoder = new DeflateDecoder();
    const paused = Promise.withResolvers<undefined>();
    // eslint-disable-next-line @typescript-eslint/unbound-method, vitest/unbound-method -- invoked with its explicit receiver below.
    const pause = Readable.prototype.pause;
    const spy = vi.spyOn(Readable.prototype, 'pause').mockImplementation(function pauseDecoder(
      this: Readable,
    ) {
      if (this !== decoder) paused.resolve(undefined);
      return pause.call(this);
    });
    const bytes = new Uint8Array(256 * 1024);
    try {
      decoder.end(deflateSync(bytes));
      await paused.promise;

      expect(decoder.readableLength).toBeLessThanOrEqual(decoder.readableHighWaterMark);

      const chunks: Buffer[] = [];
      for await (const chunk of decoder) chunks.push(chunk as Buffer);

      expect(Buffer.concat(chunks)).toHaveLength(bytes.byteLength);
    } finally {
      spy.mockRestore();
      decoder.destroy();
    }
  });
});
