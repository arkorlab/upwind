import type { Stats } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { headerRulesOf, type StaticFile } from '@stayingupwind/core/bundle';
import { type ConfiguredHeaders, headerRulesFor } from '@stayingupwind/core/manifest';
import {
  type ByteRange,
  clientHolds,
  GATED_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  keptByNobody,
  preconditionFails,
  removeSharedCacheOverrides,
  requestedRange,
  REVALIDATE_CACHE_CONTROL,
  RSC_HEADER,
  RSC_VARY,
  varyOn,
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
 * after it is made (`withRoutingHeaders`), as the application's router lays it. The edge lays them
 * first and then says what it says of a file over them: no rule names the bytes on the wire, no
 * middleware their type or coding, and how the answer is held is the edge's last word. So the answer
 * is judged here by what routing will lay on it — the middleware's `ETag`, a rule's or the
 * middleware's `Last-Modified` — and what it decided is said again once routing has spoken
 * (`afterRouting`).
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
const CONTENT_TYPE = 'content-type';
const CONTENT_ENCODING = 'content-encoding';
const CACHE_CONTROL = 'cache-control';
/** What describes the bytes on the wire, which no rule may say otherwise about (the edge's own). */
const ENTITY_HEADERS: readonly string[] = ['accept-ranges', CONTENT_LENGTH, CONTENT_RANGE, 'etag'];

/**
 * What the edge sets `cache-control` to over the file's own and a rule's (`cacheControlFor`):
 * `unshared` where that is its word that no shared cache is to keep the answer, rather than the
 * middleware's own.
 */
interface CacheControlOverride {
  readonly value: string;
  readonly unshared: boolean;
}

const UNSHARED_GATED: CacheControlOverride = { value: GATED_CACHE_CONTROL, unshared: true };

/**
 * What a file answer of this module's said of itself, for `afterRouting` to say again over what
 * routing laid on it: its entity headers as it carries them, its type, how it is held where the
 * edge has the last word on that, whether it is a refusal, and whether a router asked for it.
 */
interface FileAnswer {
  readonly entity: readonly (readonly [string, string])[];
  readonly contentType: string;
  readonly coding: string | undefined;
  readonly cacheControl: CacheControlOverride | undefined;
  readonly refusal: boolean;
  readonly rsc: boolean;
}

/**
 * The file answers made, by the routed input they were made for: the one `answerResolved` hands both
 * `serveResolved` and `afterRouting`. Kept by the input itself rather than said in a header, which
 * a rule of `next.config` could set on any answer.
 */
const fileAnswers = new WeakMap<RoutedInput, FileAnswer>();

/** The build's header rules, judged once for the build (`headerRulesOf`). */
const ruleSets = new WeakMap<Store['manifest'], Parameters<typeof headerRulesFor>[0]>();

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

/** The build's header rules as the edge judges them (`headerRulesOf`), once for the build. */
function rulesOf(store: Store): Parameters<typeof headerRulesFor>[0] {
  const bundle = store.manifest;
  const held = ruleSets.get(bundle);
  if (held !== undefined) return held;
  const rules = { headerRules: headerRulesOf(bundle), routerReferences: bundle.routerReferences };
  ruleSets.set(bundle, rules);
  return rules;
}

/**
 * What `next.config`'s header rules set on the request, as the edge judges them for a file
 * (`configured`): against the request as routing judged it, before a middleware changed it.
 */
function configuredFor(input: RoutedInput, store: Store): ConfiguredHeaders {
  const { request } = input;
  return headerRulesFor(
    rulesOf(store),
    new URL(request.url),
    input.askedHeaders ?? request.headers,
  );
}

/** What the rules set `name` to, whatever case a rule spelled it in. */
function configuredValue(configured: ConfiguredHeaders, name: string): string | undefined {
  for (const [field, value] of Object.entries(configured.headers)) {
    if (field.toLowerCase() === name) return value;
  }
  return undefined;
}

/** The request's file, as the edge judges it: by what the rules and the middleware lay on it. */
interface Judged {
  readonly input: RoutedInput;
  readonly file: StaticFile;
  /** The status it is answered under (`underRewriteStatus`). */
  readonly status: number;
  readonly configured: ConfiguredHeaders;
}

/**
 * The entity tag the answer carries (`entityTagOf`): the file's own, or one the middleware set in its
 * place — which is what Next.js serves the file under as well, since `send` keeps an `ETag` already
 * on the response. A validator is judged against this one; a client can only hold the tag a response
 * gave it. A rule's is not: no rule names the bytes on the wire.
 */
function entityTagOf({ input, file }: Judged): string {
  return input.middlewareHeaders?.get('etag') ?? etagOf(file);
}

/**
 * The `Last-Modified` the answer carries (`lastModifiedOf`): one the middleware or a rule gave it —
 * the middleware's laid over a rule's, as routing lays them — the build keeping no date of a file's
 * own, and the edge sending none.
 */
function lastModifiedOf({ input, configured }: Judged): string | null {
  return (
    input.middlewareHeaders?.get('last-modified') ??
    configuredValue(configured, 'last-modified') ??
    null
  );
}

/**
 * What the edge sets `cache-control` to over the file's own and a rule's (`cacheControlFor`): where a
 * middleware had a say on the request, what it wrote itself, unless a rule the request selected or a
 * cookie on the answer makes the answer one visitor's — then held by the visitor alone, revalidated;
 * where a rule the request selected (`has`, `missing`) applied, the same; and otherwise nothing, the
 * file's own lifetime or a rule's standing.
 */
function cacheControlFor({ input, configured }: Judged): CacheControlOverride | undefined {
  if (input.middlewareRan === true) {
    const cookie =
      configuredValue(configured, 'set-cookie') !== undefined ||
      input.middlewareHeaders?.has('set-cookie') === true;
    const own =
      cookie || configured.conditioned
        ? undefined
        : (input.middlewareHeaders?.get(CACHE_CONTROL) ?? undefined);
    return own === undefined ? UNSHARED_GATED : { value: own, unshared: false };
  }
  return configured.conditioned ? UNSHARED_GATED : undefined;
}

/**
 * The file's answer, as the edge gives it (`fileHeaders`): its type — a rule's, where one sets it, but
 * never the middleware's — its length and entity tag, whether a range of it may be asked, and how it
 * is held: for a year where the build marked it immutable, revalidated at every use where it did not,
 * a rule's lifetime over either, and what the edge says over all of them (`cacheControlFor`). A router
 * asking for React Server Components and answered with the file is told the answer varies on what it
 * sent, as Next.js marks it (`setVaryHeader`).
 */
function fileHeaders(judged: Judged): Headers {
  const { input, file, status, configured } = judged;
  const holding = file.immutable ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
  const headers = new Headers({
    [CONTENT_TYPE]: configuredValue(configured, CONTENT_TYPE) ?? file.blob.contentType,
    [CONTENT_LENGTH]: String(file.blob.byteLength),
    'accept-ranges': answersAsItself(status) ? 'bytes' : 'none',
    etag: entityTagOf(judged),
    [CACHE_CONTROL]:
      cacheControlFor(judged)?.value ?? configuredValue(configured, CACHE_CONTROL) ?? holding,
  });
  if (input.request.headers.get(RSC_HEADER) === '1') {
    headers.append('vary', RSC_VARY);
  }
  return headers;
}

/** An answer from the manifest alone, before the file is known to be on disk to answer it. */
interface Unmade {
  readonly response: Response;
  /** A refusal (412, 416): kept by nobody whatever routing lays on it. */
  readonly refusal: boolean;
}

/**
 * The answer, made: what it says of itself kept for `afterRouting`, which says it again over what
 * routing lays on it. Only an answer given is kept: the input may yet be answered otherwise.
 */
function made(judged: Judged, { response, refusal }: Unmade): Response {
  const { headers } = response;
  fileAnswers.set(judged.input, {
    entity: ENTITY_HEADERS.flatMap((name) => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value] as const];
    }),
    contentType: headers.get(CONTENT_TYPE) ?? judged.file.blob.contentType,
    coding: configuredValue(judged.configured, CONTENT_ENCODING),
    cacheControl: cacheControlFor(judged),
    refusal,
    rsc: judged.input.request.headers.get(RSC_HEADER) === '1',
  });
  return response;
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
 * the file. Judged against the tag and date the answer carries once routing has laid on it what a
 * rule and the middleware set (`entityTagOf`, `lastModifiedOf`). `undefined` where the body is to be
 * read.
 */
function fromManifest(judged: Judged): Unmade | undefined {
  const { input, status } = judged;
  const { request } = input;
  const headers = fileHeaders(judged);
  const tag = entityTagOf(judged);
  const date = (): string | null => lastModifiedOf(judged);
  if (answersAsItself(status) && preconditionFails(request, tag, date)) {
    headers.delete(CONTENT_LENGTH);
    keptByNobody(headers);
    const response = new Response(null, { status: HTTP_PRECONDITION_FAILED, headers });
    return { response, refusal: true };
  }
  if (answersAsItself(status) && clientHolds(request, tag, date)) {
    headers.delete(CONTENT_LENGTH);
    return { response: new Response(null, { status: HTTP_NOT_MODIFIED, headers }), refusal: false };
  }
  if (BODYLESS.has(status)) {
    // A status that carries no body, as a rewrite may name one, says no length of one either: the
    // edge drops it too (`underRewriteStatus`), and a client would wait for the bytes it names.
    headers.delete(CONTENT_LENGTH);
    return { response: new Response(null, { status, headers }), refusal: false };
  }
  if (request.method === 'HEAD') {
    return { response: new Response(null, { status, headers }), refusal: false };
  }
  return undefined;
}

/**
 * No byte of the file satisfies the range asked, 416, as the edge refuses it (`rangeNotSatisfiable`):
 * the length it could have asked within, and kept by nobody, the file's lifetime not being the
 * refusal's.
 */
function rangeNotSatisfiable(judged: Judged): Unmade {
  const headers = fileHeaders(judged);
  headers.delete(CONTENT_LENGTH);
  headers.set(CONTENT_RANGE, `bytes */${String(judged.file.blob.byteLength)}`);
  keptByNobody(headers);
  return {
    response: new Response(null, { status: HTTP_RANGE_NOT_SATISFIABLE, headers }),
    refusal: true,
  };
}

/** The file's bytes, or the one range of them asked, under the file's headers. */
function bodyResponse(
  body: ReadableStream<Uint8Array>,
  judged: Judged,
  range: ByteRange | undefined,
): Response {
  const headers = fileHeaders(judged);
  if (range === undefined) {
    return made(judged, {
      response: new Response(body, { status: judged.status, headers }),
      refusal: false,
    });
  }
  headers.set(
    CONTENT_RANGE,
    `bytes ${String(range.start)}-${String(range.end)}/${String(judged.file.blob.byteLength)}`,
  );
  headers.set(CONTENT_LENGTH, String(range.end - range.start + 1));
  return made(judged, {
    response: new Response(body, { status: HTTP_PARTIAL_CONTENT, headers }),
    refusal: false,
  });
}

/**
 * The status the file is answered under: the one a rewrite named, where it names one for an answer
 * of the file's own, as the edge judges it (`underRewriteStatus`) — a 404 a middleware rewrote to
 * the file is not answered with a 304 or a range of it — and `withRewriteStatus` then leaves the
 * answer as it is.
 */
function underRewriteStatus(input: RoutedInput, fileStatus: number): number {
  return fileStatus === HTTP_OK && input.rewriteStatus !== undefined
    ? input.rewriteStatus
    : fileStatus;
}

/**
 * Called only after the shared router and middleware selected this build-owned StaticFile.
 * A request pathname never becomes a filesystem path. The body stays on disk until consumed,
 * and cancelling its Web stream destroys the Node stream and closes the file descriptor; a range
 * reads the bytes it names and no others.
 */
export async function staticFileResponse(
  input: RoutedInput,
  store: Store,
  file: StaticFile,
  fileStatus: number,
): Promise<Response | undefined> {
  if (!DIGEST.test(file.blob.sha256)) throw new Error('upwind: invalid native bundle blob digest');
  input.request.signal.throwIfAborted();
  const judged: Judged = {
    input,
    file,
    status: underRewriteStatus(input, fileStatus),
    configured: configuredFor(input, store),
  };
  const root =
    typeof __ARKOR_BUNDLE_ROOT__ === 'undefined' ? import.meta.dirname : __ARKOR_BUNDLE_ROOT__;
  const location = path.join(root, 'blobs', file.blob.sha256);
  const metadata = fromManifest(judged);
  if (metadata !== undefined) {
    return (await present(location, file)) ? made(judged, metadata) : undefined;
  }
  // An `If-Range` is judged against the tag the answer carries, as a precondition is.
  const range: ByteRange | null | undefined = answersAsItself(judged.status)
    ? requestedRange(input.request, entityTagOf(judged), file.blob.byteLength)
    : undefined;
  if (range === null) {
    return (await present(location, file)) ? made(judged, rangeNotSatisfiable(judged)) : undefined;
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
      return bodyResponse(body, judged, range);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * The routed answer once routing's headers and a rewrite's status are on it: where it is a file
 * answer of this module's, what the edge says of a file over what the application set, said again —
 * routing laid the rules' and the middleware's headers on it after it was made, which the edge lays
 * first (`applicationHeaders`):
 *
 * - the bytes on the wire are described by the answer, whatever a rule set (`ENTITY_HEADERS`): its
 *   entity tag the middleware's or the file's, its length, its range, whether it takes one;
 * - its type is a rule's or the file's, and its coding a rule's or none: the middleware sets
 *   neither on a file (`UNMERGEABLE_RESPONSE_HEADERS`);
 * - a router that asked for React Server Components is told the answer varies on what it sent;
 * - how it is held is the edge's last word where it has one (`cacheControlFor`), and the lifetimes a
 *   rule or the middleware gave shared caches go with it where it keeps the answer from them;
 * - a refusal is kept by nobody, a cache keyed on the URL alone otherwise handing it on.
 */
export function afterRouting(input: RoutedInput, response: Response): Response {
  const answer = fileAnswers.get(input);
  if (answer === undefined) {
    return response;
  }
  fileAnswers.delete(input);
  const { headers } = response;
  for (const name of ENTITY_HEADERS) {
    headers.delete(name);
  }
  for (const [name, value] of answer.entity) {
    headers.set(name, value);
  }
  headers.set(CONTENT_TYPE, answer.contentType);
  if (answer.coding === undefined) {
    headers.delete(CONTENT_ENCODING);
  } else {
    headers.set(CONTENT_ENCODING, answer.coding);
  }
  if (answer.rsc) {
    for (const name of RSC_VARY.split(',')) {
      varyOn(headers, name.trim());
    }
  }
  if (answer.cacheControl !== undefined) {
    headers.set(CACHE_CONTROL, answer.cacheControl.value);
    if (answer.cacheControl.unshared) {
      removeSharedCacheOverrides(headers);
    }
  }
  if (answer.refusal) {
    keptByNobody(headers);
  }
  return response;
}
