import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';

import type { WebSocket as NativeWebSocket } from '@cloudflare/workers-types';
import { Server as EngineIOServer } from 'engine.io';
import { Server as SocketIOServer } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { handleNodeWebSocket } from '../../src/websocket.ts';

function request(): Request {
  return new Request('https://example.com/socket?EIO=4&transport=websocket', {
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
    },
  });
}

function client(
  response: Response,
  onMessage?: (message: string, socket: NativeWebSocket) => void,
): NativeWebSocket {
  const upgraded = response as Response & { readonly webSocket: NativeWebSocket | null };

  expect(response.status).toBe(101);

  const socket = upgraded.webSocket;
  if (socket === null) throw new Error('Missing upgrade socket');
  socket.binaryType = 'arraybuffer';
  if (onMessage !== undefined) {
    socket.addEventListener('message', (event) => {
      onMessage(String(event.data), socket);
    });
  }
  socket.accept();
  return socket;
}

function nextMessage(socket: NativeWebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.addEventListener(
      'message',
      (event) => {
        resolve(event.data);
      },
      { once: true },
    );
    socket.addEventListener(
      'error',
      () => {
        reject(new Error('WebSocket error'));
      },
      { once: true },
    );
  });
}

describe('real ws on Workers', () => {
  it('rejects a verifier destroying its request before the handshake deadline', async () => {
    const rejected = handleNodeWebSocket(request(), (incoming) => {
      incoming.destroy(new Error('verifier denied the request'));
    });

    await expect(rejected).rejects.toThrow('verifier denied the request');
  });

  it('closes an accepted native connection when the Node request is destroyed', async () => {
    const server = new WebSocketServer({ noServer: true });
    const handed = Promise.withResolvers<IncomingMessage>();
    const response = await handleNodeWebSocket(request(), (incoming, socket, head) => {
      handed.resolve(incoming);
      server.handleUpgrade(incoming, socket, head, (ws) => {
        ws.on('error', () => {
          // The client's close code below observes this deliberate connection failure.
        });
      });
    });
    const socket = client(response);
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener(
        'close',
        (event) => {
          resolve(event.code);
        },
        { once: true },
      );
    });
    const incoming = await handed.promise;
    incoming.destroy(new Error('application closed the request'));

    await expect(closed).resolves.toBe(1011);

    server.close();
  });

  it('echoes text and binary data through a real ws.Server and preserves handshake headers', async () => {
    const server = new WebSocketServer({ noServer: true });
    server.on('headers', (headers) => {
      headers.push('x-upgrade-test: preserved', 'Set-Cookie: connected=1');
    });
    const closed = Promise.withResolvers<number>();
    const response = await handleNodeWebSocket(request(), (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data, binary) => {
          ws.send(data, { binary });
        });
        ws.on('close', (code) => {
          closed.resolve(code);
        });
      });
    });

    expect(response.headers.get('x-upgrade-test')).toBe('preserved');
    expect(response.headers.get('set-cookie')).toBe('connected=1');

    const socket = client(response);
    const text = nextMessage(socket);
    socket.send('hello');

    await expect(text).resolves.toBe('hello');

    const binary = nextMessage(socket);
    socket.send(new Uint8Array([1, 2, 255]));

    expect(new Uint8Array((await binary) as ArrayBuffer)).toStrictEqual(
      new Uint8Array([1, 2, 255]),
    );

    socket.close(1000, 'done');

    await expect(closed.promise).resolves.toBe(1000);

    server.close();
  });

  it('reassembles ws fragments and split socket writes before native delivery', async () => {
    const server = new WebSocketServer({ noServer: true });
    const response = await handleNodeWebSocket(request(), (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', () => {
          ws.send('first-', { fin: false });
          ws.send('second', { fin: true });
        });
      });
    });
    const socket = client(response);
    const message = nextMessage(socket);
    socket.send('go');

    await expect(message).resolves.toBe('first-second');

    socket.close(1000);
    server.close();
  });

  it('fails protocol ping explicitly and closes the native connection without a fabricated pong', async () => {
    const server = new WebSocketServer({ noServer: true });
    const failure = Promise.withResolvers<Error>();
    const response = await handleNodeWebSocket(request(), (req, socket, head) => {
      server.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', (error) => {
          failure.resolve(error);
        });
        ws.on('message', () => {
          ws.ping('probe', false, (error) => {
            failure.resolve(error);
          });
        });
        ws.on('pong', () => {
          failure.reject(new Error('A pong must never be fabricated'));
        });
      });
    });
    const socket = client(response);
    socket.send('ping');

    await expect(failure.promise).resolves.toHaveProperty(
      'message',
      expect.stringContaining('ping/pong'),
    );

    socket.close();
    server.close();
  });

  it('runs Socket.IO websocket-only handshake, event echo and application heartbeat', async () => {
    const engine = new EngineIOServer({
      // Use the same real ws export as the bridge when workerd's CJS fallback resolves a copy
      // outside this Vite project. The built Next.js fixture also covers Engine.IO's default.
      wsEngine: WebSocketServer,
      transports: ['websocket'],
      allowUpgrades: false,
      perMessageDeflate: false,
      pingInterval: 20,
      pingTimeout: 1000,
    });
    const io = new SocketIOServer({ serveClient: false });
    io.bind(engine);
    io.on('connection', (socket) => {
      socket.on('echo', (value: string) => socket.emit('echo', value));
    });
    const response = await handleNodeWebSocket(request(), (req, socket, head) => {
      engine.handleUpgrade(req, socket, head);
    });
    const messages: string[] = [];
    const echoed = Promise.withResolvers<string>();
    const heartbeat = Promise.withResolvers<boolean>();
    const socket = client(response, (value, connection) => {
      messages.push(value);
      if (value.startsWith('0')) connection.send('40');
      if (value.startsWith('40')) connection.send('42["echo","hello"]');
      if (value.startsWith('42')) echoed.resolve(value);
      if (value === '2') {
        connection.send('3');
        heartbeat.resolve(true);
      }
    });

    await expect(echoed.promise).resolves.toBe('42["echo","hello"]');

    await heartbeat.promise;

    expect(messages.some((value) => value.startsWith('0{"sid":'))).toBe(true);

    socket.close(1000);
    engine.close();
  });

  it('rejects messages larger than the bridge limit', async () => {
    const response = await handleNodeWebSocket(request(), (_req, socket) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
      );
      // A frame declaring a payload above the limit fails before that payload is buffered.
      const header = Buffer.alloc(10);
      header[0] = 0x82;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(32 * 1024 * 1024 + 1), 2);
      socket.write(header);
    });
    const socket = client(response);
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener(
        'close',
        (event) => {
          resolve(event.code);
        },
        { once: true },
      );
    });

    await expect(closed).resolves.toBe(1011);
  });
});
