/* eslint-disable @typescript-eslint/require-await -- Next.js handler fixtures retain their async contract when completing synchronously. */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { describe, onTestFinished, it } from 'vitest';

import type { InvokeInput } from '../../src/invocation.ts';
import {
  createNodeBridge,
  type NodeBridge,
  type NodeBridgeOptions,
} from '../../src/native/bridge.ts';

function fixture(options: NodeBridgeOptions = {}): NodeBridge {
  const bridge = createNodeBridge({
    onError: () => {
      /* No host task/reporting action is needed by this fixture. */
    },
    ...options,
  });
  onTestFinished(async () => {
    await bridge.close(500);
  });
  return bridge;
}

function input(handler: InvokeInput['handler'], fields: Partial<InvokeInput> = {}): InvokeInput {
  return {
    handler,
    request: new Request('https://app.test/original?q=1'),
    requestMeta: {},
    waitUntil: () => {
      /* No host task/reporting action is needed by this fixture. */
    },
    ...fields,
  };
}

function gate(): { promise: Promise<void>; resolve: () => void } {
  const next = Promise.withResolvers<undefined>();
  return {
    promise: next.promise,
    resolve: () => {
      next.resolve(undefined);
    },
  };
}

async function textOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString();
}

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await delay(5);
  }
  assert.fail('condition did not settle');
}

function upload(body: ReadableStream<Uint8Array>): Request {
  return new Request('https://app.test/upload', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
}

async function unusedBodyHandler(): Promise<void> {
  assert.fail('an unavailable body must not invoke its handler');
}

describe('native Node bridge', () => {
  it('restores rewritten URL and public headers on real Node request/response objects', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(
        async (req, res, ctx) => {
          assert.equal(req.constructor.name, 'IncomingMessage');
          assert.equal(res.constructor.name, 'ServerResponse');
          assert.equal(req.url, '/rewritten?x=2');
          assert.equal(req.headers.host, 'app.test');
          assert.equal(Object.getPrototypeOf(req.headers), Object.prototype);
          assert.equal(req.headers['user-agent'], 'one, two');
          assert.equal(req.headers['x-upwind-native-dispatch'], undefined);
          assert.deepEqual(req.headersDistinct['user-agent'], ['one, two']);
          assert.equal(ctx.requestMeta?.['marker'], 42);
          res.end('ok');
        },
        {
          request: new Request('https://app.test/original', {
            headers: { 'user-agent': 'one, two' },
          }),
          url: '/rewritten?x=2',
          requestMeta: { marker: 42 },
        },
      ),
    );
    assert.equal(await response.text(), 'ok');
  });

  it('preserves an explicit Host instead of replacing it with the loopback host', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(
        async (req, res) => {
          res.end(req.headers.host);
        },
        {
          request: new Request('http://internal.test/', { headers: { host: 'public.test:8443' } }),
        },
      ),
    );
    assert.equal(await response.text(), 'public.test:8443');
  });

  it('streams the first chunk before the handler or body finishes', async () => {
    const bridge = fixture();
    const release = gate();
    let ended = false;
    const answer = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first');
        await release.promise;
        res.end('last');
        ended = true;
      }),
    );
    const reader = answer.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first');
    assert.equal(ended, false);
    release.resolve();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'last');
    assert.equal((await reader.read()).done, true);
  });

  it('keeps callback metadata by reference and completes callback-only captures', async () => {
    const bridge = fixture();
    const marker = { captured: false };
    const meta = {
      onCacheEntry: () => {
        marker.captured = true;
        return true;
      },
    };
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, _res, ctx) => {
          assert.equal(ctx.requestMeta, meta);
          meta.onCacheEntry();
        },
        { requestMeta: meta, expectNoResponse: true },
      ),
    );
    assert.equal(marker.captured, true);
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
  });

  it('preserves Set-Cookie lines with commas and does not follow redirects', async () => {
    const bridge = fixture();
    const cookies = ['a=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/', 'b=2; Path=/'];
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.statusCode = 307;
        res.setHeader('set-cookie', cookies);
        res.setHeader('location', '/next');
        res.appendHeader('Location', '/next');
        res.end();
      }),
    );
    assert.equal(response.status, 307);
    assert.equal(response.headers.get('location'), '/next');
    assert.deepEqual(response.headers.getSetCookie(), cookies);
    await response.arrayBuffer();
  });

  it('preserves compressed bytes without automatic decoding', async () => {
    const bridge = fixture();
    const compressed = gzipSync('compressed application response');
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length });
        res.end(compressed);
      }),
    );
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    assert.equal(response.headers.get('content-length'), String(compressed.length));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), compressed);
  });

  it('removes hop-by-hop fields including Connection-nominated fields', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.writeHead(200, {
          connection: 'close, x-private-hop',
          'x-private-hop': 'secret',
          'x-kept': 'yes',
        });
        res.end('ok');
      }),
    );
    assert.equal(response.headers.get('connection'), null);
    assert.equal(response.headers.get('transfer-encoding'), null);
    assert.equal(response.headers.get('x-private-hop'), null);
    assert.equal(response.headers.get('x-kept'), 'yes');
    await response.text();
  });

  it('re-enters each async context without cross-request leakage', async () => {
    const bridge = fixture();
    const storage = new AsyncLocalStorage<string>();
    await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const id = String(index);
        const response = await bridge.invokeNodeHandler(
          input(
            async (_req, res) => {
              await delay(index % 3);
              res.end(storage.getStore());
            },
            { run: (work) => storage.run(id, work) },
          ),
        );
        assert.equal(await response.text(), id);
      }),
    );
  });

  it('keeps binary uploads and does not mistake normal request close for cancellation', async () => {
    const bridge = fixture();
    const body = Buffer.from(Array.from({ length: 256 * 1024 }, (_, index) => index % 256));
    const response = await bridge.invokeNodeHandler(
      input(
        async (req, res) => {
          const closed = once(req, 'close');
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.from(chunk as Uint8Array));
          }
          await closed;
          assert.equal(req.complete, true);
          assert.deepEqual(Buffer.concat(chunks), body);
          await delay(10);
          res.end('received');
        },
        { request: new Request('https://app.test/upload', { method: 'POST', body }) },
      ),
    );
    assert.equal(await response.text(), 'received');
  });

  it('invokes the handler before the upload finishes', async () => {
    const bridge = fixture();
    const entered = gate();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    });
    const answer = bridge.invokeNodeHandler(
      input(
        async (req, res) => {
          entered.resolve();
          res.end(await textOf(req));
        },
        { request: upload(body) },
      ),
    );
    source.enqueue(new TextEncoder().encode('first'));
    await entered.promise;
    source.enqueue(new TextEncoder().encode('last'));
    source.close();
    assert.equal(await (await answer).text(), 'firstlast');
  });

  it.each([204, 205, 304])('returns a null body for status %s', async (status) => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.writeHead(status);
        res.end();
      }),
    );
    assert.equal(response.status, status);
    assert.equal(response.body, null);
  });

  it('preserves HEAD headers but does not expose a body', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          res.setHeader('content-length', '42');
          res.end();
        },
        { request: new Request('https://app.test/', { method: 'HEAD' }) },
      ),
    );
    assert.equal(response.body, null);
    assert.equal(response.headers.get('content-length'), '42');
  });

  it('makes the starting status visible and retains the handler result', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          assert.equal(res.statusCode, 404);
          res.statusCode = 410;
          res.end('gone');
        },
        { status: 404 },
      ),
    );
    assert.equal(response.status, 410);
    await response.text();
  });

  it('calls the error page under the original context', async () => {
    const bridge = fixture();
    const storage = new AsyncLocalStorage<string>();
    const response = await bridge.invokeNodeHandler(
      input(
        async () => {
          throw new Error('render failed');
        },
        {
          run: (work) => storage.run('request', work),
          onFailure: async (_req, res) => {
            assert.equal(storage.getStore(), 'request');
            res.writeHead(503);
            res.end('error page');
          },
        },
      ),
    );
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'error page');
  });

  it('returns a generic failure even when reporting throws', async () => {
    const bridge = fixture({
      onError() {
        throw new Error('reporter failed');
      },
    });
    const response = await bridge.invokeNodeHandler(
      input(async () => {
        throw new Error('PRIVATE_SECRET');
      }),
    );
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Internal Server Error');
  });

  it('a failing error page falls back to a generic response', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(
        async () => {
          throw new Error('render failed');
        },
        {
          onFailure: async () => {
            throw new Error('error page failed');
          },
        },
      ),
    );
    assert.equal(response.status, 500);
    await response.text();
  });

  it('failure after headers breaks the stream without appending a second response', async () => {
    const bridge = fixture();
    const release = gate();
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.write('partial');
        await release.promise;
        throw new Error('after headers');
      }),
    );
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'partial');
    release.resolve();
    await assert.rejects(reader.read());
  });

  it('cancelling a stream closes its socket without retaining a safe handler', async () => {
    const bridge = fixture();
    const closed = gate();
    let retained = 0;
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          res.write('event');
          await once(res, 'close');
          closed.resolve();
        },
        {
          waitUntil() {
            retained += 1;
          },
        },
      ),
    );
    await response.body!.cancel();
    await closed.promise;
    assert.equal(retained, 0);
  });

  it('a mutation keeps accepted work after the reader disconnects', async () => {
    const bridge = fixture();
    const release = gate();
    const closed = gate();
    const retained: Promise<unknown>[] = [];
    let written = false;
    const response = await bridge.invokeNodeHandler(
      input(
        async (req, res) => {
          await textOf(req);
          res.once('close', closed.resolve);
          res.write('accepted');
          await release.promise;
          written = true;
          res.end();
        },
        {
          request: new Request('http://app.test/', { method: 'POST', body: 'input' }),
          waitUntil(promise) {
            retained.push(promise);
          },
        },
      ),
    );
    await response.body!.cancel();
    await closed.promise;
    assert.equal(retained.length, 1);
    release.resolve();
    await Promise.all(retained);
    assert.equal(written, true);
  });

  it('tracks a GET handler with work after normal response finish', async () => {
    const bridge = fixture();
    const release = gate();
    const retained: Promise<unknown>[] = [];
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          res.end('done');
          await release.promise;
        },
        {
          waitUntil(promise) {
            retained.push(promise);
          },
        },
      ),
    );
    await response.text();
    assert.equal(retained.length, 1);
    assert.equal(bridge.activeInvocations, 1);
    release.resolve();
    await Promise.all(retained);
    await until(() => bridge.activeInvocations === 0);
  });

  it('rejects an already aborted request without allocating a dispatch', async () => {
    const bridge = fixture();
    const signal = AbortSignal.abort(new Error('cancelled'));
    const request = new Request('http://app.test/', { signal });
    const invocation = input(unusedBodyHandler, { request });
    await assert.rejects(bridge.invokeNodeHandler(invocation), /cancelled/u);
    assert.equal(bridge.activeInvocations, 0);
  });

  it('abort before headers rejects and cleans up the dispatch', async () => {
    const bridge = fixture();
    const controller = new AbortController();
    const entered = gate();
    const answer = bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          entered.resolve();
          await once(res, 'close');
        },
        { request: new Request('http://app.test/', { signal: controller.signal }) },
      ),
    );
    const rejected = assert.rejects(answer, /cancelled/u);
    await entered.promise;
    controller.abort(new Error('cancelled'));
    await rejected;
    await until(() => bridge.activeInvocations === 0);
  });

  it('bounds pending invocations including concurrent cold start', async () => {
    const bridge = fixture({ maxInFlight: 1 });
    const release = gate();
    const first = bridge.invokeNodeHandler(
      input(async (_req, res) => {
        await release.promise;
        res.end('one');
      }),
    );
    await assert.rejects(
      bridge.invokeNodeHandler(
        input(async (_req, res) => {
          res.end();
        }),
      ),
      /capacity/u,
    );
    release.resolve();
    await (await first).text();
  });

  it('the headers deadline cancels a stalled transport', async () => {
    const bridge = fixture({ headersTimeoutMs: 40 });
    await assert.rejects(
      bridge.invokeNodeHandler(
        input(async (_req, res) => {
          await once(res, 'close');
        }),
      ),
      /deadline/u,
    );
    await until(() => bridge.activeInvocations === 0);
  });

  it('rejects consumed and locked bodies without allocating a dispatch', async () => {
    const bridge = fixture();
    const consumed = new Request('http://app.test/', { method: 'POST', body: 'body' });
    await consumed.text();
    await assert.rejects(
      bridge.invokeNodeHandler(input(unusedBodyHandler, { request: consumed })),
      /unused/u,
    );
    const locked = new Request('http://app.test/', { method: 'POST', body: 'body' });
    const reader = locked.body!.getReader();
    await assert.rejects(
      bridge.invokeNodeHandler(input(unusedBodyHandler, { request: locked })),
      /unused/u,
    );
    reader.releaseLock();
    assert.equal(bridge.activeInvocations, 0);
  });

  it('close is idempotent, drains work and refuses new invocations', async () => {
    const bridge = fixture();
    const release = gate();
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.end('ok');
        await release.promise;
      }),
    );
    await response.text();
    const closing = bridge.close(1000);
    assert.equal(bridge.close(), closing);
    await assert.rejects(
      bridge.invokeNodeHandler(
        input(async () => {
          /* No host task/reporting action is needed by this fixture. */
        }),
      ),
      /closing/u,
    );
    release.resolve();
    assert.equal(await closing, true);
  });

  it('close reports incomplete drain and releases listening sockets at its deadline', async () => {
    const bridge = fixture();
    const release = gate();
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.write('stream');
        await release.promise;
        res.end();
      }),
    );
    const read = assert.rejects(response.text());
    assert.equal(await bridge.close(20), false);
    release.resolve();
    await read;
  });

  it('cold shutdown does not leave a lazily starting server listening', async () => {
    const bridge = fixture();
    const answer = bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.end();
      }),
    );
    const rejected = assert.rejects(answer, /closing/u);
    assert.equal(await bridge.close(), true);
    await rejected;
  });

  it('validates limits without changing global timers or fetch', async () => {
    const originals = { fetch, setImmediate, clearImmediate, setTimeout, clearTimeout };
    assert.throws(() => createNodeBridge({ maxInFlight: 0 }), RangeError);
    assert.throws(() => createNodeBridge({ headersTimeoutMs: Infinity }), RangeError);
    const bridge = createNodeBridge();
    assert.deepEqual({ fetch, setImmediate, clearImmediate, setTimeout, clearTimeout }, originals);
    assert.equal(await bridge.close(), true);
  });

  it('rejects concurrent reuse of a body locked during cold startup', async () => {
    const bridge = fixture();
    const request = new Request('http://app.test/', { method: 'POST', body: 'once' });
    const work = input(
      async (req, res) => {
        res.end(await textOf(req));
      },
      { request },
    );
    const first = bridge.invokeNodeHandler(work);
    const second = assert.rejects(bridge.invokeNodeHandler(work));
    assert.equal(await (await first).text(), 'once');
    await second;
    await until(() => bridge.activeInvocations === 0);
    assert.equal(await bridge.close(100), true);
  });

  it('an early response cancels an indefinitely producing upload', async () => {
    const bridge = fixture();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await delay(5);
        if (!cancelled) controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          res.writeHead(413);
          res.end('too large');
        },
        { request: upload(body) },
      ),
    );
    assert.equal(response.status, 413);
    assert.equal(await response.text(), 'too large');
    await until(() => cancelled);
  });

  it('request source errors fail the call and leave no pending dispatch', async () => {
    const bridge = fixture();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upload failed'));
      },
    });
    const request = upload(body);
    const invocation = input(
      async (req, res) => {
        res.end(await textOf(req));
      },
      { request },
    );
    await assert.rejects(bridge.invokeNodeHandler(invocation), /upload failed/u);
    await until(() => bridge.activeInvocations === 0);
  });

  it('refuses unsolicited loopback requests without invoking application code', async () => {
    const bridge = fixture();
    let port = 0;
    let calls = 0;
    const response = await bridge.invokeNodeHandler(
      input(async (req, res) => {
        port = req.socket.localPort!;
        calls += 1;
        res.end('legitimate');
      }),
    );
    await response.text();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          headers: { 'x-upwind-native-dispatch': 'not-a-token' },
        },
        (reply) => {
          reply.resume();
          reply.once('end', () => {
            resolve(reply.statusCode!);
          });
        },
      );
      request.once('error', reject);
      request.end();
    });
    assert.equal(status, 404);
    assert.equal(calls, 1);
  });

  it('refuses HTTP upgrades instead of leaving an unresolved invocation', async () => {
    const bridge = fixture();
    await assert.rejects(
      bridge.invokeNodeHandler(
        input(async (_req, res) => {
          res.writeHead(101, { connection: 'upgrade', upgrade: 'websocket' });
          res.flushHeaders();
          res.end();
        }),
      ),
      /upgrades|closed/u,
    );
    assert.equal(await bridge.close(200), true);
  });

  it('shutdown waits for work even if the supplied waitUntil throws', async () => {
    const bridge = fixture();
    const release = gate();
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          res.end('accepted');
          await release.promise;
        },
        {
          request: new Request('http://app.test/', { method: 'POST' }),
          waitUntil() {
            throw new Error('host tracker failed');
          },
        },
      ),
    );
    await response.text();
    assert.equal(bridge.activeInvocations, 1);
    const closing = bridge.close(1000);
    release.resolve();
    assert.equal(await closing, true);
  });

  it('contains a reporter returning a rejecting promise', async () => {
    const bridge = fixture({
      onError: async () => {
        throw new Error('async report failed');
      },
    });
    const response = await bridge.invokeNodeHandler(
      input(async () => {
        throw new Error('render failed');
      }),
    );
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'Internal Server Error');
    await delay(10);
  });

  it('clears failed representation metadata before sending a generic error', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.setHeader('content-length', '999');
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-range', 'bytes 0-998/999');
        res.setHeader('etag', '"old"');
        res.setHeader('location', '/old');
        res.setHeader('cache-control', 'public, max-age=3600');
        res.setHeader('set-cookie', 'session=updated; Path=/');
        throw new Error('not rendered');
      }),
    );
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-range'), null);
    assert.equal(response.headers.get('etag'), null);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(response.headers.getSetCookie(), ['session=updated; Path=/']);
    assert.equal(await response.text(), 'Internal Server Error');
  });

  it('preserves a custom status message', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        res.writeHead(202, 'Queued');
        res.end('accepted');
      }),
    );
    assert.equal(response.status, 202);
    assert.equal(response.statusText, 'Queued');
    await response.text();
  });

  it('contains a waitUntil callback that returns a rejected promise', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          res.end('accepted');
        },
        {
          request: new Request('https://app.test/', { method: 'POST' }),
          // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Exercise an invalid async waitUntil callback defensively.
          waitUntil: async () => {
            throw new Error('tracker failed');
          },
        },
      ),
    );
    assert.equal(await response.text(), 'accepted');
    await delay(10);
    assert.equal(await bridge.close(100), true);
  });

  it('backpressures a large response while the reader is paused', async () => {
    const bridge = fixture();
    const chunk = Buffer.alloc(64 * 1024);
    const total = 1024;
    let produced = 0;
    const stopped = gate();
    const response = await bridge.invokeNodeHandler(
      input(async (_req, res) => {
        await new Promise<void>((resolve) => {
          const pump = (): void => {
            while (!res.destroyed && produced < total) {
              produced += 1;
              if (!res.write(chunk)) return;
            }
            if (!res.destroyed) res.end();
          };
          res.on('drain', pump);
          res.once('close', () => {
            res.off('drain', pump);
            stopped.resolve();
            resolve();
          });
          pump();
        });
      }),
    );
    await delay(30);
    assert.ok(produced > 0 && produced < total, 'the unread body must not be fully buffered');
    await response.body!.cancel();
    await stopped.promise;
  });

  it('contains a fallback-composition failure by ending the transport', async () => {
    const bridge = fixture();
    await assert.rejects(
      bridge.invokeNodeHandler(
        input(async (_req, res) => {
          // Simulate a response wrapper failing while the bridge tries to compose its error page.
          res.writeHead = () => {
            throw new Error('response wrapper failed');
          };
          throw new Error('render failed');
        }),
      ),
      /socket|closed|hang up/u,
    );
    assert.equal(await bridge.close(200), true);
  });

  it('reuses private connections across completed invocations without sharing metadata', async () => {
    const bridge = fixture();
    const ports: number[] = [];
    for (const marker of ['first', 'second']) {
      const response = await bridge.invokeNodeHandler(
        input(
          async (req, res, ctx) => {
            ports.push(req.socket.remotePort!);
            res.end(String(ctx.requestMeta?.['marker']));
          },
          { requestMeta: { marker } },
        ),
      );
      assert.equal(await response.text(), marker);
    }
    assert.equal(ports.length, 2);
    assert.equal(ports[0], ports[1]);
  });

  it('clears failed representation metadata before invoking a custom error page', async () => {
    const bridge = fixture();
    const response = await bridge.invokeNodeHandler(
      input(
        async (_req, res) => {
          res.setHeader('content-length', '999');
          res.setHeader('content-encoding', 'gzip');
          res.setHeader('etag', 'failed');
          throw new Error('render failed');
        },
        {
          onFailure: async (_req, res) => {
            assert.equal(res.getHeader('content-length'), undefined);
            assert.equal(res.getHeader('content-encoding'), undefined);
            assert.equal(res.getHeader('etag'), undefined);
            res.statusCode = 503;
            res.end('fallback');
          },
        },
      ),
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(await response.text(), 'fallback');
  });
});
