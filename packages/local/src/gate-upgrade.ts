import { type IncomingMessage, request as requestHttp } from 'node:http';
import { request as requestHttps } from 'node:https';
import { Readable } from 'node:stream';

import { GATE_UNREACHABLE_HEADER } from './workers/protocol.ts';

/**
 * A gate's authorization request over HTTP, preserving Fetch Metadata and upgrade headers that
 * Node's `fetch` rewrites or refuses. An upgrade handshake remains for the Function to finish
 * where the gate says to pass; this connection carries the gate's ordinary answer only.
 */

const BODYLESS_STATUS = { noContent: 204, resetContent: 205, notModified: 304 } as const;
const BODYLESS_STATUSES: ReadonlySet<number> = new Set(Object.values(BODYLESS_STATUS));

/** The gate's unmodified bytes, streamed, with every header, including each cookie, kept beside them. */
function responseOf(incoming: IncomingMessage, method: string): Response {
  const status = incoming.statusCode;
  if (status === undefined) {
    throw new Error('the gate answered with no HTTP status');
  }
  const headers = new Headers();
  const { rawHeaders } = incoming;
  for (let at = 0; at + 1 < rawHeaders.length; at += 2) {
    const name = rawHeaders[at] ?? '';
    // Only the local transport may report that no remote HTTP answer was received.
    if (name.toLowerCase() !== GATE_UNREACHABLE_HEADER) {
      headers.append(name, rawHeaders[at + 1] ?? '');
    }
  }
  const bodyless = method === 'HEAD' || BODYLESS_STATUSES.has(status);
  if (bodyless) {
    incoming.resume();
  }
  const body = bodyless ? null : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
  return new Response(body, { status, statusText: incoming.statusMessage ?? '', headers });
}

/**
 * One authorization request, cancelled with the edge's signal, whose answer reaches the edge as
 * soon as its headers do. Node leaves compressed bytes as they arrived: no decoding metadata is
 * removed. An actual upgrade by the gate fails closed, with its socket released.
 */
export async function requestGate(
  url: string,
  request: Request,
  headers: Headers,
): Promise<Response> {
  // Fetch-style requests and the loopback transport omit this hop-by-hop handshake field.
  if (headers.has('upgrade')) headers.set('connection', 'Upgrade');
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const body = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
  return new Promise((resolve, reject) => {
    const transport = new URL(url).protocol === 'https:' ? requestHttps : requestHttp;
    const outgoing = transport(
      url,
      { method: request.method, headers: Object.fromEntries(headers), signal: request.signal },
      (incoming) => {
        try {
          resolve(responseOf(incoming, request.method));
        } catch (error) {
          incoming.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
    outgoing.once('error', reject);
    outgoing.once('upgrade', (_incoming, socket) => {
      socket.destroy();
      reject(new Error('the gate upgraded its authorization connection'));
    });
    outgoing.end(body);
  });
}
