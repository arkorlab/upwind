import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';

/** HTTP message framing belongs to each connection, never to the message forwarded through it. */
const CONNECTION_FIELDS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function connectionFields(headers: Headers): ReadonlySet<string> {
  const extra = (headers.get('connection') ?? '')
    .split(',')
    .map((field) => field.trim().toLowerCase())
    .filter((field) => field.length > 0);
  const names = new Set(CONNECTION_FIELDS);
  for (const name of extra) names.add(name);
  return names;
}

/** rawHeaders retains repeated Set-Cookie lines, including commas inside an Expires attribute. */
export function responseHeaders(raw: readonly string[]): Headers {
  const headers = new Headers();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    const value = raw[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  const omitted = connectionFields(headers);
  for (const name of omitted) headers.delete(name);
  return headers;
}

/** Restore application headers rather than exposing the bridge's address, token or framing. */
export function restoreRequest(req: IncomingMessage, request: Request, url: string): void {
  // Node's real IncomingMessage headers have Object.prototype. Next.js's HeadersAdapter calls
  // hasOwnProperty on this object, so a null-prototype map is not compatible with its handler.
  const headers: IncomingHttpHeaders = {};
  const distinct: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  const raw: string[] = [];
  const original = new Headers(request.headers);
  if (!original.has('host')) original.set('host', new URL(request.url).host);
  for (const [name, value] of original) {
    raw.push(name, value);
    Object.defineProperty(headers, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
    distinct[name] = [value];
  }
  // req.headers may already have been materialized while the transport inspected its token.
  req.rawHeaders = raw;
  req.headers = headers;
  Object.defineProperty(req, 'headersDistinct', { configurable: true, value: distinct });
  req.url = url;
}

/** Next.js can append a build's Location after the response already named that destination. */
export function singleRedirectLocation(res: ServerResponse): void {
  const append = res.appendHeader.bind(res);
  res.appendHeader = (name, value) => {
    if (name.toLowerCase() !== 'location') return append(name, value);
    const destination = typeof value === 'string' ? value : value.at(-1);
    if (destination !== undefined) res.setHeader(name, destination);
    return res;
  };
}
