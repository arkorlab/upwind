import { Buffer } from 'node:buffer';
import type { Duplex } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { handleNodeWebSocket } from '../src/websocket.ts';

const HEADERS = {
  upgrade: 'websocket',
  connection: 'Upgrade',
  'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  'sec-websocket-version': '13',
};

function request(options: RequestInit = {}): Request {
  return new Request('https://example.com/socket?room=one', { headers: HEADERS, ...options });
}

describe('handleNodeWebSocket handshake', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('answers ordinary HTTP without invoking the callback or requiring a Workers runtime', async () => {
    const upgrade = vi.fn();
    const response = await handleNodeWebSocket(new Request('https://example.com/socket'), upgrade);

    expect(response.status).toBe(426);
    expect(response.headers.get('upgrade')).toBe('websocket');
    expect(upgrade).not.toHaveBeenCalled();
  });

  it.each([
    { ...HEADERS, 'sec-websocket-key': 'invalid' },
    { ...HEADERS, 'sec-websocket-version': '12' },
  ])('rejects invalid protocol headers before invoking Node code', async (headers) => {
    const upgrade = vi.fn();

    expect((await handleNodeWebSocket(request({ headers }), upgrade)).status).toBe(400);
    expect(upgrade).not.toHaveBeenCalled();
  });

  it('passes the request path, headers and empty head to a real ws verifier', async () => {
    const server = new WebSocketServer({
      noServer: true,
      verifyClient(info, done) {
        expect(info.req.url).toBe('/socket?room=one');
        expect(info.req.headers['sec-websocket-version']).toBe('13');
        expect(info.secure).toBe(true);

        queueMicrotask(() => {
          done(false, 403, 'Forbidden', { 'x-auth': 'denied' });
        });
      },
    });
    const response = await handleNodeWebSocket(request(), (req, socket, head) => {
      expect(head).toStrictEqual(Buffer.alloc(0));

      server.handleUpgrade(req, socket, head, () => {
        throw new Error('A denied connection must not open');
      });
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('x-auth')).toBe('denied');
    await expect(response.text()).resolves.toBe('Forbidden');

    server.close();
  });

  it('reads split HTTP headers and rejection bodies', async () => {
    const response = await handleNodeWebSocket(request(), (_req, socket) => {
      socket.write('HTTP/1.1 401 Unauthorized\r\nx-test: one\r\n');
      socket.write('Set-Cookie: first=1\r\nSet-Cookie: second=2\r\n\r');
      socket.write('\nno');
      socket.end(' access');
    });

    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toStrictEqual(['first=1', 'second=2']);
    await expect(response.text()).resolves.toBe('no access');
  });

  it('rejects negotiated compression explicitly before requiring a Workers runtime', async () => {
    const server = new WebSocketServer({ noServer: true, perMessageDeflate: true });

    await expect(
      handleNodeWebSocket(
        request({ headers: { ...HEADERS, 'sec-websocket-extensions': 'permessage-deflate' } }),
        (req, socket, head) => {
          server.handleUpgrade(req, socket, head, (ws) => {
            return ws.on('error', () => {
              // The helper's response promise is the failure asserted below.
            });
          });
        },
      ),
    ).rejects.toThrow('perMessageDeflate: false');

    server.close();
  });

  it('bounds handshake headers', async () => {
    await expect(
      handleNodeWebSocket(request(), (_req, socket) => {
        socket.write('x'.repeat(16 * 1024 + 1));
      }),
    ).rejects.toThrow('16 KiB');
  });

  it('propagates synchronous callback failures', async () => {
    await expect(
      handleNodeWebSocket(request(), () => {
        throw new Error('verification failed');
      }),
    ).rejects.toThrow('verification failed');
  });

  it('observes asynchronous callback failures', async () => {
    await expect(
      handleNodeWebSocket(request(), () => Promise.reject(new Error('async verification failed'))),
    ).rejects.toThrow('async verification failed');
  });

  it('aborts an asynchronous handshake', async () => {
    const abort = new AbortController();
    const response = handleNodeWebSocket(request({ signal: abort.signal }), () => {
      // Remain pending until the client aborts.
    });
    abort.abort(new Error('client disconnected'));

    await expect(response).rejects.toThrow('client disconnected');
  });

  it('times out a callback that never decides', async () => {
    vi.useFakeTimers();
    let entered = false;
    const response = handleNodeWebSocket(request(), () => {
      entered = true;
    });
    // eslint-disable-next-line unicorn/prefer-await -- Observe rejection before advancing its fake deadline.
    const observed = response.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(entered).toBe(true);
    });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(observed).resolves.toHaveProperty(
      'message',
      expect.stringContaining('10 seconds'),
    );
  });

  it('accepts development socket byte views without reading bytes outside their offsets', async () => {
    const sent = Promise.withResolvers<Uint8Array>();
    class DevelopmentSocket extends EventTarget {
      binaryType = 'arraybuffer';
      readyState = 1;
      accept(): void {
        // A development socket needs no platform acceptance.
      }
      send(data: unknown): void {
        if (ArrayBuffer.isView(data)) {
          sent.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
      }
      close(): void {
        this.readyState = 3;
      }
    }
    const serverSocket = new DevelopmentSocket();
    vi.stubGlobal(
      'WebSocketPair',
      class {
        readonly 0 = new DevelopmentSocket();
        readonly 1 = serverSocket;
      },
    );
    const NodeResponse = Response;
    vi.stubGlobal(
      'Response',
      class extends NodeResponse {
        constructor(body: BodyInit | null, init: ResponseInit) {
          super(body, init.status === 101 ? { ...init, status: 200 } : init);
          if (init.status === 101) Object.defineProperty(this, 'status', { value: 101 });
        }
      },
    );
    const server = new WebSocketServer({ noServer: true });
    let transport: Duplex | undefined;
    await handleNodeWebSocket(request(), (req, socket, head) => {
      transport = socket;
      server.handleUpgrade(req, socket, head, (ws) => {
        ws.on('message', (data, binary) => {
          ws.send(data, { binary });
        });
      });
    });
    const storage = new Uint8Array([99, 1, 2, 255, 99]);
    serverSocket.dispatchEvent(new MessageEvent('message', { data: storage.subarray(1, 4) }));

    await expect(sent.promise).resolves.toStrictEqual(new Uint8Array([1, 2, 255]));

    serverSocket.readyState = 2;
    transport?.destroy();

    expect(serverSocket.readyState).toBe(3);

    server.close();
  });
});
