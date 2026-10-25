import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { PLATFORM_REQUEST_HEADERS } from '@stayingupwind/core/paas';

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
const HTTP_NO_CONTENT = 204;
const HTTP_RESET_CONTENT = 205;
const HTTP_NOT_MODIFIED = 304;
const BODYLESS = new Set([HTTP_NO_CONTENT, HTTP_NOT_MODIFIED, HTTP_RESET_CONTENT]);

export function nativeOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    (origin.protocol !== 'http:' && origin.protocol !== 'https:') ||
    origin.username !== '' ||
    origin.password !== '' ||
    origin.pathname !== '/' ||
    origin.search !== '' ||
    origin.hash !== ''
  )
    throw new Error('the public origin must be an HTTP(S) origin without a path or credentials');
  return origin;
}

/** Only this public boundary removes control headers; internal captures keep their protocol. */
function publicHeaders(req: IncomingMessage, origin: URL): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    headers.append(req.rawHeaders[index] ?? '', req.rawHeaders[index + 1] ?? '');
  }
  const nominated = (headers.get('connection') ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase());
  for (const names of [HOP_HEADERS, nominated, PLATFORM_REQUEST_HEADERS]) {
    for (const name of names) if (name !== '') headers.delete(name);
  }
  // Snapshot before deleting: a live Headers iterator can skip the next field after a removal.
  const names = [...headers.keys()];
  for (const name of names) {
    if (name === 'forwarded' || name === 'x-real-ip' || name.startsWith('x-forwarded-'))
      headers.delete(name);
  }
  headers.set('host', origin.host);
  headers.set('x-forwarded-host', origin.host);
  headers.set('x-forwarded-proto', origin.protocol.slice(0, -1));
  return headers;
}

export function nativeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  configuredOrigin?: URL,
): Request {
  const target = req.url ?? '/';
  if (!target.startsWith('/')) throw new Error('an origin-form request target is required');
  const origin = configuredOrigin ?? nativeOrigin(`http://${req.headers.host ?? ''}`);
  const headers = publicHeaders(req, origin);
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(new Error('client disconnected'));
  };
  const uploadClosed = (): void => {
    if (!req.complete) abort();
  };
  const closed = (): void => {
    if (!res.writableFinished) abort();
    req.off('close', uploadClosed);
  };
  req.once('close', uploadClosed);
  res.once('close', closed);
  if ((req.destroyed && !req.complete) || res.destroyed) abort();
  const method = req.method ?? 'GET';
  const init: RequestInit & { duplex: 'half' } = {
    method,
    headers,
    signal: controller.signal,
    duplex: 'half',
    ...(!(method === 'GET' || method === 'HEAD') && {
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
    }),
  };
  // Concatenation deliberately keeps a // pathname from becoming a new authority.
  return new Request(`${origin.origin}${target}`, init);
}

/** Commit headers before reading the body. A PPR shell never waits for the deferred render. */
export async function writeNativeResponse(
  req: IncomingMessage,
  res: ServerResponse,
  response: Response,
): Promise<void> {
  const nominated = new Set(
    (response.headers.get('connection') ?? '').split(',').map((name) => name.trim().toLowerCase()),
  );
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name !== 'set-cookie' && !HOP_HEADERS.has(name) && !nominated.has(name))
      res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader('set-cookie', cookies);
  if (req.method === 'HEAD' || BODYLESS.has(response.status) || response.body === null) {
    await response.body?.cancel();
    res.end();
    return;
  }
  res.flushHeaders();
  await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), res);
}
