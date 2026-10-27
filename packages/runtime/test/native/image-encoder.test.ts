import { fileURLToPath } from 'node:url';

import type { ImageRequestParams } from '@stayingupwind/core/images';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { EncodedImage } from '../../src/image-encoder.ts';
import {
  encodeImageWith,
  encodingOnce,
  holdsImage,
  loadSharp,
  type Sharp,
} from '../../src/native/image-encoder.ts';

/**
 * The native target's encoder: `sharp`, loaded as Next.js loads it — from where `next` is installed,
 * which for this package is its own development dependency — and driven as `next start` drives it.
 */

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const SOURCE_WIDTH = 400;
const PARAMS: ImageRequestParams = {
  href: '/a.png',
  isAbsolute: false,
  isStatic: false,
  width: 128,
  quality: 75,
  mimeType: '',
};
/** A PNG's signature, then bytes no decoder reads. */
const BROKEN_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** The signature and the IHDR chunk: its length and type, 13 bytes of data, and its CRC. */
const PNG_HEADER_END = 8 + 8 + 13 + 4;
/** An `acTL` chunk: its length, its type, two frames, played forever, and a CRC. */
const ANIMATION_CONTROL = new Uint8Array([
  0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0,
]);

/** A PNG with an animation's control chunk ahead of its image data, as an APNG has one. */
function animatedPng(still: Uint8Array): Uint8Array {
  const animated = new Uint8Array(still.byteLength + ANIMATION_CONTROL.byteLength);
  animated.set(still.subarray(0, PNG_HEADER_END));
  animated.set(ANIMATION_CONTROL, PNG_HEADER_END);
  animated.set(still.subarray(PNG_HEADER_END), PNG_HEADER_END + ANIMATION_CONTROL.byteLength);
  return animated;
}

describe('the native image encoder', () => {
  /** What of `sharp` makes and reads the sources here, beside what the encoder drives. */
  interface Encoder {
    toBuffer(): Promise<Uint8Array>;
  }
  interface Maker {
    (options: {
      readonly create: {
        readonly width: number;
        readonly height: number;
        readonly channels: 3;
        readonly background: string;
      };
    }): { png(): Encoder; webp(): Encoder };
    (
      frames: readonly Uint8Array[],
      options: { readonly join: { readonly animated: true } },
    ): {
      gif(): Encoder;
      webp(): Encoder;
    };
    (bytes: Uint8Array): {
      metadata(): Promise<{ readonly format: string; readonly width: number }>;
    };
  }

  let sharp: Sharp;
  let make: Maker;

  beforeAll(() => {
    sharp = loadSharp(PACKAGE_DIR);
    make = sharp as unknown as Maker;
  });

  function solid(width: number, background = '#ff0000'): { png(): Encoder; webp(): Encoder } {
    return make({ create: { width, height: width, channels: 3, background } });
  }

  /** What came out: its type, its format and width as `sharp` reads them. */
  async function encoded(bytes: Uint8Array, upstreamType: string, params = PARAMS) {
    const result = await encodeImageWith(sharp, { bytes, upstreamType, params });
    if (result?.kind !== 'encoded') throw new Error(`not encoded: ${String(result?.kind)}`);
    const { format, width } = await make(result.bytes).metadata();
    return { contentType: result.contentType, format, width };
  }

  it('resizes a source to the width asked, in the format the client negotiated', async () => {
    const png = await solid(SOURCE_WIDTH).png().toBuffer();

    const webp = await encoded(png, 'image/png', { ...PARAMS, mimeType: 'image/webp' });
    const avif = await encoded(png, 'image/png', { ...PARAMS, mimeType: 'image/avif' });

    expect(webp).toStrictEqual({ contentType: 'image/webp', format: 'webp', width: 128 });
    expect(avif.contentType).toBe('image/avif');
    expect(avif.width).toBe(128);
  });

  it('keeps a source’s own format where none was negotiated, and a WebP falls back to JPEG', async () => {
    const png = await solid(SOURCE_WIDTH).png().toBuffer();
    const webp = await solid(SOURCE_WIDTH).webp().toBuffer();

    await expect(encoded(png, 'image/png')).resolves.toStrictEqual({
      contentType: 'image/png',
      format: 'png',
      width: 128,
    });
    await expect(encoded(webp, 'image/webp')).resolves.toStrictEqual({
      contentType: 'image/jpeg',
      format: 'jpeg',
      width: 128,
    });
  });

  it('never enlarges a source narrower than the width asked', async () => {
    const png = await solid(64).png().toBuffer();

    const result = await encoded(png, 'image/png');

    expect(result.width).toBe(64);
  });

  it('passes on an animation as it is, as the optimizer does', async () => {
    const red = await solid(8).png().toBuffer();
    const blue = await solid(8, '#0000ff').png().toBuffer();
    const gif = await make([red, blue], { join: { animated: true } })
      .gif()
      .toBuffer();
    const webp = await make([red, blue], { join: { animated: true } })
      .webp()
      .toBuffer();
    const sources = [
      [gif, 'image/gif'],
      [webp, 'image/webp'],
      [animatedPng(red), 'image/png'],
    ] as const;

    for (const [bytes, upstreamType] of sources) {
      await expect(
        encodeImageWith(sharp, { bytes, upstreamType, params: PARAMS }),
      ).resolves.toStrictEqual({ kind: 'as-is' });
    }
  });

  it('says a transformation failed, for the source to stand in, where the bytes do not decode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The failure is said; the test reads that it was.
    });

    await expect(
      encodeImageWith(sharp, { bytes: BROKEN_PNG, upstreamType: 'image/png', params: PARAMS }),
    ).resolves.toStrictEqual({ kind: 'failed' });
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('image transformation failed'),
    );

    warn.mockRestore();
  });

  it('has nothing to say where there is no encoder: the source goes out as it is', () => {
    const input = { bytes: BROKEN_PNG, upstreamType: 'image/png', params: PARAMS };

    expect(encodeImageWith(null, input)).toBeUndefined();
  });

  it('encodes an image asked for twice at once only once, and again once that is done', async () => {
    const asIs: EncodedImage = { kind: 'as-is' };
    const ended = Promise.withResolvers<EncodedImage>();
    const encode = vi.fn(() => ended.promise);
    const input = { bytes: new Uint8Array([1, 2, 3]), upstreamType: 'image/png', params: PARAMS };

    const first = encodingOnce(input, encode);
    const second = encodingOnce(input, encode);
    const narrower = vi.fn(() => Promise.resolve(asIs));
    const other = encodingOnce({ ...input, params: { ...PARAMS, width: 64 } }, narrower);
    ended.resolve(asIs);

    await expect(first).resolves.toBe(asIs);
    await expect(second).resolves.toBe(asIs);
    await expect(other).resolves.toBe(asIs);
    expect(encode).toHaveBeenCalledExactlyOnceWith();
    expect(narrower).toHaveBeenCalledExactlyOnceWith();
    await expect(encodingOnce(input, () => Promise.resolve(asIs))).resolves.toBe(asIs);
    expect(encodingOnce(input, vi.fn<() => Promise<EncodedImage> | undefined>())).toBeUndefined();
  });

  it('answers a client that holds the image, by its tag, compared weakly', () => {
    const tag = '"abc"';
    const holding = new Request('https://app.example/_next/image', {
      headers: { 'if-none-match': `W/${tag}` },
    });

    expect(holdsImage(holding, tag)).toBe(true);
    expect(holdsImage(holding, '"other"')).toBe(false);
    expect(holdsImage(holding, undefined)).toBe(false);
    expect(holdsImage(new Request('https://app.example/_next/image'), tag)).toBe(false);
  });
});
