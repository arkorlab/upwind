import { DurableObject } from 'cloudflare:workers';

export class Chat extends DurableObject {
  fetch() {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  webSocketMessage(socket, message) {
    socket.send(typeof message === 'string' ? `object:${message}` : message);
  }
}
