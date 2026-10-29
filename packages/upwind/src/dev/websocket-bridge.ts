/* eslint-disable @typescript-eslint/no-deprecated, sonarjs/deprecation -- Next's serializer/router explicitly use ServerResponse.finished; an upgrade must mark that legacy completion state without sending HTTP bytes. */
import { ServerResponse, type IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import { coupleWebSocket, type WebSocketPair } from 'miniflare';
import { WebSocketServer, type WebSocket } from 'ws';

const RESPONSE = Symbol.for('upwind.websocket-response@1');
export const RAW_UPGRADE = 'upwind.websocket-upgrade@1';

const SWITCHING_PROTOCOLS = 101;
const INTERNAL_ERROR = 500;
const GOING_AWAY = 1001;
const CLOSE_GRACE_MS = 50;

export interface DevWebSocketBridge {
  readonly upgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
}

const RESERVED = new Set([
  'connection',
  'content-length',
  'sec-websocket-accept',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'transfer-encoding',
  'upgrade',
]);

/** One server's accepted connections; no message relay is installed in production. */
export function createDevWebSocketBridge(): DevWebSocketBridge {
  let closing: Promise<void> | undefined;
  const headers = new WeakMap<IncomingMessage, ReturnType<ServerResponse['getHeaders']>>();
  const sockets = new Set<Duplex>();
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (offered, request) => {
      const field = headers.get(request)?.['sec-websocket-protocol'];
      const selected = Array.isArray(field) && field.length === 1 ? field[0] : field;
      return typeof selected === 'string' && offered.has(selected) ? selected : false;
    },
  });
  server.on('headers', (lines, request) => {
    const outgoing = headers.get(request);
    if (outgoing === undefined) return;
    const entries = Object.entries(outgoing);
    for (const [name, value] of entries) {
      if (value === undefined || RESERVED.has(name.toLowerCase())) continue;
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) lines.push(`${name}: ${String(entry)}`);
    }
  });

  async function upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    handle: Parameters<DevWebSocketBridge['upgrade']>[3],
  ): Promise<void> {
    type WorkerSocket = InstanceType<typeof WebSocketPair>[0];
    type NativeResponse = Response & { readonly webSocket?: WorkerSocket | null };
    if (!(socket instanceof Socket))
      throw new TypeError('upwind: a Node HTTP upgrade requires a network socket');
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    // A peer disappearing during compilation must neither crash the server nor leave Next waiting.
    socket.on('error', () => {
      socket.destroy();
    });
    request.on('error', () => {
      socket.destroy();
    });
    const response = new ServerResponse(request);
    socket.once('close', () => {
      response.emit('close');
    });
    const writeHead = response.writeHead.bind(response);
    response.writeHead = ((...args: Parameters<ServerResponse['writeHead']>) => {
      // Ordinary rejections/redirects can stream immediately. An accepted handshake is intercepted
      // before writeHead, so its raw socket is still owned by the WebSocket server alone.
      if (response.socket === null) response.assignSocket(socket);
      return writeHead(...args);
    }) as ServerResponse['writeHead'];
    Object.defineProperties(response, {
      [Symbol.for(RAW_UPGRADE)]: { value: { socket, head } },
      [RESPONSE]: {
        value: (answer: NativeResponse): void => {
          const worker = answer.webSocket;
          if (worker === null || worker === undefined || answer.status !== SWITCHING_PROTOCOLS) {
            throw new TypeError(
              'upwind: a native WebSocket response needs status 101 and a socket',
            );
          }
          if (closing !== undefined || socket.destroyed) {
            // Compilation can finish after the peer has left. Deliver a close to the application's
            // side too, so its per-connection timers/listeners can be released.
            worker.accept();
            worker.close(GOING_AWAY, 'Client disconnected before upgrade');
            response.finished = true;
            response.emit('finish');
            return;
          }
          const outgoing = response.getHeaders();
          const field = outgoing['sec-websocket-protocol'];
          // NodeNextResponse.appendHeader stores even a single protocol as a one-element array.
          const protocol = Array.isArray(field) && field.length === 1 ? field[0] : field;
          if (
            protocol !== undefined &&
            (typeof protocol !== 'string' ||
              request.headers['sec-websocket-protocol']
                ?.split(',')
                .map((part) => part.trim())
                .includes(protocol) !== true)
          ) {
            throw new TypeError(
              'upwind: the response selected a WebSocket subprotocol the client did not offer',
            );
          }
          headers.set(request, outgoing);
          response.finished = true;
          server.handleUpgrade(request, socket, head, (client: WebSocket) => {
            client.on('error', () => {
              client.terminate();
            });
            void coupleWebSocket(client, worker).catch(() => {
              client.terminate();
            });
          });
          response.emit('finish');
        },
      },
    });
    try {
      await handle(request, response);
      if (!response.finished && !response.destroyed && !socket.destroyed) response.end();
    } catch (error) {
      if (response.headersSent || response.finished || socket.destroyed) socket.destroy();
      else {
        response.writeHead(INTERNAL_ERROR, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Internal Server Error');
      }
      throw error;
    }
  }

  async function closeConnections(): Promise<void> {
    for (const client of server.clients) client.close(GOING_AWAY, 'Development server stopping');
    // Bound cleanup even when a peer never answers the closing handshake.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_GRACE_MS);
      if (sockets.size === 0) {
        clearTimeout(timer);
        resolve();
      }
    });
    for (const socket of sockets) socket.destroy();
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  return {
    upgrade,
    close: (): Promise<void> => {
      closing ??= closeConnections();
      return closing;
    },
  };
}
