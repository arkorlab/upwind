import type { Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { StaticFile } from '@stayingupwind/core/bundle';
import {
  type ByteRange,
  clientHolds,
  GATED_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  keptByNobody,
  preconditionFails,
  requestedRange,
  REVALIDATE_CACHE_CONTROL,
  RSC_HEADER,
  RSC_VARY,
} from '@stayingupwind/core/request';

import type { RoutedInput } from '../serve.ts';
import type { Store } from '../store.ts';

/**
 * A file the build shipped, answered from disk as the edge answers it from storage
 * (`edge/src/handlers/static-file.ts`): there is no edge in front of the native server, so what the
 * edge says of a file to its client is said here — its entity tag and length, whether it takes a
 * range, how it is held, what it varies on — and the requests it judges, a precondition, a validator
 * the client holds, a range, are judged here the same way and with the same functions
 * (`@stayingupwind/core/request`).
 *
 * What routing set on the path, a rule of `next.config` or the middleware, is laid over this answer
 * after it is made (`withRoutingHeaders`), as the application's router lays it: a `Cache-Control`
 * the middleware wrote stands over the one a middleware's run makes here, as the edge lets it.
 */

const DIGEST = /^[a-f\d]{64}$/u;
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_RESET_CONTENT = 205;
const HTTP_PARTIAL_CONTENT = 206;
const HTTP_NOT_MODIFIED = 304;
const HTTP_PRECONDITION_FAILED = 412;
const HTTP_RANGE_NOT_SATISFIABLE = 416;
const BODYLESS = new Set([HTTP_NO_CONTENT, HTTP_NOT_MODIFIED, HTTP_RESET_CONTENT]);
const STREAM_BUFFER_KIB = 64;
const KIB = 1024;
const STREAM_BUFFER_BYTES = STREAM_BUFFER_KIB * KIB;
const CONTENT_LENGTH = 'content-length';
const CONTENT_RANGE = 'content-range';

function requireMatchingFile(info: Stats, file: StaticFile): void {
  if (!info.isFile() || info.size !== file.blob.byteLength) {
    throw new Error('upwind: native static blob differs from its manifest');
  }
}

function etagOf(file: StaticFile): string {
  return `"${file.blob.sha256}"`;
}

/**
 * Whether the file is what the request asked for, the only answer a validator or a range is judged
 * against: an error document (`404.html` under 404) answers a request for something else, and is
 * sent whole under its status (RFC 9110 §13.2.1, §14.2), as the edge sends it.
 */
function answersAsItself(status: number): boolean {
  return status === HTTP_OK;
}

/**
 * The file's answer, as the edge gives it (`fileHeaders`): its type, length and entity tag — its
 * content's hash — whether a range of it may be asked, and how it is held: for a year where the build
 * marked it immutable, revalidated at every use where it did not, and by the visitor alone where a
 * middleware had a say on the request, which may have let it through for this visitor only. A router
 * asking for React Server Components and answered with the file is told the answer varies on what it
 * sent, as Next.js marks it (`setVaryHeader`).
 */
function fileHeaders(input: RoutedInput, file: StaticFile, status: number): Headers {
  const holding = file.immutable ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
  const headers = new Headers({
    'content-type': file.blob.contentType,
    [CONTENT_LENGTH]: String(file.blob.byteLength),
    'accept-ranges': answersAsItself(status) ? 'bytes' : 'none',
    etag: etagOf(file),
    'cache-control': input.middlewareRan === true ? GATED_CACHE_CONTROL : holding,
  });
  if (input.request.headers.get(RSC_HEADER) === '1') {
    headers.append('vary', RSC_VARY);
  }
  return headers;
}

/**
 * The date the answer is judged by, for `If-Modified-Since` and `If-Unmodified-Since`: none. The
 * build keeps no date of a file's own, and the edge sends none; one a rule or the middleware sets is
 * laid on after this answer is made, so a request asking by date is answered as one that asked
 * nothing, as the edge answers it for a file no rule dated.
 */
function noDate(): null {
  return null;
}

/**
 * Whether the build's blob is on disk as the manifest describes it: an answer made from the manifest
 * alone — a `HEAD`, a 304, a 412, a 416 — still names a file the server could send.
 */
async function present(location: string, file: StaticFile): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only a selected build-owned digest names this file.
    requireMatchingFile(await stat(location), file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * What the manifest alone answers, as the edge answers it (`metadataResponse`): a precondition the
 * file fails, 412, to any read and with no body; an entity the client already holds, 304; and a
 * `HEAD`, the file's headers. Each without a length of a body it does not carry but the `HEAD`'s, and
 * a refusal kept by nobody, since a cache keyed on the URL alone would hand it to every request for
 * the file. `undefined` where the body is to be read.
 */
function fromManifest(input: RoutedInput, file: StaticFile, status: number): Response | undefined {
  const { request } = input;
  const headers = fileHeaders(input, file, status);
  const tag = etagOf(file);
  if (answersAsItself(status) && preconditionFails(request, tag, noDate)) {
    headers.delete(CONTENT_LENGTH);
    keptByNobody(headers);
    return new Response(null, { status: HTTP_PRECONDITION_FAILED, headers });
  }
  if (answersAsItself(status) && clientHolds(request, tag, noDate)) {
    headers.delete(CONTENT_LENGTH);
    return new Response(null, { status: HTTP_NOT_MODIFIED, headers });
  }
  if (request.method === 'HEAD' || BODYLESS.has(status)) {
    return new Response(null, { status, headers });
  }
  return undefined;
}

/**
 * No byte of the file satisfies the range asked, 416, as the edge refuses it (`rangeNotSatisfiable`):
 * the length it could have asked within, and kept by nobody, the file's lifetime not being the
 * refusal's.
 */
function rangeNotSatisfiable(input: RoutedInput, file: StaticFile, status: number): Response {
  const headers = fileHeaders(input, file, status);
  headers.delete(CONTENT_LENGTH);
  headers.set(CONTENT_RANGE, `bytes */${String(file.blob.byteLength)}`);
  keptByNobody(headers);
  return new Response(null, { status: HTTP_RANGE_NOT_SATISFIABLE, headers });
}

/** What is sent of a file: under which status, and the one range of it asked, if one was. */
interface Sent {
  readonly status: number;
  readonly range: ByteRange | undefined;
}

/** The file's bytes, or the one range of them asked, under the file's headers. */
function bodyResponse(
  body: ReadableStream<Uint8Array>,
  input: RoutedInput,
  file: StaticFile,
  { status, range }: Sent,
): Response {
  const headers = fileHeaders(input, file, status);
  if (range === undefined) {
    return new Response(body, { status, headers });
  }
  headers.set(
    CONTENT_RANGE,
    `bytes ${String(range.start)}-${String(range.end)}/${String(file.blob.byteLength)}`,
  );
  headers.set(CONTENT_LENGTH, String(range.end - range.start + 1));
  return new Response(body, { status: HTTP_PARTIAL_CONTENT, headers });
}

/**
 * Called only after the shared router and middleware selected this build-owned StaticFile.
 * A request pathname never becomes a filesystem path. The body stays on disk until consumed,
 * and cancelling its Web stream destroys the Node stream and closes the file descriptor; a range
 * reads the bytes it names and no others.
 */
export async function staticFileResponse(
  input: RoutedInput,
  _store: Store,
  file: StaticFile,
  status: number,
): Promise<Response | undefined> {
  if (!DIGEST.test(file.blob.sha256)) throw new Error('upwind: invalid native bundle blob digest');
  input.request.signal.throwIfAborted();
  const root =
    typeof __ARKOR_BUNDLE_ROOT__ === 'undefined' ? import.meta.dirname : __ARKOR_BUNDLE_ROOT__;
  const location = path.join(root, 'blobs', file.blob.sha256);
  const metadata = fromManifest(input, file, status);
  if (metadata !== undefined) {
    return (await present(location, file)) ? metadata : undefined;
  }
  const range: ByteRange | null | undefined = answersAsItself(status)
    ? requestedRange(input.request, etagOf(file), file.blob.byteLength)
    : undefined;
  if (range === null) {
    return (await present(location, file)) ? rangeNotSatisfiable(input, file, status) : undefined;
  }
  let handle;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only a selected build-owned digest names this file.
    handle = await open(location, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    requireMatchingFile(info, file);
    input.request.signal.throwIfAborted();
    const stream = handle.createReadStream({
      autoClose: true,
      signal: input.request.signal,
      ...(range !== undefined && { start: range.start, end: range.end }),
    });
    try {
      const body = Readable.toWeb(stream, {
        strategy: {
          highWaterMark: STREAM_BUFFER_BYTES,
          size: (chunk: Uint8Array) => chunk.byteLength,
        },
      }) as ReadableStream<Uint8Array>;
      return bodyResponse(body, input, file, { status, range });
    } catch (error) {
      stream.destroy();
      throw error;
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
}
