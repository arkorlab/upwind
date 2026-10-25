import { once } from 'node:events';
import { createServer, get, type Server } from 'node:http';
import { setImmediate as tick } from 'node:timers/promises';

import { MIDDLEWARE_DONE_HEADER, RESUME_PRERENDER_HEADER } from '@stayingupwind/core/paas';
import { describe, expect, it } from 'vitest';

import { nativeOrigin, nativeRequest, writeNativeResponse } from '../src/native/http.ts';

async function listening(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no listener');
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

describe('native public boundary', () => {
  it('strips control and untrusted forwarding headers while preserving the public URL', async () => {
    const server = createServer((req, res) => {
      const request = nativeRequest(req, res, nativeOrigin('https://public.example'));
      res.end(JSON.stringify({ url: request.url, headers: Object.fromEntries(request.headers) }));
    });
    const url = await listening(server);
    try {
      const result = await new Promise<{ url: string; headers: Record<string, string> }>(
        (resolve, reject) => {
          const client = get(
            `${url}//other.example/path`,
            {
              headers: {
                [MIDDLEWARE_DONE_HEADER]: '1',
                [RESUME_PRERENDER_HEADER]: 'secret',
                'x-forwarded-host': 'attacker.example',
                'x-forwarded-proto': 'https',
                forwarded: 'host=attacker.example',
                connection: 'x-private',
                'x-private': 'discard',
                cookie: 'session=actual',
                'x-middleware-set-cookie': 'session=spoofed',
                'x-middleware-override-headers': 'cookie',
                'x-middleware-request-cookie': 'session=spoofed-again',
                'x-middleware-prefetch': '1',
                'x-nextjs-data': '1',
                'x-invoke-path': '/private',
                rsc: '1',
                'next-action': 'public-action',
              },
            },
            (response) => {
              const chunks: Buffer[] = [];
              response.on('data', (chunk: Buffer) => {
                chunks.push(chunk);
              });
              response.once('end', () => {
                resolve(
                  JSON.parse(Buffer.concat(chunks).toString()) as {
                    url: string;
                    headers: Record<string, string>;
                  },
                );
              });
              response.once('error', reject);
            },
          );
          client.once('error', reject);
        },
      );

      expect(result.url).toBe('https://public.example//other.example/path');
      expect(result.headers).toStrictEqual({
        host: 'public.example',
        'x-forwarded-host': 'public.example',
        'x-forwarded-proto': 'https',
        cookie: 'session=actual',
        'x-middleware-prefetch': '1',
        rsc: '1',
        'next-action': 'public-action',
      });
    } finally {
      await close(server);
    }
  });

  it('streams the first chunk before deferred work is released and keeps duplicate cookies', async () => {
    const deferred = Promise.withResolvers<undefined>();
    const server = createServer((req, res) => {
      const headers = new Headers({
        'content-type': 'text/plain',
        'x-arkor-invalidated-tags': 'private-tag',
        'x-next-cache-tags': 'private-cache-tag',
        'cdn-cache-control': 'public, max-age=60',
      });
      headers.append('set-cookie', 'first=1');
      headers.append('set-cookie', 'second=2');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('shell'));
          // The response is deliberately held after the initial shell.
          const finish = async (): Promise<void> => {
            await deferred.promise;
            controller.enqueue(new TextEncoder().encode('dynamic'));
            controller.close();
          };
          void finish().catch((error: unknown) => {
            controller.error(error);
          });
        },
      });
      void writeNativeResponse(req, res, new Response(body, { headers })).catch(
        (error: unknown) => {
          res.destroy(error instanceof Error ? error : undefined);
        },
      );
    });
    const url = await listening(server);
    try {
      const response = await fetch(url);

      expect(response.headers.getSetCookie()).toStrictEqual(['first=1', 'second=2']);
      expect(response.headers.has('x-arkor-invalidated-tags')).toBe(false);
      expect(response.headers.has('x-next-cache-tags')).toBe(false);
      expect(response.headers.get('cdn-cache-control')).toBe('public, max-age=60');

      const reader = response.body?.getReader();

      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('shell');

      deferred.resolve(undefined);

      expect(new TextDecoder().decode((await reader?.read())?.value)).toBe('dynamic');
      expect((await reader?.read())?.done).toBe(true);
    } finally {
      deferred.resolve(undefined);
      await close(server);
    }
  });

  it('does not treat a normally completed upload as request cancellation', async () => {
    const server = createServer((req, res) => {
      const request = nativeRequest(req, res);
      const answer = async (): Promise<void> => {
        const body = await request.text();
        await tick();
        await writeNativeResponse(
          req,
          res,
          Response.json({ body, aborted: request.signal.aborted }),
        );
      };
      void answer().catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : undefined);
      });
    });
    const url = await listening(server);
    try {
      const response = await fetch(url, { method: 'POST', body: 'upload' });

      await expect(response.json()).resolves.toStrictEqual({ body: 'upload', aborted: false });
    } finally {
      await close(server);
    }
  });

  it('returns the representation bytes without automatic decompression', async () => {
    const bytes = Uint8Array.from([0x1f, 0x8b, 0x08, 0]);
    const server = createServer((req, res) => {
      void writeNativeResponse(
        req,
        res,
        new Response(bytes, { headers: { 'content-encoding': 'gzip', 'content-length': '4' } }),
      ).catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : undefined);
      });
    });
    const url = await listening(server);
    try {
      const received = await new Promise<Buffer>((resolve, reject) => {
        const client = get(url, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
          });
          response.once('end', () => {
            resolve(Buffer.concat(chunks));
          });
          response.once('error', reject);
        });
        client.once('error', reject);
      });

      expect([...received]).toStrictEqual([...bytes]);
    } finally {
      await close(server);
    }
  });
});
