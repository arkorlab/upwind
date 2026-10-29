import { handleNodeWebSocket } from '@stayingupwind/sdk/websocket';

let engine;
export async function GET(request) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Upgrade required', { status: 426 });
  }
  if (!engine) {
    const [{ Server: Engine }, { Server: SocketIO }] = await Promise.all([
      import('engine.io'), import('socket.io'),
    ]);
    engine = new Engine({
      transports: ['websocket'], allowUpgrades: false, perMessageDeflate: false,
      pingInterval: 100, pingTimeout: 5000,
    });
    const io = new SocketIO({ serveClient: false });
    io.bind(engine);
    io.on('connection', (socket) => socket.on('echo', (value) => socket.emit('echo', value)));
  }
  return handleNodeWebSocket(request, (req, socket, head) => engine.handleUpgrade(req, socket, head));
}
