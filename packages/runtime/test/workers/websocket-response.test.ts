import { WEBSOCKET_RESPONSE_SYMBOL } from '@stayingupwind/core/next';
import {
  FUNCTION_HEADER,
  HEADER_RULES_JUDGED_HEADER,
  MIDDLEWARE_DONE_HEADER,
} from '@stayingupwind/core/paas';
import { describe, expect, it } from 'vitest';

import type { NodeHandler } from '../../src/app-module.ts';
import { InvalidatedTags } from '../../src/cache/context.ts';
import { invokeNodeHandler } from '../../src/node-bridge.ts';
import { withoutPlacementHeaders } from '../../src/placement.ts';
import { withHeaderRulesLeft, withRoutingHeaders } from '../../src/routing.ts';
import { withInvalidatedTags } from '../../src/serve.ts';

/** Only the native socket members these tests use; the runtime package has DOM response types. */
interface Socket {
  binaryType: 'arraybuffer';
  accept(): void;
  send(data: string | ArrayBuffer): void;
  close(code: number, reason?: string): void;
  addEventListener(
    type: 'message',
    listener: (event: { readonly data: string | ArrayBuffer }) => void,
    options?: { readonly once?: boolean },
  ): void;
}

declare const WebSocketPair: new () => { readonly 0: Socket; readonly 1: Socket };

function switching(socket: Socket, headers?: HeadersInit): Response {
  const init: ResponseInit & { readonly webSocket: Socket } = {
    status: 101,
    webSocket: socket,
    ...(headers !== undefined && { headers }),
  };
  return new Response(null, init);
}

function socketOf(response: Response): Socket {
  const socket: unknown = Reflect.get(response, 'webSocket');
  if (typeof socket !== 'object' || socket === null) throw new TypeError('no WebSocket');
  return socket as Socket;
}

function handoff(response: Parameters<NodeHandler>[1], answer: Response): void {
  const accept: unknown = Reflect.get(response, Symbol.for(WEBSOCKET_RESPONSE_SYMBOL));
  if (typeof accept !== 'function') throw new TypeError('the upgrade response has no transport');
  const send = accept as (native: Response) => void;
  send(answer);
}

function invocation(handler: NodeHandler, upgrade = true): Promise<Response> {
  return invokeNodeHandler({
    handler,
    request: new Request('https://app.test/socket', {
      headers: upgrade ? { upgrade: 'WebSocket' } : {},
    }),
    requestMeta: {},
    waitUntil: () => {
      // These handlers leave no background work.
    },
  });
}

describe('native WebSocket responses through the Node bridge', () => {
  it('keeps the same socket and merged headers, with bidirectional text and binary messages', async () => {
    const pair = new WebSocketPair();
    pair[0].binaryType = 'arraybuffer';
    pair[1].binaryType = 'arraybuffer';
    pair[1].accept();
    pair[1].addEventListener('message', (event) => {
      pair[1].send(event.data);
    });
    const response = await invocation((_req, res) => {
      res.setHeader('x-routing', 'kept');
      res.setHeader('set-cookie', ['first=1', 'second=2']);
      handoff(res, switching(pair[0], { 'sec-websocket-protocol': 'echo' }));
      return Promise.resolve();
    });

    expect(response.status).toBe(101);
    expect(socketOf(response)).toBe(pair[0]);
    expect(response.headers.get('x-routing')).toBe('kept');
    expect(response.headers.get('sec-websocket-protocol')).toBe('echo');
    expect(response.headers.getSetCookie()).toStrictEqual(['first=1', 'second=2']);

    const socket = socketOf(response);
    socket.accept();
    for (const payload of ['hello', new Uint8Array([1, 2, 3]).buffer]) {
      const next = Promise.withResolvers<string | ArrayBuffer>();
      socket.addEventListener(
        'message',
        (event) => {
          next.resolve(event.data);
        },
        { once: true },
      );
      socket.send(payload);

      await expect(next.promise).resolves.toStrictEqual(payload);
    }
    socket.close(1000, 'done');
  });

  it('keeps concurrent handshakes on their own response, and preserves ordinary refusals', async () => {
    const handshakes = await Promise.all(
      ['first', 'second'].map((name) => {
        return invocation((_req, res) => {
          const pair = new WebSocketPair();
          pair[1].accept();
          res.setHeader('x-connection', name);
          handoff(res, switching(pair[0]));
          return Promise.resolve();
        });
      }),
    );

    expect(handshakes.map((answer) => answer.headers.get('x-connection'))).toStrictEqual([
      'first',
      'second',
    ]);

    for (const answer of handshakes) {
      socketOf(answer).accept();
      socketOf(answer).close(1000);
    }
    const refused = await invocation((_req, res) => {
      res.statusCode = 403;
      res.end('denied');
      return Promise.resolve();
    });

    expect(refused.status).toBe(403);
    await expect(refused.text()).resolves.toBe('denied');
  });

  it('installs no native handoff callback on ordinary HTTP requests', async () => {
    const response = await invocation((_req, res) => {
      expect(Reflect.get(res, Symbol.for(WEBSOCKET_RESPONSE_SYMBOL))).toBeUndefined();

      res.end('ordinary');
      return Promise.resolve();
    }, false);

    await expect(response.text()).resolves.toBe('ordinary');
  });

  it('preserves the socket through routing, placement and invalidation header changes', () => {
    const socket = new WebSocketPair()[0];
    const initial = switching(socket, { [FUNCTION_HEADER]: 'application-forgery' });
    const request = new Request('https://app.test/socket', {
      headers: { [MIDDLEWARE_DONE_HEADER]: '1', [HEADER_RULES_JUDGED_HEADER]: '1' },
    });
    const invalidated = new InvalidatedTags();
    invalidated.tags.add('changed');
    const routed = withRoutingHeaders(initial, new Headers({ 'x-rule': 'kept' }));
    const judged = withHeaderRulesLeft(request, routed);
    const answer = withInvalidatedTags(withoutPlacementHeaders(judged), invalidated);

    expect(answer.status).toBe(101);
    expect(socketOf(answer)).toBe(socket);
    expect(answer.headers.get('x-rule')).toBe('kept');
    expect(answer.headers.has(FUNCTION_HEADER)).toBe(false);
  });
});
