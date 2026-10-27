import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

import { AVIF, GIF, JPEG, outputImageType, PNG, WEBP } from '@stayingupwind/core/images';
import { validatorMatches } from '@stayingupwind/core/request';

import type {
  EncodedImage,
  EncodeImageInput,
  ImageEncoder,
  ImageValidator,
} from '../image-encoder.ts';

/**
 * An image resized and re-encoded on the native target, which has no edge in front of it to do it
 * (`image-encoder.ts`): by the edge's rules for what the client gets — the width and the quality
 * asked, the format the client negotiated or the one the edge picks in its absence
 * (`outputImageType`) — with the encoder Next.js's own optimizer uses, `sharp`, set up and driven as
 * `next start` drives it (`server/image-optimizer/transform.js`: `getSharp`, `optimizeImage`,
 * `imageOptimizerTransform`), where the edge leaves the work to Cloudflare Images.
 *
 * `sharp` is the application's, resolved as Next.js resolves it, from where `next` is installed: it
 * is an optional dependency of Next.js, so an application that can optimize images under
 * `next start` has it, and the build copies it into the artifact beside Next.js
 * (`adapter/src/native/encoder-files.ts`). Where it is missing all the same, the source goes out as
 * it is, as it does on Workers, and that is said once.
 */

/** What of `sharp` is driven here. */
interface SharpPipeline {
  timeout(options: { readonly seconds: number }): SharpPipeline;
  rotate(): SharpPipeline;
  resize(
    width: number,
    height: undefined,
    options: { readonly withoutEnlargement: boolean },
  ): SharpPipeline;
  avif(options: { readonly quality: number; readonly effort: number }): SharpPipeline;
  webp(options: { readonly quality: number }): SharpPipeline;
  png(options: { readonly quality: number }): SharpPipeline;
  jpeg(options: { readonly quality: number; readonly mozjpeg: boolean }): SharpPipeline;
  gif(): SharpPipeline;
  metadata(): Promise<{ readonly pages?: number }>;
  toBuffer(): Promise<Uint8Array>;
}

export interface Sharp {
  (input: Uint8Array): SharpPipeline;
  block(options: { readonly operation: readonly string[] }): void;
  unblock(options: { readonly operation: readonly string[] }): void;
  concurrency(threads?: number): number;
}

/** How long one transformation may take, as Next.js's optimizer allows it by default. */
const TIMEOUT_SECONDS = 7;
/** How hard the AVIF encoder works, as Next.js sets it. */
const AVIF_EFFORT = 3;
/**
 * `sharp`'s default qualities for AVIF and for WebP, whose ratio Next.js scales a quality by for
 * AVIF, so that one reads as the WebP of it would.
 */
const SHARP_AVIF_QUALITY = 50;
const SHARP_WEBP_QUALITY = 80;
/** Of the machine's threads, the share `sharp` is left to use, as Next.js leaves it in production. */
const CONCURRENCY_DIVISOR = 2;
/** The loaders `sharp` may use: the formats the optimizer reads, and none of `libvips`'s others. */
const BLOCKED_LOADERS = ['VipsForeignLoad'];
const LOADERS = [
  'VipsForeignLoadHeif',
  'VipsForeignLoadJpeg',
  'VipsForeignLoadNsgif',
  'VipsForeignLoadPng',
  'VipsForeignLoadSvg',
  'VipsForeignLoadTiff',
  'VipsForeignLoadWebp',
];
/** The formats an animation can come in, which the optimizer passes on as it is (`ANIMATABLE_TYPES`). */
const ANIMATABLE: ReadonlySet<string> = new Set([GIF, PNG, WEBP]);
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_HEADER_BYTES = 8;
const PNG_CHUNK_CRC_BYTES = 4;
/** A PNG chunk's type: an animation's control, and the image data. */
const PNG_ANIMATION_CONTROL = 'acTL';
const PNG_IMAGE_DATA = 'IDAT';

/** Whether the chunk type at `at` is `type`, its four ASCII bytes. */
function chunkIs(bytes: Uint8Array, at: number, type: string): boolean {
  for (let index = 0; index < type.length; index += 1) {
    if (bytes[at + index] !== type.codePointAt(index)) return false;
  }
  return true;
}

/**
 * Whether a PNG is an animation: an `acTL` chunk ahead of its image data, as the APNG format
 * places one. `libvips` reads the first frame of one alone, so `sharp` cannot say.
 */
function isAnimatedPng(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = PNG_SIGNATURE_BYTES; at + PNG_CHUNK_HEADER_BYTES <= bytes.byteLength;) {
    const typeAt = at + PNG_CHUNK_HEADER_BYTES / 2;
    if (chunkIs(bytes, typeAt, PNG_ANIMATION_CONTROL)) return true;
    if (chunkIs(bytes, typeAt, PNG_IMAGE_DATA)) return false;
    at += PNG_CHUNK_HEADER_BYTES + view.getUint32(at) + PNG_CHUNK_CRC_BYTES;
  }
  return false;
}

/** Whether the source is an animation, which the optimizer passes on as it is (`isAnimated`). */
async function isAnimated(sharp: Sharp, bytes: Uint8Array, type: string): Promise<boolean> {
  if (!ANIMATABLE.has(type)) return false;
  if (type === PNG) return isAnimatedPng(bytes);
  try {
    // A GIF's or WebP's frames, as `libvips` counts them.
    const { pages } = await sharp(bytes).metadata();
    return pages !== undefined && pages > 1;
  } catch {
    // Unreadable: not an animation to pass on, but a source the encoder fails on below.
    return false;
  }
}

function warn(message: string, fields: Readonly<Record<string, unknown>> = {}): void {
  // eslint-disable-next-line no-console
  console.warn(JSON.stringify({ level: 'warn', msg: `next-runtime: ${message}`, ...fields }));
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `sharp` as Next.js loads it (`getSharp`): from where `next` is installed, with only the loaders
 * the optimizer reads unblocked, and half the machine's threads.
 */
export function loadSharp(directory: string): Sharp {
  const project = createRequire(path.join(directory, 'package.json'));
  const sharp = createRequire(project.resolve('next/package.json'))('sharp') as Sharp;
  sharp.block({ operation: BLOCKED_LOADERS });
  sharp.unblock({ operation: LOADERS });
  const threads = sharp.concurrency();
  if (threads > 1) {
    sharp.concurrency(Math.floor(Math.max(threads / CONCURRENCY_DIVISOR, 1)));
  }
  return sharp;
}

/** The encoder this process has, once looked for: `null` where there is none to load. */
const loaded: { encoder?: Sharp | null } = {};

/** The encoder, loaded once from the project directory the server runs in. */
function sharpOf(): Sharp | null {
  if (loaded.encoder === undefined) {
    try {
      loaded.encoder = loadSharp(process.cwd());
    } catch (error) {
      loaded.encoder = null;
      warn('images are served unresized: sharp could not be loaded', {
        detail: detailOf(error),
      });
    }
  }
  return loaded.encoder;
}

/** The pipeline set to encode as `format`, as `optimizeImage` sets each. */
function encodedAs(pipeline: SharpPipeline, format: string, quality: number): SharpPipeline {
  switch (format) {
    case AVIF: {
      return pipeline.avif({
        quality: Math.max(Math.round((quality * SHARP_AVIF_QUALITY) / SHARP_WEBP_QUALITY), 1),
        effort: AVIF_EFFORT,
      });
    }
    case WEBP: {
      return pipeline.webp({ quality });
    }
    case PNG: {
      return pipeline.png({ quality });
    }
    case JPEG: {
      return pipeline.jpeg({ quality, mozjpeg: true });
    }
    default: {
      return pipeline.gif();
    }
  }
}

/** The source transformed for the request, as `optimizeImage` transforms one. */
async function transformed(
  sharp: Sharp,
  { bytes, upstreamType, params }: EncodeImageInput,
): Promise<EncodedImage> {
  const format = outputImageType(params.mimeType, upstreamType);
  const { quality } = params;
  try {
    const pipeline = sharp(bytes)
      .timeout({ seconds: TIMEOUT_SECONDS })
      .rotate()
      .resize(params.width, undefined, { withoutEnlargement: true });
    const output = await encodedAs(pipeline, format, quality).toBuffer();
    return {
      kind: 'encoded',
      bytes: new Uint8Array(output.buffer, output.byteOffset, output.byteLength),
      contentType: format,
    };
  } catch (error) {
    // As Next.js falls back when its encoder fails: the source itself, for its minimum lifetime.
    warn('image transformation failed', { detail: detailOf(error) });
    return { kind: 'failed' };
  }
}

/** With `sharp` given: what a test drives, and what the module's own `encodeImage` is. */
export function encodeImageWith(
  sharp: Sharp | null,
  input: EncodeImageInput,
): Promise<EncodedImage> | undefined {
  if (sharp === null) return undefined;
  return (async (): Promise<EncodedImage> => {
    if (await isAnimated(sharp, input.bytes, input.upstreamType)) return { kind: 'as-is' };
    return await transformed(sharp, input);
  })();
}

/** Whether there is an encoder to make an image with, as `encodeImage` would find it. */
export function encoderAvailable(): boolean {
  return sharpOf() !== null;
}

/** The encodings under way, by what they are made of and for: one each, whoever asked for it. */
const encoding = new Map<string, Promise<EncodedImage>>();

/** What an encoding is made of and for: the source by its bytes, and what was asked of it. */
function encodingKeyOf({ bytes, upstreamType, params }: EncodeImageInput): string {
  const source = createHash('sha256').update(bytes).digest('hex');
  return `${source}/${upstreamType}/${String(params.width)}/${String(params.quality)}/${params.mimeType}`;
}

/**
 * The encoding `encode` starts, unless one of the same source for the same request is under way
 * already, whose result it shares: two requests for an image at once encode it once. The result's
 * bytes are each answer's to read, as a `Response` reads a body it is given into one of its own.
 */
export function encodingOnce(
  input: EncodeImageInput,
  encode: () => Promise<EncodedImage> | undefined,
): Promise<EncodedImage> | undefined {
  const key = encodingKeyOf(input);
  const running = encoding.get(key);
  if (running !== undefined) return running;
  const started = encode();
  if (started === undefined) return undefined;
  const shared = (async (): Promise<EncodedImage> => {
    try {
      return await started;
    } finally {
      encoding.delete(key);
    }
  })();
  encoding.set(key, shared);
  return shared;
}

export const encodeImage: ImageEncoder = (input) =>
  encodingOnce(input, () => encodeImageWith(sharpOf(), input));

/**
 * Whether the client already holds the image the answer carries — its `If-None-Match` naming the
 * entity tag — to be answered 304 in its place, as the edge answers it (`respond`).
 */
export const holdsImage: ImageValidator = (request, etag) =>
  etag !== undefined && validatorMatches(request, etag);
