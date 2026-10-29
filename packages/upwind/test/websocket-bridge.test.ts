import { once } from 'node:events';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import { WebSocketPair } from 'miniflare';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createDevWebSocketBridge, RAW_UPGRADE } from '../src/dev/websocket-bridge.ts';
import { installWebSocketGlobals } from '../src/dev/websocket-globals.ts';

const cleanup: (() => Promise<void>)[] = [];

async function listening(
  handle: Parameters<ReturnType<typeof createDevWebSocketBridge>['upgrade']>[3],
) {
  const bridge = createDevWebSocketBridge();
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    // eslint-disable-next-line unicorn/prefer-await -- EventEmitter does not await listeners; consume the upgrade rejection here.
    bridge.upgrade(request, socket, head, handle).catch(() => {
      socket.destroy();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(async () => {
    await bridge.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return { bridge, address: `ws://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

function handed(response: ServerResponse, answer: Response): Promise<void> {
  response.statusCode = answer.status;
  for (const [name, value] of answer.headers) response.setHeader(name, [value]);
  const send = Reflect.get(response, Symbol.for('upwind.websocket-response@1')) as (
    value: Response,
  ) => void;
  send(answer);
  return Promise.resolve();
}

function message(client: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    client.once('message', (data) => {
      if (Array.isArray(data)) resolve(Buffer.concat(data));
      else if (data instanceof ArrayBuffer) resolve(Buffer.from(data));
      else resolve(data);
    });
  });
}

function closeEvent(client: WebSocket): Promise<[number, Buffer]> {
  return new Promise((resolve) => {
    client.once('close', (code, reason) => {
      resolve([code, reason]);
    });
  });
}

describe('development native WebSocket transport', () => {
  afterEach(async () => {
    for (const stop of cleanup.splice(0).toReversed()) await stop();
  });

  it('accepts a cold first upgrade and keeps finalized cookies, subprotocol, text, binary and close', async () => {
    const restore = installWebSocketGlobals();
    cleanup.push(() => {
      restore();
      return Promise.resolve();
    });
    const { address } = await listening((_request, response) => {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('message', (event) => {
        if (event.data === 'close') pair[1].close(1000, 'complete');
        else pair[1].send(event.data);
      });
      response.setHeader('set-cookie', ['middleware=kept; Path=/', 'route=kept; HttpOnly']);
      const init = {
        status: 101,
        webSocket: pair[0],
        headers: { 'sec-websocket-protocol': 'echo' },
      };
      return handed(response, new Response(null, init));
    });
    const client = new WebSocket(address, ['echo']);
    cleanup.push(() => {
      client.terminate();
      return Promise.resolve();
    });
    const upgrade = new Promise<IncomingMessage>((resolve) => {
      client.once('upgrade', resolve);
    });
    await once(client, 'open');
    const accepted = await upgrade;

    expect(accepted.headers['set-cookie']).toStrictEqual([
      'middleware=kept; Path=/',
      'route=kept; HttpOnly',
    ]);
    expect(client.protocol).toBe('echo');

    const text = message(client);
    client.send('hello');

    expect((await text).toString()).toBe('hello');

    const binary = message(client);
    client.send(new Uint8Array([0, 255, 42]));

    expect(new Uint8Array(await binary)).toStrictEqual(new Uint8Array([0, 255, 42]));

    const closed = closeEvent(client);
    client.send('close');
    const [code, reason] = await closed;

    expect([code, reason.toString()]).toStrictEqual([1000, 'complete']);
  });

  it('sends an ordinary application rejection and exposes the raw context for external proxies', async () => {
    const { address } = await listening((_request, response) => {
      const raw = Reflect.get(response, Symbol.for(RAW_UPGRADE)) as {
        head: Buffer;
        socket: unknown;
      };

      expect(raw.head).toBeInstanceOf(Buffer);
      expect(raw.socket).toBeDefined();

      response.writeHead(403, { 'content-type': 'text/plain' });
      response.end('not allowed');
      return Promise.resolve();
    });
    const client = new WebSocket(address);
    const rejection = new Promise<IncomingMessage>((resolve) => {
      client.once('unexpected-response', (_request, response) => {
        resolve(response);
      });
    });
    client.on('error', () => {
      /* Expected when this rejected client is terminated. */
    });
    const response = await rejection;
    const chunks: Buffer[] = [];
    for await (const chunk of response as AsyncIterable<Uint8Array>)
      chunks.push(Buffer.from(chunk));
    client.terminate();

    expect(response.statusCode).toBe(403);
    expect(Buffer.concat(chunks).toString()).toBe('not allowed');
  });

  it('closes accepted sockets before an idempotent server shutdown completes', async () => {
    const restore = installWebSocketGlobals();
    cleanup.push(() => {
      restore();
      return Promise.resolve();
    });
    const { address, bridge } = await listening((_request, response) => {
      const pair = new WebSocketPair();
      pair[1].accept();
      const init = { status: 101, webSocket: pair[0] };
      return handed(response, new Response(null, init));
    });
    const client = new WebSocket(address);
    await once(client, 'open');
    const closed = closeEvent(client);
    await Promise.all([bridge.close(), bridge.close()]);

    expect((await closed)[0]).toBe(1001);
  });

  it('closes an unhanded pair when the peer disconnects while the route is still compiling', async () => {
    const restore = installWebSocketGlobals();
    cleanup.push(() => {
      restore();
      return Promise.resolve();
    });
    const entered = Promise.withResolvers<undefined>();
    const continueRoute = Promise.withResolvers<undefined>();
    const pairClosed = Promise.withResolvers<undefined>();
    const { address } = await listening(async (_request, response) => {
      entered.resolve(undefined);
      await continueRoute.promise;
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('close', () => {
        pairClosed.resolve(undefined);
      });
      const init = { status: 101, webSocket: pair[0] };
      await handed(response, new Response(null, init));
    });
    const client = new WebSocket(address);
    client.on('error', () => {
      /* Expected when termination interrupts the handshake. */
    });
    await entered.promise;
    const closed = closeEvent(client);
    client.terminate();
    await closed;
    continueRoute.resolve(undefined);
    await pairClosed.promise;

    expect(client.readyState).toBe(WebSocket.CLOSED);
  });

  it.each([
    { name: 'an unoffered subprotocol', protocol: 'unoffered', version: '13', status: 500 },
    { name: 'an invalid wire handshake', protocol: 'echo', version: '12', status: 400 },
  ])('closes the application pair after rejecting $name', async ({ protocol, version, status }) => {
    const restore = installWebSocketGlobals();
    cleanup.push(() => {
      restore();
      return Promise.resolve();
    });
    const pairClosed = Promise.withResolvers<number>();
    const { address } = await listening((_request, response) => {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('close', (event) => {
        pairClosed.resolve(event.code);
      });
      const init = {
        status: 101,
        webSocket: pair[0],
        headers: { 'sec-websocket-protocol': protocol },
      };
      return handed(response, new Response(null, init));
    });
    const url = new URL(address);
    url.protocol = 'http:';
    const rejected = new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(url, {
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'AQIDBAUGBwgJCgsMDQ4PEA==',
          'sec-websocket-version': version,
          'sec-websocket-protocol': 'echo',
        },
      });
      request.once('response', (answer) => {
        answer.resume();
        resolve(answer.statusCode);
      });
      request.once('error', reject);
      request.end();
    });

    await expect(rejected).resolves.toBe(status);
    await expect(pairClosed.promise).resolves.toBe(1001);
  });

  it('closes the application pair if coupling rejects an already accepted response endpoint', async () => {
    const restore = installWebSocketGlobals();
    cleanup.push(() => {
      restore();
      return Promise.resolve();
    });
    const pairClosed = Promise.withResolvers<number>();
    const { address } = await listening((_request, response) => {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('close', (event) => {
        pairClosed.resolve(event.code);
      });
      pair[0].accept();
      const init = { status: 101, webSocket: pair[0] };
      return handed(response, new Response(null, init));
    });
    const client = new WebSocket(address);
    const closed = closeEvent(client);
    await once(client, 'open');

    await expect(pairClosed.promise).resolves.toBe(1001);
    expect((await closed)[0]).toBe(1006);
  });
});
