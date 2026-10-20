import { EventEmitter } from 'node:events';
import type { createServer, RequestListener } from 'node:http';

import { describe, expect, it, vi } from 'vitest';

import { changesSomething, invokeNodeHandler } from '../src/node-bridge.ts';

const transport = vi.hoisted(() => ({ listener: undefined as RequestListener | undefined }));

vi.mock(import('node:http'), () => {
  return {
    createServer: ((listener: RequestListener) => {
      transport.listener = listener;
      return {
        listen: () => {
          // The transport dispatches directly without a listening socket.
        },
      };
    }) as unknown as typeof createServer,
  };
});

vi.mock(import('cloudflare:node'), () => {
  return {
    handleAsNodeRequest: (_port: number, request: Request, _env: unknown, dispatch: unknown) => {
      const answer = Promise.withResolvers<Response>();
      const headers = new Headers();
      const active = {
        method: request.method,
        rawHeaders: [],
        headers: {},
        socket: null,
        cloudflare: { ctx: dispatch },
      };
      // eslint-disable-next-line unicorn/prefer-event-target -- Model Node's response finish/close events and listener cleanup.
      class MockResponse extends EventEmitter {
        #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        statusCode = 200;
        headersSent = false;
        writableEnded = false;
        writableFinished = false;
        destroyed = false;
        readonly body = new ReadableStream<Uint8Array>({
          start: (value) => {
            this.#controller = value;
          },
          cancel: () => {
            this.destroy();
          },
        });

        #commit(): void {
          if (this.headersSent) return;
          this.headersSent = true;
          answer.resolve(new Response(this.body, { status: this.statusCode, headers }));
        }

        appendHeader(): this {
          return this;
        }

        setHeader(name: string, value: string): void {
          headers.set(name, value);
        }

        write(chunk: string): boolean {
          this.#commit();
          this.#controller?.enqueue(new TextEncoder().encode(chunk));
          return true;
        }

        end(chunk?: string): void {
          this.#commit();
          if (chunk !== undefined) this.#controller?.enqueue(new TextEncoder().encode(chunk));
          this.writableEnded = true;
          this.writableFinished = true;
          this.#controller?.close();
          this.emit('finish');
          this.emit('close');
        }

        destroy(): this {
          this.destroyed = true;
          this.emit('close');
          return this;
        }
      }
      if (transport.listener === undefined) throw new Error('bridge listener absent');
      const response = new MockResponse();
      transport.listener(
        active as unknown as Parameters<RequestListener>[0],
        response as unknown as Parameters<RequestListener>[1],
      );
      return answer.promise;
    },
  };
});

describe('node handler completion after its response', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'POST'])(
    'holds %s work without waiting for it before answering',
    async (method) => {
      const release = Promise.withResolvers<undefined>();
      const held: Promise<unknown>[] = [];
      let finished = false;
      try {
        const answer = await invokeNodeHandler({
          request: new Request('https://handler.test/error', { method }),
          requestMeta: {},
          waitUntil: (pending) => {
            held.push(pending);
          },
          handler: async (_request, response) => {
            response.end('response before hook completion');
            await release.promise;
            finished = true;
          },
        });

        await expect(answer.text()).resolves.toBe('response before hook completion');
        expect(finished).toBe(false);
        expect(held).toHaveLength(1);
      } finally {
        release.resolve(undefined);
        await Promise.all(held);
      }

      expect(finished).toBe(true);
    },
  );

  it('retains safe work at a later normal finish, with no hold while its body is open', async () => {
    const finish = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const held: Promise<unknown>[] = [];
    let finished = false;
    try {
      const response = await invokeNodeHandler({
        request: new Request('https://handler.test/stream'),
        requestMeta: {},
        waitUntil: (pending) => {
          held.push(pending);
        },
        handler: async (_request, answer) => {
          answer.write('first');
          await finish.promise;
          answer.end('last');
          await release.promise;
          finished = true;
        },
      });

      expect(held).toHaveLength(0);

      finish.resolve(undefined);

      await expect(response.text()).resolves.toBe('firstlast');
      expect(held).toHaveLength(1);
      expect(finished).toBe(false);
    } finally {
      finish.resolve(undefined);
      release.resolve(undefined);
      await Promise.all(held);
    }

    expect(finished).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'does not retain a %s stream after premature close, even if finish follows',
    async (method) => {
      const release = Promise.withResolvers<undefined>();
      const held: Promise<unknown>[] = [];
      let response: Parameters<RequestListener>[1] | undefined;
      try {
        const answer = await invokeNodeHandler({
          request: new Request('https://handler.test/stream', { method }),
          requestMeta: {},
          waitUntil: (pending) => {
            held.push(pending);
          },
          handler: async (_request, active) => {
            response = active;
            active.write('opening');
            await release.promise;
          },
        });

        expect(held).toHaveLength(0);

        await answer.body?.cancel();

        expect(response?.listenerCount('finish')).toBe(0);

        response?.emit('finish');

        expect(held).toHaveLength(0);
      } finally {
        release.resolve(undefined);
      }
    },
  );

  it('keeps the outer Function mutation classification independent of handler completion', () => {
    expect(changesSomething('GET')).toBe(false);
    expect(changesSomething('HEAD')).toBe(false);
    expect(changesSomething('POST')).toBe(true);
    expect(changesSomething('DELETE')).toBe(true);
  });
});
