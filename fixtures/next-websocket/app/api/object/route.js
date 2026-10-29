import { durableObject } from '@stayingupwind/sdk/durable-object';

export function GET(request) {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Upgrade required', { status: 426 });
  }
  const namespace = durableObject('CHAT');
  if (!namespace) throw new Error('CHAT namespace not published');
  return namespace.get(namespace.idFromName('room')).fetch(request.url, { headers: request.headers });
}
