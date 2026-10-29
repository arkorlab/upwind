import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
// eslint-disable-next-line n/no-unsupported-features/node-builtins -- This test exercises the same synchronous hooks as the Node 24 development preload.
import { createRequire, registerHooks } from 'node:module';
import type { AddressInfo } from 'node:net';

import type { ParsedUrl } from 'next/dist/shared/lib/router/utils/parse-url';
import { describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

import { createDevWebSocketBridge } from '../src/dev/websocket-bridge.ts';
import { bridgeProxyRequest } from '../src/dev/websocket-loader.ts';

const require = createRequire(import.meta.url);
type ProxyRequest = (
  request: IncomingMessage,
  response: ServerResponse,
  url: ParsedUrl,
) => Promise<unknown>;

/** Load the project's real Next proxy with only its development raw-upgrade handoff applied. */
function nextProxy(): ProxyRequest {
  const hook = registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (
        !url.endsWith('/next/dist/server/lib/router-utils/proxy-request.js') ||
        loaded.source === undefined
      )
        return loaded;
      const source =
        typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
      return { ...loaded, source: bridgeProxyRequest(source) };
    },
  });
  try {
    return (
      require('next/dist/server/lib/router-utils/proxy-request') as { proxyRequest: ProxyRequest }
    ).proxyRequest;
  } finally {
    hook.deregister();
  }
}

describe('development external WebSocket rewrites', () => {
  it('uses Next’s real proxy over the original upgrade socket and preserves target query/text/binary', async () => {
    const upstream = createServer();
    const peers = new WebSocketServer({ server: upstream, perMessageDeflate: false });
    const observed: string[] = [];
    peers.on('connection', (peer, request) => {
      observed.push(request.url ?? '');
      peer.on('error', () => {
        peer.terminate();
      });
      peer.on('message', (data, binary) => {
        peer.send(data, { binary });
      });
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const target = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/upstream?encoded=%2F%3F`;
    const proxy = nextProxy();
    const { parseUrl } = require('next/dist/shared/lib/router/utils/parse-url') as {
      parseUrl: (url: string) => ParsedUrl;
    };
    const bridge = createDevWebSocketBridge();
    const front = createServer();
    front.on('upgrade', (request, socket, head) => {
      bridge
        .upgrade(request, socket, head, async (incoming, response) => {
          await proxy(incoming, response, parseUrl(target));
        })
        // eslint-disable-next-line unicorn/prefer-await -- HTTP upgrade listeners cannot return a promise to EventEmitter.
        .catch(() => {
          socket.destroy();
        });
    });
    front.listen(0, '127.0.0.1');
    await once(front, 'listening');
    const client = new WebSocket(
      `ws://127.0.0.1:${String((front.address() as AddressInfo).port)}/external`,
      { perMessageDeflate: false },
    );
    try {
      await once(client, 'open');
      const echoedText = new Promise<string>((resolve, reject) => {
        client.once('message', (data) => {
          if (Buffer.isBuffer(data)) resolve(data.toString());
          else reject(new Error('expected the Node ws default Buffer payload'));
        });
      });
      client.send('external');

      await expect(echoedText).resolves.toBe('external');

      const received = new URL(observed[0] ?? '', 'http://fixture.test');

      expect(received.pathname).toBe('/upstream');
      expect(received.searchParams.get('encoded')).toBe('/?');

      const echoedBinary = new Promise<unknown>((resolve) => {
        client.once('message', (data) => {
          resolve(data);
        });
      });
      client.send(new Uint8Array([0, 255, 42]));

      await expect(echoedBinary).resolves.toStrictEqual(Buffer.from([0, 255, 42]));
    } finally {
      client.terminate();
      await bridge.close();
      await Promise.all([
        new Promise<void>((resolve) => {
          front.close(() => {
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          peers.close(() => {
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          upstream.close(() => {
            resolve();
          });
        }),
      ]);
    }
  });
});
