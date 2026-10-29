/** An HTTP handshake whose response belongs to the application's WebSocket transport. */
export function isWebSocketUpgrade(request: Pick<Request, 'method' | 'headers'>): boolean {
  return request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}
