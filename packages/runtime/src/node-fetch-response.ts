import * as zlib from 'node:zlib';

// Node 24.22.1 / bundled Undici 7.30.1 decodes these complete coding chains without
// removing their wire encoding/length headers. Unknown codings disable the entire decoder chain.
// https://github.com/nodejs/node/blob/v24.22.1/deps/undici/src/lib/web/fetch/index.js#L2223-L2287
const DECODED_CODINGS = new Set(['br', 'deflate', 'gzip', 'x-gzip']);
const ZSTD_SUPPORTED = typeof Reflect.get(zlib, 'createZstdDecompress') === 'function';
const MAX_CODINGS = 5;

function decodedCoding(coding: string): boolean {
  return DECODED_CODINGS.has(coding) || (coding === 'zstd' && ZSTD_SUPPORTED);
}

/** Call only at a native Fetch boundary, never on a raw IncomingMessage/Node handler response. */
export function fetchedResponse(response: Response, method: string): Response {
  if (method === 'HEAD' || method === 'CONNECT' || response.body === null) return response;
  const encoding = response.headers.get('content-encoding');
  if (encoding === null || encoding === '') return response;
  const codings = encoding
    .toLowerCase()
    .split(',')
    .map((coding) => coding.trim());
  if (codings.length > MAX_CODINGS || codings.some((coding) => !decodedCoding(coding)))
    return response;
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
