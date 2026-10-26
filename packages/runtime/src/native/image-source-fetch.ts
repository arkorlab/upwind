import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { Agent as HttpAgent, type IncomingMessage, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { pipeline, Readable, Transform, type TransformCallback } from 'node:stream';
import {
  constants,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
  createZstdDecompress,
} from 'node:zlib';

import { isLocalAddress } from '@stayingupwind/core/images';

import { ImageDestinationError } from '../image-source-error.ts';
import type { ImageSourceFetcher } from '../image-source-fetch.ts';

type ResolveAddresses = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const IPV6_FAMILY = 6;
const ZLIB_METHOD_MASK = 0x0f;
const ZLIB_DEFLATE_METHOD = 0x08;
const HTTP_NO_CONTENT = 204;
const HTTP_RESET_CONTENT = 205;
const HTTP_NOT_MODIFIED = 304;
const HTTP_BAD_GATEWAY = 502;

function failure(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error('image source request failed', { cause: error });
}

/** Validate the socket's own resolution, so there is no second lookup a rebinding can change. */
export function guardedImageLookup(resolve: ResolveAddresses = lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, []);
        return;
      }
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) =>
          isLocalAddress(isIP(address) === IPV6_FAMILY ? `[${address}]` : address),
        )
      ) {
        callback(new ImageDestinationError(), []);
        return;
      }
      // Preserve the socket's requested family and happy-eyeballs fallback order.
      if (options.all === true) callback(null, addresses);
      else {
        const first = addresses[0];
        if (first === undefined) callback(new ImageDestinationError(), []);
        else callback(null, first.address, first.family);
      }
    });
  };
}

/** HTTP permits raw deflate as well as a zlib-wrapped stream, as native fetch accepts both. */
class DeflateDecoder extends Transform {
  #decoder: ReturnType<typeof createInflate> | undefined;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    if (chunk.length === 0) {
      callback();
      return;
    }
    if (this.#decoder === undefined) {
      // eslint-disable-next-line no-bitwise -- the low nibble identifies the zlib compression method.
      const wrapped = ((chunk[0] ?? 0) & ZLIB_METHOD_MASK) === ZLIB_DEFLATE_METHOD;
      this.#decoder = wrapped
        ? createInflate({ flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH })
        : createInflateRaw({
            flush: constants.Z_SYNC_FLUSH,
            finishFlush: constants.Z_SYNC_FLUSH,
          });
      this.#decoder.on('data', (bytes: Buffer) => {
        this.push(bytes);
      });
      this.#decoder.on('error', (error: Error) => {
        this.destroy(error);
      });
    }
    this.#decoder.write(chunk, callback);
  }

  override _final(callback: TransformCallback): void {
    if (this.#decoder === undefined) callback();
    else {
      this.#decoder.once('end', callback);
      this.#decoder.end();
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.#decoder?.destroy();
    callback(error);
  }
}

const DECODINGS = new Set(['br', 'deflate', 'gzip', 'x-gzip', 'zstd']);
const MAX_CONTENT_ENCODINGS = 5;
const BODYLESS_STATUSES = new Set([HTTP_NO_CONTENT, HTTP_NOT_MODIFIED, HTTP_RESET_CONTENT]);

function decodedBody(response: IncomingMessage): Readable {
  const raw = response.headers['content-encoding'];
  if (raw === undefined) return response;
  const codings = raw
    .toLowerCase()
    .split(',')
    .map((coding) => coding.trim());
  if (codings.length > MAX_CONTENT_ENCODINGS) {
    response.destroy();
    throw new Error('too many image content encodings');
  }
  // Match fetch: an unknown coding leaves the complete representation encoded.
  if (codings.some((coding) => !DECODINGS.has(coding))) return response;
  const decoders = codings.toReversed().map((coding) => {
    switch (coding) {
      case 'br': {
        return createBrotliDecompress();
      }
      case 'zstd': {
        return createZstdDecompress();
      }
      case 'deflate': {
        return new DeflateDecoder();
      }
      default: {
        return createGunzip({ flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH });
      }
    }
  });
  const last = decoders.at(-1);
  if (last === undefined) return response;
  // pipeline propagates cancellation back to the upstream socket as well as decoder errors.
  pipeline([response, ...decoders], () => {
    // The returned readable carries pipeline errors to its consumer.
  });
  return last;
}

export interface ImageSourceTransport {
  readonly fetch: ImageSourceFetcher;
  readonly close: () => void;
}

/** Separate pools keep an opted-in local source from lending a socket to protected requests. */
export function createImageSourceTransport(
  resolveAddresses?: ResolveAddresses,
): ImageSourceTransport {
  const guarded = guardedImageLookup(resolveAddresses);
  const protectedHttp = new HttpAgent({ keepAlive: true, lookup: guarded });
  const protectedHttps = new HttpsAgent({ keepAlive: true, lookup: guarded });
  const permissiveHttp = new HttpAgent({ keepAlive: true });
  const permissiveHttps = new HttpsAgent({ keepAlive: true });
  const agents = [protectedHttp, protectedHttps, permissiveHttp, permissiveHttps];
  const protectedPool = { http: protectedHttp, https: protectedHttps };
  const permissivePool = { http: permissiveHttp, https: permissiveHttps };
  const fetchSource: ImageSourceFetcher = (target, signal, allowLocal) => {
    // Fetch refuses URL credentials; node:http would otherwise turn them into Authorization.
    if (target.username !== '' || target.password !== '') {
      return Promise.reject(new TypeError('image source URLs cannot contain credentials'));
    }
    const hostname = target.hostname.replaceAll(/^\[|\]$/gu, '');
    if (
      !allowLocal &&
      isLocalAddress(isIP(hostname) === IPV6_FAMILY ? `[${hostname}]` : hostname)
    ) {
      return Promise.reject(new ImageDestinationError());
    }
    return new Promise((resolve, reject) => {
      const secure = target.protocol === 'https:';
      const request = secure ? httpsRequest : httpRequest;
      const pool = allowLocal ? permissivePool : protectedPool;
      const agent = secure ? pool.https : pool.http;
      const pending = request(
        target,
        {
          agent,
          signal,
          headers: {
            accept: '*/*',
            'accept-language': '*',
            'sec-fetch-mode': 'cors',
            'user-agent': 'node',
            'accept-encoding': 'br, gzip, deflate, zstd',
          },
        },
        (response) => {
          try {
            const headers = new Headers();
            for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
              headers.append(
                response.rawHeaders[index] ?? '',
                response.rawHeaders[index + 1] ?? '',
              );
            }
            const status = response.statusCode ?? HTTP_BAD_GATEWAY;
            const body = BODYLESS_STATUSES.has(status)
              ? null
              : Readable.toWeb(decodedBody(response));
            if (body === null) response.resume();
            resolve(
              new Response(body as ReadableStream<Uint8Array> | null, {
                status,
                statusText: response.statusMessage ?? '',
                headers,
              }),
            );
          } catch (error) {
            response.destroy();
            reject(failure(error));
          }
        },
      );
      pending.once('error', (error) => {
        reject(failure(signal.aborted ? signal.reason : error));
      });
      pending.end();
    });
  };
  return {
    fetch: fetchSource,
    close: () => {
      for (const agent of agents) agent.destroy();
    },
  };
}

// Constructed only on the first image request; importing the native Function performs no I/O.
const transport: { current?: ImageSourceTransport } = {};
export const fetchImageSource: ImageSourceFetcher = (target, signal, allowLocal) => {
  transport.current ??= createImageSourceTransport();
  return transport.current.fetch(target, signal, allowLocal);
};
