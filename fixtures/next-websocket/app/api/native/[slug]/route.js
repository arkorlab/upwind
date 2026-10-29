import { cookies } from 'next/headers';

export async function GET(request, context) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Upgrade required', { status: 426 });
  }
  const { slug } = await context.params;
  const pair = new WebSocketPair();
  pair[1].binaryType = 'arraybuffer';
  pair[1].accept();
  pair[1].addEventListener('message', (event) => pair[1].send(
    typeof event.data === 'string' ? `${slug}:${event.data}` : event.data,
  ));
  (await cookies()).set('route-cookie', 'kept');
  return new Response(null, {
    status: 101,
    webSocket: pair[0],
    headers: {
      'sec-websocket-protocol': 'echo',
      'set-cookie': 'response-cookie=kept; Path=/',
      'x-upgrade-visits': request.headers.get('x-upgrade-visits') ?? 'missing',
    },
  });
}
