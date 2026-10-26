/* eslint-disable security/detect-non-literal-fs-filename -- Every path belongs to a test-created directory. */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  imageResponseHeaders,
  type ImageRequestParams,
  type ImagesConfig,
} from '@stayingupwind/core/images';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImageCacheInput, ImageCacheSlot, KeptImage } from '../../src/image-cache.ts';
import { sourceResponse } from '../../src/image-fallback.ts';
import { configureImageCache, imageKeyOf, openImageCache } from '../../src/native/image-cache.ts';
import { loadSharp } from '../../src/native/image-encoder.ts';

/**
 * The images the native target makes, kept on its disk by the edge's rules: under what they are made
 * of and for, for as long as a client may keep them, and as much of them as the configuration
 * allows, the ones used longest ago let go first; a hit answered as the image was when it was made.
 */

// As the native build swaps the modules in (`nativeModules`, `adapter/src/native/emit.ts`).
vi.mock(import('../../src/image-encoder.ts'), () => import('../../src/native/image-encoder.ts'));

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const HTTP_OK = 200;
const HTTP_NOT_MODIFIED = 304;
const MS_PER_SECOND = 1000;
const MIB = 1024 * 1024;
const IMAGES: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  sizes: [64, 128],
  qualities: [75, 90],
  formats: ['image/avif', 'image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 50_000_000,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
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
const IMAGE: KeptImage = {
  bytes: new Uint8Array([1, 2, 3, 4]),
  contentType: 'image/webp',
  etag: '"made"',
  maxAge: 60,
  fallback: false,
};

/** The request as the native server makes it on `port`: the site the client asked for, forwarded. */
function atPort(port: number): Request {
  return new Request(`http://127.0.0.1:${String(port)}/_next/image?url=a&w=128&q=75`, {
    headers: { 'x-forwarded-host': `app.example:${String(port)}` },
  });
}

function asked(headers: HeadersInit = {}, method = 'GET'): Request {
  return new Request('https://app.example/_next/image?url=a&w=128&q=75', { method, headers });
}

describe('images the native target keeps', () => {
  let directory: string;
  let pending: Promise<unknown>[];

  function inputOf(overrides: Partial<ImageCacheInput> = {}): ImageCacheInput {
    return {
      request: asked(),
      params: PARAMS,
      images: IMAGES,
      deploymentId: 'dpl_a',
      middlewareRan: false,
      waitUntil: (promise) => {
        pending.push(promise);
      },
      ...overrides,
    };
  }

  /** What every write the requests left behind came to. */
  async function settled(): Promise<void> {
    await Promise.all(pending.splice(0));
  }

  async function slotOf(input: ImageCacheInput): Promise<ImageCacheSlot> {
    const opening = openImageCache(input);
    if (opening === undefined) throw new Error('nothing is kept');
    return await opening;
  }

  async function kept(input: ImageCacheInput, image: KeptImage = IMAGE): Promise<void> {
    const slot = await slotOf(input);
    if (slot.keep === undefined) throw new Error('not to be kept');
    slot.keep(image);
    await settled();
  }

  async function hitOf(input: ImageCacheInput): Promise<Response | undefined> {
    return (await slotOf(input)).hit;
  }

  function fileOf(input: ImageCacheInput): string {
    return path.join(
      directory,
      `${createHash('sha256').update(imageKeyOf(input)).digest('hex')}.img`,
    );
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'upwind-native-images-'));
    pending = [];
    // The server's directory, which the encoder is loaded from: here, this package's.
    vi.spyOn(process, 'cwd').mockReturnValue(PACKAGE_DIR);
    configureImageCache({ directory, maxBytes: 10 * MIB });
  });

  afterEach(async () => {
    configureImageCache(undefined);
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps nothing until the server says where, nor where the application allows none', () => {
    configureImageCache(undefined);

    expect(openImageCache(inputOf())).toBeUndefined();

    configureImageCache({ directory, maxBytes: 0 });

    expect(openImageCache(inputOf())).toBeUndefined();
  });

  it('answers an image kept as a fresh one went out, but for being a hit', async () => {
    await expect(hitOf(inputOf())).resolves.toBeUndefined();

    await kept(inputOf());
    const hit = await hitOf(inputOf());
    const fresh = imageResponseHeaders({
      href: PARAMS.href,
      contentType: IMAGE.contentType,
      isStatic: true,
      maxAge: IMAGE.maxAge,
      etag: IMAGE.etag,
      config: IMAGES,
      cache: 'MISS',
    });

    expect(hit?.status).toBe(HTTP_OK);

    for (const [name, value] of fresh) {
      expect(hit?.headers.get(name)).toBe(name === 'x-nextjs-cache' ? 'HIT' : value);
    }

    expect(hit?.headers.get('content-length')).toBe('4');
    expect(new Uint8Array((await hit?.arrayBuffer()) ?? new ArrayBuffer(0))).toStrictEqual(
      IMAGE.bytes,
    );
  });

  it('answers a client that holds it with a 304, and a HEAD with no body', async () => {
    await kept(inputOf());

    const held = await hitOf(inputOf({ request: asked({ 'if-none-match': '"made"' }) }));
    const head = await hitOf(inputOf({ request: asked({}, 'HEAD') }));

    expect(held?.status).toBe(HTTP_NOT_MODIFIED);
    expect(held?.body).toBeNull();
    expect(held?.headers.get('etag')).toBe('"made"');
    expect(head?.status).toBe(HTTP_OK);
    expect(head?.body).toBeNull();
    expect(head?.headers.get('content-length')).toBe('4');
  });

  it('keeps an image under what it is made of and for, and no other', async () => {
    await kept(inputOf());

    const others = [
      inputOf({ params: { ...PARAMS, width: 64 } }),
      inputOf({ params: { ...PARAMS, quality: 90 } }),
      inputOf({ params: { ...PARAMS, mimeType: 'image/avif' } }),
      inputOf({ params: { ...PARAMS, mimeType: '' } }),
      inputOf({ params: { ...PARAMS, href: '/_next/static/media/b.5678.png' } }),
      inputOf({ deploymentId: 'dpl_b' }),
      inputOf({ request: new Request('https://other.example/_next/image?url=a&w=128&q=75') }),
      inputOf({ request: asked({ 'x-forwarded-host': 'forwarded.example' }) }),
      inputOf({ images: { ...IMAGES, minimumCacheTTL: 120 } }),
    ];
    for (const other of others) {
      await expect(hitOf(other)).resolves.toBeUndefined();
    }

    await expect(hitOf(inputOf())).resolves.toBeDefined();
  });

  it('answers the same site on another port, as a server started again on one does', async () => {
    await kept(inputOf({ request: atPort(3000) }));
    const restarted = inputOf({ request: atPort(3001) });

    await expect(hitOf(restarted)).resolves.toBeDefined();
    await expect(hitOf(inputOf())).resolves.toBeDefined();
  });

  it('shares an image of the internet across deployments, but not one of the application', async () => {
    const remote = { ...PARAMS, href: 'https://images.example/a.png', isAbsolute: true };
    await kept(inputOf({ params: remote }));
    await kept(inputOf());

    await expect(hitOf(inputOf({ params: remote, deploymentId: 'dpl_b' }))).resolves.toBeDefined();
    await expect(hitOf(inputOf({ deploymentId: 'dpl_b' }))).resolves.toBeUndefined();
  });

  it('lets an image go once its lifetime has run out', async () => {
    const now = Date.now();
    await kept(inputOf());
    vi.spyOn(Date, 'now').mockReturnValue(now + (IMAGE.maxAge + 1) * MS_PER_SECOND);

    const file = fileOf(inputOf());

    await expect(hitOf(inputOf())).resolves.toBeUndefined();
    await expect(stat(file)).rejects.toThrow('ENOENT');
  });

  it('keeps nothing a middleware had a say on, but answers what was kept', async () => {
    const after = inputOf({ middlewareRan: true });

    await expect(slotOf(after)).resolves.toStrictEqual({ hit: undefined, keep: undefined });

    await kept(inputOf());

    await expect(hitOf(after)).resolves.toBeDefined();
  });

  it('keeps nothing larger than the edge keeps, nor anything with no lifetime', async () => {
    const large = { ...IMAGE, bytes: new Uint8Array(8 * MIB + 1) };
    await kept(inputOf(), large);

    await expect(hitOf(inputOf())).resolves.toBeUndefined();

    await kept(inputOf(), { ...IMAGE, maxAge: 0 });

    await expect(hitOf(inputOf())).resolves.toBeUndefined();
  });

  it('lets the images used longest ago go once more is kept than is allowed', async () => {
    const image = { ...IMAGE, bytes: new Uint8Array(700) };
    const first = inputOf({ params: { ...PARAMS, href: '/first.png' } });
    const second = inputOf({ params: { ...PARAMS, href: '/second.png' } });
    const third = inputOf({ params: { ...PARAMS, href: '/third.png' } });
    // Two images and their headers fit; three do not.
    configureImageCache({ directory, maxBytes: 2400 });

    await kept(first, image);
    await kept(second, image);

    // Read since, so the second is the one used longest ago.
    await expect(hitOf(first)).resolves.toBeDefined();

    await kept(third, image);

    await expect(hitOf(first)).resolves.toBeDefined();
    await expect(hitOf(second)).resolves.toBeUndefined();
    await expect(hitOf(third)).resolves.toBeDefined();
  });

  it('reads a damaged entry as none', async () => {
    await writeFile(fileOf(inputOf()), new Uint8Array([0, 0, 0, 9, 1, 2]));

    await expect(hitOf(inputOf())).resolves.toBeUndefined();
  });

  it('lets go, as it starts, images past their lifetime and writes a stopped server left', async () => {
    const now = Date.now();
    const old = inputOf({ params: { ...PARAMS, href: '/old.png' } });
    await kept(old, { ...IMAGE, maxAge: 1 });
    const partial = path.join(directory, `${'0'.repeat(64)}.img.1.left.tmp`);
    await writeFile(partial, new Uint8Array([1]));
    const anHourAgo = (now - 2 * 60 * 60 * MS_PER_SECOND) / MS_PER_SECOND;
    await utimes(partial, anHourAgo, anHourAgo);
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * MS_PER_SECOND);

    // Another server, starting on the same directory, looks it over before it keeps anything.
    configureImageCache({ directory, maxBytes: 10 * MIB });
    await kept(inputOf());

    const left = path.basename(fileOf(inputOf()));

    await expect(readdir(directory)).resolves.toStrictEqual([left]);
  });

  describe('as an image is answered', () => {
    let png: Uint8Array;

    beforeEach(async () => {
      type Maker = (options: {
        readonly create: {
          readonly width: number;
          readonly height: number;
          readonly channels: 3;
          readonly background: string;
        };
      }) => { png(): { toBuffer(): Promise<Uint8Array> } };
      const make = loadSharp(PACKAGE_DIR) as unknown as Maker;
      const green = make({
        create: { width: 400, height: 400, channels: 3, background: '#00ff00' },
      });
      png = await green.png().toBuffer();
    });

    function sourceOf(bytes: Uint8Array, headers: HeadersInit): Response {
      return new Response(new Blob([new Uint8Array(bytes)]), { headers });
    }

    it('keeps what the answer made, and answers it again under the same headers', async () => {
      const slot = await slotOf(inputOf());
      const fresh = await sourceResponse({
        source: sourceOf(png, { 'cache-control': 'public, max-age=600', etag: '"source"' }),
        params: PARAMS,
        images: IMAGES,
        internal: true,
        request: asked(),
        keep: slot.keep,
      });
      const made = new Uint8Array(await fresh.arrayBuffer());
      await settled();

      const hit = await hitOf(inputOf());

      expect(hit).toBeDefined();

      for (const name of ['etag', 'cache-control', 'content-type', 'vary', 'content-disposition']) {
        expect(hit?.headers.get(name)).toBe(fresh.headers.get(name));
      }

      expect(fresh.headers.get('x-nextjs-cache')).toBe('MISS');
      expect(hit?.headers.get('x-nextjs-cache')).toBe('HIT');
      expect(new Uint8Array((await hit?.arrayBuffer()) ?? new ArrayBuffer(0))).toStrictEqual(made);
    });

    it('tags a source kept as it is by its bytes, where it carries no tag of its own', async () => {
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      const params = { ...PARAMS, href: '/a.svg', isStatic: false };
      const images = { ...IMAGES, dangerouslyAllowSVG: true };
      const slot = await slotOf(inputOf({ params, images }));

      const fresh = await sourceResponse({
        source: sourceOf(svg, { 'cache-control': 'public, max-age=600' }),
        params,
        images,
        internal: true,
        request: asked(),
        keep: slot.keep,
      });
      await fresh.body?.cancel();
      await settled();
      const hit = await hitOf(inputOf({ params, images }));

      expect(fresh.headers.get('etag')).toMatch(/^"[\da-f]{64}"$/u);
      expect(hit?.headers.get('etag')).toBe(fresh.headers.get('etag'));
    });

    it('keeps a source standing in for a transformation that failed for that lifetime alone', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
        // The failure is said; the test reads what was kept.
      });
      const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
      const slot = await slotOf(inputOf());

      const fresh = await sourceResponse({
        source: sourceOf(broken, { 'cache-control': 'public, max-age=31536000, immutable' }),
        params: PARAMS,
        images: IMAGES,
        internal: true,
        request: asked(),
        keep: slot.keep,
      });
      await fresh.body?.cancel();
      await settled();
      const hit = await hitOf(inputOf());

      expect(fresh.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
      expect(hit?.headers.get('cache-control')).toBe(fresh.headers.get('cache-control'));
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining('image transformation failed'),
      );
    });
  });
});
