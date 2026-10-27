import * as zlib from 'node:zlib';

// Native fetch keeps the wire headers after decoding a complete supported coding chain.
// Undici 7.11 introduced zstd decoding; older Node 24 already had the zlib API.
// https://github.com/nodejs/undici/blob/v7.11.0/lib/web/fetch/index.js
const DECODED_CODINGS = new Set(['br', 'deflate', 'gzip', 'x-gzip']);
const ZSTD_UNDICI_MAJOR = 7;
const ZSTD_UNDICI_MINOR = 11;
const HTTP_PARTIAL = 206;
const PARTIAL_RESPONSE = 'Cannot forward a decoded partial response with encoded range offsets';

interface ResponseMetadata {
  readonly url: string;
  readonly redirected: boolean;
  readonly type: ResponseType;
}

class DecodedFetchResponse extends Response {
  readonly #metadata: ResponseMetadata;

  constructor(response: Response, headers: Headers, metadata: ResponseMetadata) {
    super(response.body, { status: response.status, statusText: response.statusText, headers });
    this.#metadata = metadata;
  }

  override get url(): string {
    return this.#metadata.url;
  }

  override get redirected(): boolean {
    return this.#metadata.redirected;
  }

  override get type(): ResponseType {
    return this.#metadata.type;
  }

  override clone(): Response {
    const response = super.clone();
    return new DecodedFetchResponse(response, response.headers, this.#metadata);
  }
}

function decodesZstd(): boolean {
  const version = /^(\d+)\.(\d+)\.\d+$/u.exec(process.versions['undici'] ?? '');
  return (
    version !== null &&
    (Number(version[1]) > ZSTD_UNDICI_MAJOR ||
      (Number(version[1]) === ZSTD_UNDICI_MAJOR && Number(version[2]) >= ZSTD_UNDICI_MINOR)) &&
    typeof Reflect.get(zlib, 'createZstdDecompress') === 'function'
  );
}

function decodedCoding(coding: string): boolean {
  return DECODED_CODINGS.has(coding) || (coding === 'zstd' && decodesZstd());
}

/** Call only at a native Fetch boundary, never on a raw IncomingMessage/Node handler response. */
export async function fetchedResponse(response: Response, method: string): Promise<Response> {
  if (method === 'HEAD' || method === 'CONNECT' || response.body === null) return response;
  const encoding = response.headers.get('content-encoding');
  if (encoding === null || encoding === '') return response;
  const codings = encoding
    .toLowerCase()
    .split(',')
    .map((coding) => coding.trim());
  if (codings.some((coding) => !decodedCoding(coding))) return response;
  if (response.status === HTTP_PARTIAL) {
    try {
      await response.body.cancel();
    } catch (error) {
      throw new TypeError(PARTIAL_RESPONSE, { cause: error });
    }
    throw new TypeError(PARTIAL_RESPONSE);
  }
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return new DecodedFetchResponse(response, headers, {
    url: response.url,
    redirected: response.redirected,
    type: response.type,
  });
}
