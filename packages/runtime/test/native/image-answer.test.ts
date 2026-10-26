import { fileURLToPath } from 'node:url';

import { sha256Hex } from '@stayingupwind/core/artifact';
import type { ImageRequestParams, ImagesConfig } from '@stayingupwind/core/images';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sourceResponse } from '../../src/image-fallback.ts';
import { loadSharp } from '../../src/native/image-encoder.ts';

/**
 * `/_next/image` answered on the native target: the image fallback the Function shares with Workers,
 * with the encoder the native build swaps in for Workers' none (`image-encoder.ts`). The source is
 * resized and re-encoded, under the optimizer's headers and an entity tag of its own bytes, and a
 * client that holds it already is answered 304, as the edge answers it.
 */

// As the native build swaps the module in (`nativeModules`, `adapter/src/native/emit.ts`).
vi.mock(import('../../src/image-encoder.ts'), () => import('../../src/native/image-encoder.ts'));

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const HTTP_OK = 200;
const HTTP_NOT_MODIFIED = 304;
const IMAGES: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  sizes: [128],
  qualities: [75],
  formats: ['image/avif', 'image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 50_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: true,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'inline',
};
const PARAMS: ImageRequestParams = {
  href: '/_next/static/media/a.1234.png',
  isAbsolute: false,
  isStatic: true,
  width: 128,
  quality: 75,
  mimeType: 'image/webp',
};
/** A PNG's signature, then bytes no decoder reads. */
const BROKEN_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function asked(headers: HeadersInit = {}, method = 'GET'): Request {
  return new Request('https://app.example/_next/image?url=a&w=128&q=75', { method, headers });
}

/** The source as the application answered it, under its own lifetime and tag. */
function sourceOf(bytes: Uint8Array): Response {
  const body = new Blob([new Uint8Array(bytes)]);
  return new Response(body, {
    headers: { 'cache-control': 'public, max-age=600', etag: '"source"' },
  });
}

function answer(request: Request, bytes: Uint8Array, params = PARAMS): Promise<Response> {
  return sourceResponse({
    source: sourceOf(bytes),
    params,
    images: IMAGES,
    internal: true,
    request,
  });
}

describe('an image on the native target', () => {
  let png: Uint8Array;

  beforeEach(async () => {
    /** What of `sharp` makes the source here. */
    type Maker = (options: {
      readonly create: {
        readonly width: number;
        readonly height: number;
        readonly channels: 3;
        readonly background: string;
      };
    }) => { png(): { toBuffer(): Promise<Uint8Array> } };

    // The server's directory, which the encoder is loaded from: here, this package's.
    vi.spyOn(process, 'cwd').mockReturnValue(PACKAGE_DIR);
    const make = loadSharp(PACKAGE_DIR) as unknown as Maker;
    const green = make({ create: { width: 400, height: 400, channels: 3, background: '#00ff00' } });
    png = await green.png().toBuffer();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is resized, re-encoded as negotiated, and tagged by its own bytes', async () => {
    const response = await answer(asked(), png);
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.status).toBe(HTTP_OK);
    expect(response.headers.get('content-type')).toBe('image/webp');
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(response.headers.get('etag')).toBe(`"${await sha256Hex(bytes)}"`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=315360000, immutable');
    expect(response.headers.get('content-disposition')).toBe('inline; filename="a.webp"');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(bytes.byteLength).toBeLessThan(png.byteLength);
  });

  it('answers a client that holds it already with a 304, carrying no body or length', async () => {
    const first = await answer(asked(), png);
    const tag = first.headers.get('etag') ?? '';
    await first.body?.cancel();

    const again = await answer(asked({ 'if-none-match': tag }), png);

    expect(again.status).toBe(HTTP_NOT_MODIFIED);
    expect(again.body).toBeNull();
    expect(again.headers.get('etag')).toBe(tag);
    expect(again.headers.has('content-length')).toBe(false);
  });

  it('answers HEAD with the transformation’s headers and no body', async () => {
    const get = await answer(asked(), png);
    const head = await answer(asked({}, 'HEAD'), png);

    expect(head.body).toBeNull();
    expect(head.headers.get('content-length')).toBe(get.headers.get('content-length'));
    expect(head.headers.get('etag')).toBe(get.headers.get('etag'));

    await get.body?.cancel();
  });

  it('serves the source as it is, for the shortest lifetime, where the transformation fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      // The failure is said; the test reads that it was.
    });

    const response = await answer(asked(), BROKEN_PNG);
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
    expect(response.headers.get('etag')).toBe('"source"');
    expect(bytes).toStrictEqual(BROKEN_PNG);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('image transformation failed'),
    );
  });

  it('passes on a type the optimizer serves as it is, without asking the encoder', async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

    const response = await answer(asked(), svg, { ...PARAMS, href: '/a.svg', isStatic: false });
    const bytes = new Uint8Array(await response.arrayBuffer());

    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    expect(response.headers.get('etag')).toBe('"source"');
    expect(bytes).toStrictEqual(svg);
  });
});
