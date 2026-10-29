import { handleNodeWebSocket } from '@stayingupwind/sdk/websocket';

let server;
export async function GET(request) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Upgrade required', { status: 426 });
  }
  if (!server) {
    const { WebSocketServer } = await import('ws');
    server = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  }
  return handleNodeWebSocket(request, (req, socket, head) => {
    server.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => {});
      ws.on('message', (data, binary) => {
        ws.send(data, { binary });
      });
    });
  });
}
