import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '@stayingupwind/core/artifact';
import { imageResponseHeaders, type ImagesConfig } from '@stayingupwind/core/images';

import type {
  ImageCacheInput,
  ImageCacheOpener,
  ImageCacheSlot,
  KeptImage,
} from '../image-cache.ts';
import { encoderAvailable, holdsImage } from './image-encoder.ts';

/**
 * The images the native target makes, kept on its disk, as the edge keeps the ones it optimizes in
 * the Cache API (`handlers/image.ts`, `handlers/image-cache.ts` in the edge) and `next start` keeps
 * its own (`server/image-optimizer.js`, `ImageOptimizerCache`).
 *
 * By the edge's rules: an image is kept under what it is made of and for — the configuration, by its
 * hash; whether there is an encoder to make it; the source, by its identity; the width, the quality
 * and the format asked (`cacheKey`, `imageSourceId`) — and looked up before its source is asked for
 * at all. It is kept for as long as a client is told it may keep it, at most 8 MiB of it, and not
 * where a middleware had a say on the request. A hit is answered as the image was when it was made,
 * under the headers the optimizer gives it, `x-nextjs-cache: HIT` (`fromCache`).
 *
 * Where the edge leaves the rest to Cloudflare's cache, as `next start` does it: one file an image,
 * in a directory of the images' own under the server's cache root, and as many bytes of them as
 * `images.maximumDiskCacheSize` allows — absent, half the disk free where they are kept — the ones
 * used longest ago let go first (`getOrInitDiskLRU`). An image past its lifetime is a miss and is let
 * go when it is read, and every hour the directory is looked over for the ones nobody read since.
 */

const KIB = 1024;
const MIB = KIB * KIB;
/** Images up to this are kept; a larger one goes out unkept, as the edge's (`CACHEABLE_RESULT_BYTES`). */
const CACHEABLE_RESULT_MIB = 8;
const CACHEABLE_RESULT_BYTES = CACHEABLE_RESULT_MIB * MIB;
/** Hex characters of the configuration's hash that tell one configuration from another; the edge's. */
const CONFIG_FINGERPRINT_LENGTH = 16;
/** Of the disk free where images are kept, the share kept where the application set no size. */
const DISK_SHARE_DIVISOR = 2;
const ENTRY_SUFFIX = '.img';
const PARTIAL_SUFFIX = '.tmp';
const ENTRY_VERSION = 1;
/** The length of an entry's header, before it: a big-endian 32-bit count of its bytes. */
const HEADER_LENGTH_BYTES = 4;
/** The most a header can be, read whole before anything of it is trusted. */
const MAX_HEADER_KIB = 64;
const MAX_HEADER_BYTES = MAX_HEADER_KIB * KIB;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const HOUR_MS = SECONDS_PER_HOUR * MS_PER_SECOND;
/** How often the directory is looked over for images past their lifetime. */
const SWEEP_INTERVAL_MS = HOUR_MS;
/** How long a write may have been left unfinished, by a server that stopped, before it is let go. */
const PARTIAL_GRACE_MS = HOUR_MS;
const HTTP_NOT_MODIFIED = 304;
/** What is said where the directory could not be looked over. */
const LOOK_FAILED = 'image cache could not be looked over';
/** What the edge's escaping leaves as it is in a part of a key (`imagePathPart`). */
const UNESCAPED_PART = /^[\w.~-]*$/u;

export interface ImageCacheOptions {
  /** Where images are kept: a directory of their own, which the deployments of a cache root share. */
  readonly directory: string;
  /** The most bytes kept, as `images.maximumDiskCacheSize` says it: `0` keeps none, absent half the free disk. */
  readonly maxBytes?: number | undefined;
}

/** What an entry says of the image after it, ahead of its bytes. */
interface EntryHeader {
  readonly v: number;
  readonly key: string;
  readonly contentType: string;
  readonly etag: string;
  readonly maxAge: number;
  readonly fallback: boolean;
  /** When it stops being kept: when it was kept, and its lifetime. */
  readonly expiresAt: number;
}

function warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: 'warn', msg: `next-runtime: ${message}`, ...fields }));
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sha256Of(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A part of a key as the edge spells one: an identifier as it is, anything else escaped. */
function partOf(value: string): string {
  // JSON first keeps every UTF-16 string, a lone surrogate included, which URI escaping refuses.
  return UNESCAPED_PART.test(value)
    ? value
    : encodeURIComponent(JSON.stringify(value).slice(1, -1));
}

const fingerprints = new WeakMap<ImagesConfig, string>();

/** The configuration by its hash: whatever of it changed, what was kept under the old one is not this one's. */
function fingerprintOf(images: ImagesConfig): string {
  let fingerprint = fingerprints.get(images);
  if (fingerprint === undefined) {
    fingerprint = sha256Of(canonicalJson(images)).slice(0, CONFIG_FINGERPRINT_LENGTH);
    fingerprints.set(images, fingerprint);
  }
  return fingerprint;
}

/**
 * The name of the site the request came in on, as the edge's `previewHost` is one: the host the
 * client asked for — which the native server forwards (`x-forwarded-host`) — else the request's own,
 * without the port it reached, since a server started again on another port answers the same site.
 */
function siteOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-host');
  if (forwarded === null) return new URL(request.url).hostname;
  try {
    return new URL(`http://${forwarded}`).hostname;
  } catch {
    // Not a host a URL takes: as it was given, for whatever answered it to answer again.
    return forwarded;
  }
}

/**
 * The source by its identity, as the edge names one (`imageSourceId`): a URL of the internet is
 * itself; a path of the application is this deployment's answer for it, on the site the request came
 * in on, as the source is asked for (`sourceRequest`).
 */
function sourceIdOf({ params, request, deploymentId }: ImageCacheInput): string {
  if (params.isAbsolute) {
    return `remote:${sha256Of(params.href)}`;
  }
  return `local:${partOf(deploymentId)}:${partOf(siteOf(request))}:${sha256Of(params.href)}`;
}

/** What an image is kept under (`cacheKey` in the edge's `handlers/image.ts`). */
export function imageKeyOf(input: ImageCacheInput): string {
  const { params, images } = input;
  const format = params.mimeType === '' ? 'source' : params.mimeType;
  // As the edge's `transformMode`: what was kept with no encoder to make it is the source as it is.
  const availability = encoderAvailable() ? 'transform' : 'original';
  return `${fingerprintOf(images)}/${availability}:${sourceIdOf(input)}/${String(params.width)}/${String(params.quality)}/${format}`;
}

function fileNameOf(key: string): string {
  return `${sha256Of(key)}${ENTRY_SUFFIX}`;
}

function headerOfText(text: string): EntryHeader | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const header = value as Record<string, unknown>;
  const valid =
    header['v'] === ENTRY_VERSION &&
    typeof header['key'] === 'string' &&
    typeof header['contentType'] === 'string' &&
    typeof header['etag'] === 'string' &&
    typeof header['maxAge'] === 'number' &&
    typeof header['fallback'] === 'boolean' &&
    typeof header['expiresAt'] === 'number';
  return valid ? (value as EntryHeader) : undefined;
}

/** An entry's header and the image after it, where the bytes are one, kept under `key`. */
function entryOf(
  bytes: Uint8Array,
  key: string,
): { readonly header: EntryHeader; readonly image: KeptImage } | undefined {
  if (bytes.byteLength < HEADER_LENGTH_BYTES) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0);
  const end = HEADER_LENGTH_BYTES + length;
  if (length > MAX_HEADER_BYTES || end > bytes.byteLength) return undefined;
  const header = headerOfText(new TextDecoder().decode(bytes.subarray(HEADER_LENGTH_BYTES, end)));
  // Another key's, whose name the hash shares: as good as none.
  if (header?.key !== key) return undefined;
  const { contentType, etag, maxAge, fallback } = header;
  return { header, image: { bytes: bytes.subarray(end), contentType, etag, maxAge, fallback } };
}

/** An entry's header alone, read off its file, without its image. */
async function headerOfFile(file: string): Promise<EntryHeader | undefined> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Listed in the server's own directory.
  await using handle = await open(file, 'r');
  const prefix = new Uint8Array(HEADER_LENGTH_BYTES);
  const { bytesRead } = await handle.read(prefix, 0, HEADER_LENGTH_BYTES, 0);
  if (bytesRead < HEADER_LENGTH_BYTES) return undefined;
  const length = new DataView(prefix.buffer).getUint32(0);
  if (length > MAX_HEADER_BYTES) return undefined;
  const text = new Uint8Array(length);
  const read = await handle.read(text, 0, length, HEADER_LENGTH_BYTES);
  return read.bytesRead < length ? undefined : headerOfText(new TextDecoder().decode(text));
}

/** Half the disk free where images are kept: what they may take where the application set nothing. */
async function diskShareOf(directory: string): Promise<number> {
  const { bavail, bsize } = await statfs(directory);
  return Math.floor((bavail * bsize) / DISK_SHARE_DIVISOR);
}

/** An image of the directory still to be kept, with its size and when it was written. */
interface Found {
  readonly name: string;
  readonly size: number;
  readonly written: number;
}

/** The images kept in one directory, and what of the disk they take, by when each was last used. */
class DiskImages {
  readonly #directory: string;
  readonly #maxBytes: number | undefined;
  /** Each image kept, by its file's name, with its size: the one used longest ago first. */
  readonly #entries = new Map<string, number>();
  #total = 0;
  #limit: number | undefined;
  #indexed: Promise<void> | undefined;
  #sweeper: NodeJS.Timeout | undefined;
  /**
   * The turn of whatever changes the index from what it reads of the directory — a look over it, a
   * write's count and what it lets go — taken one at a time (greptile): a look that read a file a
   * write has let go since would count it again, and let another go in its place.
   */
  #turn: Promise<void> = Promise.resolve();
  /** The images a read let go while a look over the directory was under way: not to be counted again. */
  #letGoDuringLook: Set<string> | undefined;
  /** Whether the index has been read off the directory: until then, a use is kept aside. */
  #indexReady = false;
  /**
   * The images used before the index was read off the directory, by when: the first look orders
   * each by the later of its use and its write (Codex, greptile). A server started again would
   * otherwise let go first an image read since, ahead of one nobody has asked for.
   */
  readonly #usedBeforeIndex = new Map<string, number>();

  constructor(directory: string, maxBytes: number | undefined) {
    this.#directory = directory;
    this.#maxBytes = maxBytes;
  }

  async #write(key: string, image: KeptImage): Promise<void> {
    await this.#index();
    const name = fileNameOf(key);
    const header: EntryHeader = {
      v: ENTRY_VERSION,
      key,
      contentType: image.contentType,
      etag: image.etag,
      maxAge: image.maxAge,
      fallback: image.fallback,
      expiresAt: Date.now() + image.maxAge * MS_PER_SECOND,
    };
    const text = new TextEncoder().encode(JSON.stringify(header));
    const length = new Uint8Array(HEADER_LENGTH_BYTES);
    new DataView(length.buffer).setUint32(0, text.byteLength);
    const bytes = Buffer.concat([length, text, image.bytes]);
    // Written whole beside it, then put in its place: a reader never sees half an image.
    const partial = path.join(
      this.#directory,
      `${name}.${String(process.pid)}.${randomUUID()}${PARTIAL_SUFFIX}`,
    );
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- A hash names the file, under the server's own directory.
      await writeFile(partial, bytes);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- As above.
      await rename(partial, path.join(this.#directory, name));
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    await this.#exclusive(async () => {
      this.#count(name, bytes.byteLength);
      await this.#evict();
    });
  }

  /** `work`, in its turn: after whatever else changes the index has had its own. */
  async #exclusive<T>(work: () => Promise<T>): Promise<T> {
    const before = this.#turn;
    const done = Promise.withResolvers<undefined>();
    this.#turn = done.promise;
    try {
      await before;
      return await work();
    } finally {
      done.resolve(undefined);
    }
  }

  /** `#write`, its failure said rather than thrown: what is kept is never what is answered. */
  async #written(key: string, image: KeptImage): Promise<void> {
    try {
      await this.#write(key, image);
    } catch (error) {
      warn('image cache write failed', { detail: detailOf(error) });
    }
  }

  /** The index, read off the directory once, and looked over every hour after. */
  #index(): Promise<void> {
    this.#indexed ??= this.#firstSweep();
    return this.#indexed;
  }

  async #firstSweep(): Promise<void> {
    await this.#sweep();
    this.#sweeper = setInterval(() => {
      // In its turn, as every look is: one that outlasts the hour is waited on by the next. It says
      // what it cannot do itself, and fails at nothing.
      void this.#sweep().catch((error: unknown) => {
        warn(LOOK_FAILED, { detail: detailOf(error) });
      });
    }, SWEEP_INTERVAL_MS);
    // Nothing of the server waits on it.
    this.#sweeper.unref();
  }

  /**
   * The directory looked over: images past their lifetime, and writes a stopped server left
   * unfinished, let go; the rest indexed by when they were written, the one written longest ago
   * first, where they are not indexed already. Never fails: what it cannot do is said.
   */
  async #sweep(): Promise<void> {
    await this.#exclusive(async () => {
      const letGo = new Set<string>();
      this.#letGoDuringLook = letGo;
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- The server's own directory.
        await mkdir(this.#directory, { recursive: true });
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- As above.
        const names = await readdir(this.#directory);
        const now = Date.now();
        const found: Found[] = [];
        for (const name of names) {
          const kept = await this.#lookedAt(name, now);
          if (kept !== undefined) found.push(kept);
        }
        const usedAt = ({ name, written }: Found): number =>
          Math.max(written, this.#usedBeforeIndex.get(name) ?? 0);
        found.sort((left, right) => usedAt(left) - usedAt(right));
        for (const { name, size } of found) {
          // What a read let go after the look found it is gone, whatever the look read of it.
          if (!this.#entries.has(name) && !letGo.has(name)) this.#count(name, size);
        }
        this.#indexReady = true;
        this.#usedBeforeIndex.clear();
        await this.#evict();
      } catch (error) {
        warn(LOOK_FAILED, { detail: detailOf(error) });
      } finally {
        this.#letGoDuringLook = undefined;
      }
    });
  }

  /** One file of the directory, looked at: an image still to be kept, or `undefined`. */
  async #lookedAt(name: string, now: number): Promise<Found | undefined> {
    try {
      return await this.#look(name, now);
    } catch (error) {
      // Gone in the meantime, as another server's look may have let it go.
      if (!missing(error)) warn('image cache entry unreadable', { detail: detailOf(error) });
      return undefined;
    }
  }

  async #look(name: string, now: number): Promise<Found | undefined> {
    const file = path.join(this.#directory, name);
    if (name.endsWith(PARTIAL_SUFFIX)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Listed in the server's own directory.
      const { mtimeMs } = await stat(file);
      if (now - mtimeMs > PARTIAL_GRACE_MS) await rm(file, { force: true });
      return undefined;
    }
    if (!name.endsWith(ENTRY_SUFFIX)) return undefined;
    const header = await headerOfFile(file);
    if (header === undefined || header.expiresAt <= now) {
      await this.#remove(name);
      return undefined;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- As above.
    const { size, mtimeMs } = await stat(file);
    return { name, size, written: mtimeMs };
  }

  #count(name: string, size: number): void {
    this.#forget(name);
    this.#entries.set(name, size);
    this.#total += size;
  }

  #forget(name: string): void {
    const size = this.#entries.get(name);
    if (size === undefined) return;
    this.#entries.delete(name);
    this.#total -= size;
  }

  /** Used just now: the last to be let go. */
  #touch(name: string): void {
    if (!this.#indexReady) {
      this.#usedBeforeIndex.delete(name);
      this.#usedBeforeIndex.set(name, Date.now());
    }
    const size = this.#entries.get(name);
    if (size === undefined) return;
    this.#entries.delete(name);
    this.#entries.set(name, size);
  }

  /** The images used longest ago let go until the rest fit what may be kept. */
  async #evict(): Promise<void> {
    this.#limit ??= this.#maxBytes ?? (await diskShareOf(this.#directory));
    while (this.#total > this.#limit) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) return;
      await this.#remove(oldest.value);
    }
  }

  async #remove(name: string): Promise<void> {
    this.#forget(name);
    this.#letGoDuringLook?.add(name);

    await rm(path.join(this.#directory, name), { force: true });
  }

  /** The index begun, where nothing has begun it: by the first image asked for, in the background. */
  #startIndexing(): void {
    if (this.#indexed !== undefined) return;
    void this.#index().catch((error: unknown) => {
      warn(LOOK_FAILED, { detail: detailOf(error) });
    });
  }

  /** The image kept under `key`, where one is and its lifetime has not run out. */
  async read(key: string): Promise<KeptImage | undefined> {
    this.#startIndexing();
    const name = fileNameOf(key);
    let bytes: Uint8Array;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- A hash names the file, under the server's own directory.
      bytes = await readFile(path.join(this.#directory, name));
    } catch (error) {
      if (!missing(error)) warn('image cache read failed', { detail: detailOf(error) });
      return undefined;
    }
    const entry = entryOf(bytes, key);
    if (entry === undefined) return undefined;
    if (entry.header.expiresAt <= Date.now()) {
      // A miss whether or not it can be let go: a directory the server may read but not write
      // to — mounted read-only, or another user's — answers from the source all the same (Codex).
      try {
        await this.#remove(name);
      } catch (error) {
        warn('image cache entry could not be let go', { detail: detailOf(error) });
      }
      return undefined;
    }
    this.#touch(name);
    return entry.image;
  }

  /** Keep `image` under `key`, its write waited on where the request's work is; at most a cache's worth. */
  keep(key: string, image: KeptImage, waitUntil: (promise: Promise<unknown>) => void): void {
    if (image.bytes.byteLength > CACHEABLE_RESULT_BYTES || image.maxAge <= 0) return;
    waitUntil(this.#written(key, image));
  }

  /** Stop looking the directory over. */
  stop(): void {
    clearInterval(this.#sweeper);
  }
}

/** Where this server keeps its images, once it has said so; none until then. */
const configured: { images?: DiskImages | undefined } = {};

/**
 * Where the server keeps the images it makes, said once as it starts (`server.ts`): a directory of
 * their own, and the most of the disk they may take. Kept nowhere until it is said, or where it says
 * none may be.
 */
export function configureImageCache(options: ImageCacheOptions | undefined): void {
  configured.images?.stop();
  configured.images =
    options === undefined || options.maxBytes === 0
      ? undefined
      : new DiskImages(options.directory, options.maxBytes);
}

/** The answer a kept image gives the request, as a fresh one would have been answered (`fromCache`). */
function answerFrom({ request, params, images }: ImageCacheInput, image: KeptImage): Response {
  const headers = imageResponseHeaders({
    href: params.href,
    contentType: image.contentType,
    // A source that stood in for a transformation that failed is not kept by a browser for a
    // build-hashed file's own lifetime, as it was not when it went out (`serviceFailed`).
    isStatic: params.isStatic && !image.fallback,
    maxAge: image.maxAge,
    etag: image.etag,
    config: images,
    cache: 'HIT',
  });
  if (holdsImage(request, image.etag)) {
    return new Response(null, { status: HTTP_NOT_MODIFIED, headers });
  }
  headers.set('content-length', String(image.bytes.byteLength));
  // Read into a buffer of its own, which is what the runtime's `Response` asks a body to be over.
  const body = image.bytes as Uint8Array<ArrayBuffer>;
  return new Response(request.method === 'HEAD' ? null : body, { headers });
}

export const openImageCache: ImageCacheOpener = (input) => {
  const { images } = configured;
  if (images === undefined) return;
  return (async (): Promise<ImageCacheSlot> => {
    const key = imageKeyOf(input);
    const image = await images.read(key);
    if (image !== undefined) {
      return { hit: answerFrom(input, image), keep: undefined };
    }
    // As the edge keeps nothing a middleware had a say on: what it let one visitor have, none other has.
    const keep = input.middlewareRan
      ? undefined
      : (made: KeptImage): void => {
          images.keep(key, made, input.waitUntil);
        };
    return { hit: undefined, keep };
  })();
};
