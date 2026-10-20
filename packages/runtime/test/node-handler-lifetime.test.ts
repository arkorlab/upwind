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
      const response = {
        statusCode: 200,
        headersSent: false,
        writableEnded: false,
        appendHeader: () => response,
        setHeader: (name: string, value: string) => {
          headers.set(name, value);
        },
        end: (body: string) => {
          response.headersSent = true;
          response.writableEnded = true;
          answer.resolve(new Response(body, { status: response.statusCode, headers }));
        },
      };
      if (transport.listener === undefined) throw new Error('bridge listener absent');
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

  it('keeps the outer Function mutation classification independent of handler completion', () => {
    expect(changesSomething('GET')).toBe(false);
    expect(changesSomething('HEAD')).toBe(false);
    expect(changesSomething('POST')).toBe(true);
    expect(changesSomething('DELETE')).toBe(true);
  });
});
