import { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

/** Hop-by-hop headers belong to each HTTP connection, never to its forwarded message. */
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Snapshot names before deletion so consecutive internal headers are all removed. */
export function removeNodeControlHeaders(headers: Headers): void {
  const names = [...headers.keys()];
  for (const name of names) {
    if (name.startsWith('x-upwind-')) headers.delete(name);
  }
}

export function messageHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const value = message.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined && !HOP_HEADERS.has(name.toLowerCase())) {
      headers.append(name, value);
    }
  }
  const connections = (message.headers.connection ?? '').split(',');
  for (const name of connections) {
    if (name.trim() !== '') headers.delete(name.trim());
  }
  return headers;
}

export function messageRequest(
  message: IncomingMessage,
  url: string,
  headers: Headers,
  signal: AbortSignal,
): Request {
  const method = message.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers, signal };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(message) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/** Flush headers immediately, preserve separate cookies, and let Node's pipeline apply backpressure. */
export async function sendWebResponse(response: Response, output: ServerResponse): Promise<void> {
  output.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie' && !HOP_HEADERS.has(name)) output.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) output.setHeader('set-cookie', cookies);
  output.flushHeaders();
  if (response.body === null) {
    output.end();
    return;
  }
  await pipeline(
    Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
    output,
  );
}
