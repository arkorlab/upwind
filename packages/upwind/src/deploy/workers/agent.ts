import { toHex } from '@stayingupwind/core/util';
import type { DeployCache } from '@stayingupwind/deploy/deploy';
import {
  type RetireScopeInput,
  type RetireScopeResult,
  retireScopeInputSchema,
  seedEntriesInputSchema,
  seedScopeInputSchema,
} from '@stayingupwind/host/cache';

import {
  AGENT_KEY_MIN_LENGTH,
  AGENT_PATHS,
  DESTROY_MODE,
  METADATA_HEADER,
  MISSING_BATCH,
  OWNER_KEY,
} from './protocol.ts';

/**
 * What deploys to the account, on the account's side: the edge's namespace and the bucket, read and
 * written as a deploy reads and writes them, and the cache authority's control entrypoint, called as
 * a deploy calls it — all of which only a Worker bound to them can reach, which is why there is one.
 *
 * It is reachable on `workers.dev`, so what it will do is held to what a deploy needs, and nothing
 * it does can change what is served:
 *
 * - **A key, and only while a deploy runs.** Every request carries the key the deploy set as this
 *   Worker's secret (`AGENT_KEY`), compared by digest so the time a comparison takes says nothing
 *   of it; a deploy sets a fresh one when it starts and a discarded one when it ends, so between
 *   deploys nobody holds a key that works.
 * - **Only the keys a deployment writes**, and of each kind only what it can be: an artifact, a
 *   manifest or a blob is stored under its own digest, which is checked, so a write can only ever
 *   put the bytes the name says; a build's bundle is written once, by a write the bucket refuses
 *   where one is already there. No delivery policy is written: a deployment's pointer carries its
 *   own.
 * - **Nothing taken away**, except by a deploy destroying the project (`AGENT_MODE`), which uploads
 *   the agent again to say so.
 *
 * Content is all a leaked key could add, under names nothing serves until a deployment's manifest
 * names them — and naming them is the edge's pointer, which only the API token changes.
 */

interface CacheControl extends DeployCache {
  retireScope(input: RetireScopeInput): Promise<RetireScopeResult>;
}

interface AgentEnv {
  readonly AGENT_KEY?: string;
  readonly AGENT_MODE?: string;
  readonly EDGE_STATE: KVNamespace;
  readonly ARTIFACTS: R2Bucket;
  readonly CACHE_CONTROL: CacheControl;
}

const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_CONFLICT = 409;
const HTTP_LENGTH_REQUIRED = 411;
const HTTP_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE = 422;
const HTTP_UNAVAILABLE = 503;

/**
 * The most a write is read into memory for: what a KV value may be, 25 MiB. A blob is not read at
 * all, but streamed to the bucket, which checks its digest itself: several large ones at once would
 * otherwise be more than a Worker's memory.
 */
const MAX_BUFFERED_BYTES = 26_214_400;
/** How R2 ends the message of a write whose bytes are not the SHA-256 it was given. */
const R2_BAD_DIGEST = '(10037)';

/** What the edge's namespace holds of a deployment: its manifest and its placed shells. */
const KV_KEY = /^(?:manifest:[\da-f]{64}|art:[\da-f]{64})$/u;
/** What the bucket holds of one: blobs, artifacts and manifests by digest, and each build's bundle. */
const BLOB_KEY =
  /^(?:blobs\/[\da-f]{64}|artifacts\/[\da-f]{64}|manifests\/[\da-f]{64}\.json|deployments\/[a-z][\da-z-]{1,23}\/dpl_[1-9A-HJ-NP-Za-km-z]{21}\/bundle\.json)$/u;
/** The digest a content-addressed key names; nothing for a key that names none. */
const DIGEST = /(?:^manifest:|^art:|^blobs\/|^artifacts\/|^manifests\/)([\da-f]{64})(?:\.json)?$/u;

/** What is asked of the cache authority. */
const CACHE_PATHS: ReadonlySet<string> = new Set([
  AGENT_PATHS.retireScope,
  AGENT_PATHS.seedEntries,
  AGENT_PATHS.seedScope,
]);

/** How many objects one purge deletes. */
const PURGE_BATCH = 1000;

const encoder = new TextEncoder();
const BEARER = 'Bearer ';

function empty(status: number): Response {
  return new Response(null, { status });
}

function said(status: number, message: string): Response {
  return new Response(message, { status });
}

async function sha256Of(bytes: ArrayBuffer | ArrayBufferView): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/**
 * Why a request may not be answered, or nothing where it carries the key the agent holds. The two
 * are compared by their digests, which takes as long whatever either holds: how long a comparison
 * of the digests took says nothing of the key.
 */
async function refusal(request: Request, env: AgentEnv): Promise<Response | undefined> {
  const key = env.AGENT_KEY;
  if (key === undefined || key.length < AGENT_KEY_MIN_LENGTH) {
    // No key, or one too short to be one a deploy set: nothing is answered at all.
    return said(HTTP_UNAVAILABLE, 'the agent holds no key');
  }
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith(BEARER) ? header.slice(BEARER.length) : '';
  const [givenDigest, heldDigest] = await Promise.all([
    sha256Of(encoder.encode(given)),
    sha256Of(encoder.encode(key)),
  ]);
  return givenDigest === heldDigest ? undefined : empty(HTTP_UNAUTHORIZED);
}

function metadataOf(request: Request): unknown {
  const raw = request.headers.get(METADATA_HEADER);
  return raw === null ? undefined : JSON.parse(decodeURIComponent(raw));
}

/** An object's custom metadata, which holds strings only. */
function stringsOf(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** The length a request says its body has, or nothing where it says none a write can rely on. */
function declaredLength(request: Request): number | undefined {
  const header = request.headers.get('content-length');
  const length = header === null ? NaN : Number(header);
  return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
}

/** Why a body is not one to read into memory, or nothing where it is. */
function unbuffered(request: Request): Response | undefined {
  const length = declaredLength(request);
  if (length === undefined) {
    return empty(HTTP_LENGTH_REQUIRED);
  }
  return length > MAX_BUFFERED_BYTES
    ? said(HTTP_TOO_LARGE, `at most ${MAX_BUFFERED_BYTES} bytes are taken in one write`)
    : undefined;
}

/** The digest a content-addressed key names. */
function digestOf(key: string): string | undefined {
  return DIGEST.exec(key)?.[1];
}

function httpMetadataOf(request: Request): Pick<R2PutOptions, 'customMetadata' | 'httpMetadata'> {
  const contentType = request.headers.get('content-type');
  const customMetadata = stringsOf(metadataOf(request));
  return {
    ...(contentType !== null && { httpMetadata: { contentType } }),
    ...(customMetadata !== undefined && { customMetadata }),
  };
}

/** Every key the namespace takes names its own digest, so a value is written once and checked. */
async function kv(request: Request, env: AgentEnv, key: string): Promise<Response> {
  if (request.method === 'GET') {
    const value = await env.EDGE_STATE.get(key, 'arrayBuffer');
    return value === null ? empty(HTTP_NOT_FOUND) : new Response(value);
  }
  if (request.method !== 'PUT') {
    return empty(HTTP_METHOD_NOT_ALLOWED);
  }
  const refused = unbuffered(request);
  if (refused !== undefined) {
    return refused;
  }
  // What a digest names is the same bytes whoever wrote it.
  const held = await env.EDGE_STATE.get(key, 'stream');
  if (held !== null) {
    await held.cancel();
    await request.body?.cancel();
    return empty(HTTP_NO_CONTENT);
  }
  const bytes = await request.arrayBuffer();
  if ((await sha256Of(bytes)) !== digestOf(key)) {
    return said(HTTP_UNPROCESSABLE, `the bytes are not what ${key} names`);
  }
  const metadata = metadataOf(request);
  await env.EDGE_STATE.put(key, bytes, metadata === undefined ? {} : { metadata });
  return empty(HTTP_NO_CONTENT);
}

/**
 * A blob under its own digest, streamed to the bucket with the digest for it to check: what
 * arrives is never held here whole.
 */
async function putAddressed(
  request: Request,
  env: AgentEnv,
  key: string,
  digest: string,
): Promise<Response> {
  if ((await env.ARTIFACTS.head(key)) !== null) {
    // What a digest names is the same bytes whoever wrote it.
    await request.body?.cancel();
    return empty(HTTP_NO_CONTENT);
  }
  // A stream the bucket takes is one of a known length.
  if (declaredLength(request) === undefined) {
    return empty(HTTP_LENGTH_REQUIRED);
  }
  try {
    await env.ARTIFACTS.put(key, request.body ?? new Uint8Array(), {
      sha256: digest,
      ...httpMetadataOf(request),
    });
  } catch (error) {
    if (error instanceof Error && error.message.endsWith(R2_BAD_DIGEST)) {
      return said(HTTP_UNPROCESSABLE, `the bytes are not what ${key} names`);
    }
    throw error;
  }
  return empty(HTTP_NO_CONTENT);
}

/**
 * A build's bundle, written where none is, in one step the bucket refuses where one is already
 * there: two writes of other bytes cannot both land. The same bytes again are the same write.
 */
async function putOnce(request: Request, env: AgentEnv, key: string): Promise<Response> {
  const refused = unbuffered(request);
  if (refused !== undefined) {
    return refused;
  }
  const bytes = await request.arrayBuffer();
  const sha256 = await sha256Of(bytes);
  const written = await env.ARTIFACTS.put(key, bytes, {
    sha256,
    onlyIf: { etagDoesNotMatch: '*' },
    ...httpMetadataOf(request),
  });
  if (written !== null) {
    return empty(HTTP_NO_CONTENT);
  }
  const held = (await env.ARTIFACTS.head(key))?.checksums.sha256;
  return held !== undefined && toHex(new Uint8Array(held)) === sha256
    ? empty(HTTP_NO_CONTENT)
    : said(HTTP_CONFLICT, `${key} holds other bytes`);
}

async function blob(request: Request, env: AgentEnv, key: string): Promise<Response> {
  if (request.method === 'GET') {
    const object = await env.ARTIFACTS.get(key);
    return object === null ? empty(HTTP_NOT_FOUND) : new Response(object.body);
  }
  if (request.method !== 'PUT') {
    return empty(HTTP_METHOD_NOT_ALLOWED);
  }
  const digest = digestOf(key);
  return digest === undefined
    ? putOnce(request, env, key)
    : putAddressed(request, env, key, digest);
}

/** The keys a `missing` request asks about: at most a batch of them, each one the bucket takes. */
function askedKeys(body: unknown): readonly string[] | undefined {
  const keys: unknown =
    typeof body === 'object' && body !== null ? Reflect.get(body, 'keys') : undefined;
  if (!Array.isArray(keys) || keys.length > MISSING_BATCH) {
    return undefined;
  }
  const asked: string[] = [];
  for (const key of keys) {
    if (typeof key !== 'string' || !BLOB_KEY.test(key)) {
      return undefined;
    }
    asked.push(key);
  }
  return asked;
}

/** Which of the keys the bucket does not hold. */
async function missing(request: Request, env: AgentEnv): Promise<Response> {
  const keys = askedKeys(await request.json());
  if (keys === undefined) {
    return said(HTTP_UNPROCESSABLE, `expected { keys }, at most ${MISSING_BATCH} of the bucket's`);
  }
  const asked = await Promise.all(
    keys.map(async (key) => ({ key, held: (await env.ARTIFACTS.head(key)) !== null })),
  );
  return Response.json({ missing: asked.filter((one) => !one.held).map((one) => one.key) });
}

async function cache(request: Request, env: AgentEnv, pathname: string): Promise<Response> {
  const input: unknown = await request.json();
  if (pathname === AGENT_PATHS.seedScope) {
    return Response.json(await env.CACHE_CONTROL.seedScope(seedScopeInputSchema.parse(input)));
  }
  if (pathname === AGENT_PATHS.seedEntries) {
    return Response.json(await env.CACHE_CONTROL.seedEntries(seedEntriesInputSchema.parse(input)));
  }
  return Response.json(await env.CACHE_CONTROL.retireScope(retireScopeInputSchema.parse(input)));
}

/**
 * A batch of the bucket deleted, for a project being destroyed: all but the owner mark, which the
 * destroy deletes last, itself, so that one stopped before it can be run again.
 */
async function purge(env: AgentEnv): Promise<Response> {
  if (env.AGENT_MODE !== DESTROY_MODE) {
    return said(HTTP_FORBIDDEN, 'the agent deletes nothing outside a project being destroyed');
  }
  const listed = await env.ARTIFACTS.list({ limit: PURGE_BATCH });
  const keys = listed.objects.map((object) => object.key).filter((key) => key !== OWNER_KEY);
  if (keys.length > 0) {
    await env.ARTIFACTS.delete(keys);
  }
  return Response.json({ deleted: keys.length, more: listed.truncated });
}

async function answer(request: Request, env: AgentEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === AGENT_PATHS.health) {
    return empty(HTTP_NO_CONTENT);
  }
  if (pathname.startsWith(AGENT_PATHS.kv)) {
    const key = decodeURIComponent(pathname.slice(AGENT_PATHS.kv.length));
    return KV_KEY.test(key)
      ? kv(request, env, key)
      : said(HTTP_FORBIDDEN, `${key} is not a deployment's`);
  }
  if (pathname.startsWith(AGENT_PATHS.blob)) {
    const key = decodeURIComponent(pathname.slice(AGENT_PATHS.blob.length));
    return BLOB_KEY.test(key)
      ? blob(request, env, key)
      : said(HTTP_FORBIDDEN, `${key} is not a deployment's`);
  }
  if (request.method !== 'POST') {
    return empty(request.method === 'GET' ? HTTP_NOT_FOUND : HTTP_METHOD_NOT_ALLOWED);
  }
  if (pathname === AGENT_PATHS.missing) {
    return missing(request, env);
  }
  if (CACHE_PATHS.has(pathname)) {
    return cache(request, env, pathname);
  }
  return pathname === AGENT_PATHS.purge ? purge(env) : empty(HTTP_NOT_FOUND);
}

export default {
  fetch: async (request, env): Promise<Response> =>
    (await refusal(request, env)) ?? answer(request, env),
} satisfies ExportedHandler<AgentEnv>;
