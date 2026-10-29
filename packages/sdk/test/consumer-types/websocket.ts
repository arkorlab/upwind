import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import { handleNodeWebSocket, type NodeWebSocketUpgrade } from '@stayingupwind/sdk/websocket';

const upgrade: NodeWebSocketUpgrade = (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
  socket.end(
    `HTTP/1.1 403 Forbidden\r\nx-path: ${incoming.url}\r\nx-head: ${String(head.length)}\r\nContent-Length: 0\r\n\r\n`,
  );
};

export function publicWebSocketTypes(request: Request): Promise<Response> {
  return handleNodeWebSocket(request, upgrade);
}
