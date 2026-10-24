import { describe, expect, it } from 'vitest';

import { checkedImagesConfigSchema, imagesConfigFromNextManifest } from '../src/images/build.ts';
import { type ImagesConfig, imagesConfigSchema } from '../src/images/config.ts';
import { allowedImageDestination } from '../src/images/destination.ts';
import { detectImageType, outputImageType } from '../src/images/detect.ts';
import { imageFilename, imageResponseHeaders, upstreamMaxAge } from '../src/images/headers.ts';
import { isLocalAddress } from '../src/images/local-address.ts';
import { negotiateImageFormat } from '../src/images/negotiate.ts';
import { type ImageRequestResult, parseImageRequest } from '../src/images/params.ts';
import { unsafeSourcePatternReason } from '../src/request/pattern-safety.ts';

/**
 * `/_next/image` as Next.js's own optimizer checks it: the same rules, the same refusals. The
 * manifest below is what `next build` writes for the sample app, patterns compiled by the build.
 */

const HOST_PATTERN = String.raw`^(?:^(?:avatars\.githubusercontent\.com)$)$`;
const ANY_PATH = String.raw`^(?:(?!(?:^|\/)\.{1,2}(?:\/|$))(?:(?:(?!(?:^|\/)\.{1,2}(?:\/|$)).)*?)\/?)$`;

const NEXT_MANIFEST = {
  version: 1,
  images: {
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
    imageSizes: [32, 48, 64, 96, 128, 256, 384],
    path: '/_next/image',
    loader: 'default',
    loaderFile: '',
    domains: [],
    disableStaticImages: false,
    minimumCacheTTL: 14_400,
    formats: ['image/avif', 'image/webp'],
    maximumRedirects: 3,
    maximumResponseBody: 50_000_000,
    dangerouslyAllowLocalIP: false,
    dangerouslyAllowSVG: false,
    contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
    contentDispositionType: 'attachment',
    localPatterns: [{ pathname: ANY_PATH, search: '' }],
    remotePatterns: [{ protocol: 'https', hostname: HOST_PATTERN, pathname: ANY_PATH }],
    qualities: [75],
    unoptimized: false,
    customCacheHandler: false,
    sizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840, 32, 48, 64, 96, 128, 256, 384],
  },
};

function configured(): ImagesConfig {
  const config = imagesConfigFromNextManifest(NEXT_MANIFEST, '');
  if (config === undefined) {
    throw new Error('the sample manifest configures images');
  }
  return config;
}

const CONFIG = configured();
const CHROME_ACCEPT = 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';

function parse(query: string, accept: string | null = CHROME_ACCEPT, config = CONFIG) {
  return parseImageRequest(new URLSearchParams(query), accept, config);
}

function errorOf(result: ImageRequestResult): string | undefined {
  return result.kind === 'invalid' ? result.errorMessage : undefined;
}

function staticOf(result: ImageRequestResult): boolean | undefined {
  return result.kind === 'ok' ? result.params.isStatic : undefined;
}

function bytesOf(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

const MEDIA = 'url=%2F_next%2Fstatic%2Fmedia%2Fa.png&w=64&q=75';
const AVATAR = 'https://avatars.githubusercontent.com/u/1';

function remote(href: string): string {
  return `url=${encodeURIComponent(href)}&w=64&q=75`;
}

describe('imagesConfigFromNextManifest', () => {
  it('reads what the build wrote, sizes joined and patterns as compiled', () => {
    expect(CONFIG.path).toBe('/_next/image');
    expect(CONFIG.sizes).toStrictEqual(NEXT_MANIFEST.images.sizes);
    expect(CONFIG.qualities).toStrictEqual([75]);
    expect(CONFIG.formats).toStrictEqual(['image/avif', 'image/webp']);
    expect(CONFIG.remotePatterns[0]?.hostname).toBe(HOST_PATTERN);
    expect(CONFIG.localPatterns).toStrictEqual([{ pathname: ANY_PATH, search: '' }]);
    expect(CONFIG.domains).toStrictEqual([]);
  });

  it('carries whether a local address may be a source, and not by default', () => {
    const { images } = NEXT_MANIFEST;
    const allowing = { version: 1, images: { ...images, dangerouslyAllowLocalIP: true } };
    const unsaid = { ...images, dangerouslyAllowLocalIP: undefined };

    expect(CONFIG.dangerouslyAllowLocalIP).toBe(false);
    expect(imagesConfigFromNextManifest(allowing, '')?.dangerouslyAllowLocalIP).toBe(true);
    expect(
      imagesConfigFromNextManifest({ version: 1, images: unsaid }, '')?.dangerouslyAllowLocalIP,
    ).toBe(false);
  });

  /**
   * A pattern that does not compile would throw out of the first image request; it is refused
   * where the configuration is written — by the build, at the upload — and read as written, so
   * that a manifest an upload accepted is never refused by a reader that checks more.
   */
  it('refuses a source pattern that does not compile where it is written, not where it is read', () => {
    const badHost = { ...CONFIG, remotePatterns: [{ hostname: '^(', pathname: '^.*$' }] };
    const badPath = { ...CONFIG, localPatterns: [{ pathname: '[', search: '' }] };

    expect(checkedImagesConfigSchema.safeParse(CONFIG).success).toBe(true);
    expect(checkedImagesConfigSchema.safeParse(badHost).success).toBe(false);
    expect(checkedImagesConfigSchema.safeParse(badPath).success).toBe(false);
    expect(imagesConfigSchema.safeParse(badHost).success).toBe(true);
    expect(imagesConfigSchema.safeParse(badPath).success).toBe(true);
  });

  /** The same holds for one that compiles but backtracks: the edge runs it on a visitor's URL. */
  it('refuses a source pattern that backtracks where it is written, not where it is read', () => {
    const badHost = { ...CONFIG, remotePatterns: [{ hostname: '^(a+)+$', pathname: '^.*$' }] };
    const badPath = {
      ...CONFIG,
      localPatterns: [{ pathname: String.raw`^(?:\/.+)*$`, search: '' }],
    };

    expect(checkedImagesConfigSchema.safeParse(badHost).success).toBe(false);
    expect(checkedImagesConfigSchema.safeParse(badPath).success).toBe(false);
    expect(imagesConfigSchema.safeParse(badHost).success).toBe(true);
    expect(imagesConfigSchema.safeParse(badPath).success).toBe(true);
  });

  /**
   * The optimizer runs an image's pattern as it is, never without regard to case, so it is judged
   * so: one that only case tells apart is linear as it is run, and admitted for an image where a
   * route's source, some of which run with `i`, is refused.
   */
  it('judges an image pattern under the one flag the optimizer runs it with', () => {
    const cased = `^(?:${'(?:a|A)'.repeat(20)})$`;
    const config = {
      ...CONFIG,
      remotePatterns: [{ protocol: 'https', hostname: cased, pathname: ANY_PATH }],
    };

    expect(checkedImagesConfigSchema.safeParse(config).success).toBe(true);
    expect(unsafeSourcePatternReason(cased)).toBeDefined();
  });

  it('carries the basePath, for the hashed media it names', () => {
    expect(imagesConfigFromNextManifest(NEXT_MANIFEST, '/docs')?.basePath).toBe('/docs');
  });

  /** None of these builds asks for `/_next/image`: the loader never emits it. */
  it.each([
    ['unoptimized', { unoptimized: true }],
    ['a custom loader', { loader: 'custom' }],
  ])('records nothing for %s', (_label, override) => {
    const manifest = { ...NEXT_MANIFEST, images: { ...NEXT_MANIFEST.images, ...override } };

    expect(imagesConfigFromNextManifest(manifest, '')).toBeUndefined();
  });

  /**
   * A `loaderFile` beside `loader: 'default'` is a file Next.js lets choose, and one may return
   * the optimizer's own URL — the upstream `loader-config-default-loader-with-file` fixture's
   * does. Read as a custom loader, such a build recorded nothing and served no image at all.
   */
  it('records the configuration for a loader file the default loader keeps', () => {
    const manifest = {
      ...NEXT_MANIFEST,
      images: { ...NEXT_MANIFEST.images, loader: 'default', loaderFile: './image-loader.ts' },
    };

    expect(imagesConfigFromNextManifest(manifest, '')).toBeDefined();
  });

  it('records nothing it cannot read', () => {
    expect(imagesConfigFromNextManifest({ version: 1 }, '')).toBeUndefined();
  });

  /** Next.js admits any local source, query string and all, when no pattern is configured. */
  it('admits any local source for a manifest that names no local pattern', () => {
    const images: Record<string, unknown> = { ...NEXT_MANIFEST.images };
    delete images['localPatterns'];
    const config = imagesConfigFromNextManifest({ version: 1, images }, '');

    expect(config).toBeDefined();
    expect(parse('url=%2Fa.png%3Fv%3D1&w=64&q=75', null, config ?? CONFIG).kind).toBe('ok');
  });
});

describe('parseImageRequest', () => {
  it('accepts a local source with an allowed width and quality', () => {
    const result = parse('url=%2Flogo.png&w=640&q=75');

    expect(result).toStrictEqual({
      kind: 'ok',
      params: {
        href: '/logo.png',
        isAbsolute: false,
        isStatic: false,
        width: 640,
        quality: 75,
        mimeType: 'image/avif',
      },
    });
  });

  it('accepts a remote source the patterns allow, normalized', () => {
    const result = parse(
      `url=${encodeURIComponent('https://avatars.githubusercontent.com/u/1?v=4')}&w=64&q=75`,
    );

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.params.href).toBe(
      'https://avatars.githubusercontent.com/u/1?v=4',
    );
    expect(result.kind === 'ok' && result.params.isAbsolute).toBe(true);
  });

  it('marks a build-hashed source as static, under the basePath', () => {
    const withBase = imagesConfigFromNextManifest(NEXT_MANIFEST, '/docs') ?? CONFIG;

    const basedMedia = `url=%2Fdocs${MEDIA.slice('url='.length)}`;

    expect(staticOf(parse(MEDIA))).toBe(true);
    expect(staticOf(parse(basedMedia, null, withBase))).toBe(true);
    expect(staticOf(parse(MEDIA, null, withBase))).toBe(false);
  });

  /** One case per message the optimizer has. */
  it.each([
    ['w=64&q=75', '"url" parameter is required'],
    ['url=%2Fa.png&url=%2Fb.png&w=64&q=75', '"url" parameter cannot be an array'],
    [
      'url=%2F%2Fevil.example%2Fa.png&w=64&q=75',
      '"url" parameter cannot be a protocol-relative URL (//)',
    ],
    ['url=%2F_next%2Fimage%3Furl%3D%2Fa.png&w=64&q=75', '"url" parameter cannot be recursive'],
    ['url=%2F_next%2Fimage&w=64&q=75', '"url" parameter cannot be recursive'],
    ['url=%2Fa.png%3Fv%3D1&w=64&q=75', '"url" parameter is not allowed'],
    ['url=not%20a%20url&w=64&q=75', '"url" parameter is invalid'],
    ['url=ftp%3A%2F%2Fexample.com%2Fa.png&w=64&q=75', '"url" parameter is invalid'],
    ['url=https%3A%2F%2Fevil.example%2Fa.png&w=64&q=75', '"url" parameter is not allowed'],
    [
      'url=http%3A%2F%2Favatars.githubusercontent.com%2Fu%2F1&w=64&q=75',
      '"url" parameter is not allowed',
    ],
    ['url=%2Fa.png&q=75', '"w" parameter (width) is required'],
    ['url=%2Fa.png&w=64&w=32&q=75', '"w" parameter (width) cannot be an array'],
    ['url=%2Fa.png&w=6x&q=75', '"w" parameter (width) must be an integer greater than 0'],
    ['url=%2Fa.png&w=0&q=75', '"w" parameter (width) must be an integer greater than 0'],
    ['url=%2Fa.png&w=65&q=75', '"w" parameter (width) of 65 is not allowed'],
    ['url=%2Fa.png&w=64', '"q" parameter (quality) is required'],
    ['url=%2Fa.png&w=64&q=75&q=50', '"q" parameter (quality) cannot be an array'],
    ['url=%2Fa.png&w=64&q=7.5', '"q" parameter (quality) must be an integer between 1 and 100'],
    ['url=%2Fa.png&w=64&q=0', '"q" parameter (quality) must be an integer between 1 and 100'],
    ['url=%2Fa.png&w=64&q=101', '"q" parameter (quality) must be an integer between 1 and 100'],
    ['url=%2Fa.png&w=64&q=50', '"q" parameter (quality) of 50 is not allowed'],
  ])('refuses %s', (query, message) => {
    expect(errorOf(parse(query))).toBe(message);
  });

  it('refuses a source longer than the optimizer reads', () => {
    const long = `url=${'%2Fa'.repeat(1600)}&w=64&q=75`;

    expect(errorOf(parse(long))).toBe('"url" parameter is too long');
  });

  /**
   * Next.js's own check looks for `/_next/image` alone; an optimizer configured at another path
   * would otherwise be asked for itself, once per level the URL nests.
   */
  it('refuses the optimizer as a source at the path it was configured at', () => {
    const custom: ImagesConfig = { ...CONFIG, path: '/img/' };
    const recursive = '"url" parameter cannot be recursive';

    expect(errorOf(parse('url=%2Fimg%3Furl%3D%2Fa.png&w=64&q=75', null, custom))).toBe(recursive);
    expect(errorOf(parse('url=%2Fimg%2F%3Furl%3D%2Fa.png&w=64&q=75', null, custom))).toBe(
      recursive,
    );
    expect(errorOf(parse('url=%2F%2569mg%2F&w=64&q=75', null, custom))).toBe(recursive);
    expect(errorOf(parse('url=%2F_next%2Fimage&w=64&q=75', null, custom))).toBe(recursive);
    expect(parse('url=%2Fimgs%2Fa.png&w=64&q=75', null, custom).kind).toBe('ok');
    expect(parse('url=%2Fimg&w=64&q=75').kind).toBe('ok');
  });

  /** A pattern names a port or leaves any; a pattern's search is exact or unchecked. */
  it("holds a remote source to the pattern's port and search when they are named", () => {
    const strict: ImagesConfig = {
      ...CONFIG,
      remotePatterns: [
        { protocol: 'https', hostname: HOST_PATTERN, port: '', pathname: ANY_PATH, search: '?v=4' },
      ],
    };
    const notAllowed = '"url" parameter is not allowed';
    const onPort = AVATAR.replace('.com', '.com:8443');
    const wrongPort = remote(`${onPort}?v=4`);
    const wrongSearch = remote(`${AVATAR}?v=5`);
    const exact = remote(`${AVATAR}?v=4`);
    const anyPort = remote(onPort);

    expect(errorOf(parse(wrongPort, null, strict))).toBe(notAllowed);
    expect(errorOf(parse(wrongSearch, null, strict))).toBe(notAllowed);
    expect(parse(exact, null, strict).kind).toBe('ok');
    expect(parse(anyPort).kind).toBe('ok');
  });

  it('checks the width before the quality, as the optimizer does', () => {
    expect(errorOf(parse('url=%2Fa.png&w=65&q=101'))).toBe(
      '"w" parameter (width) of 65 is not allowed',
    );
  });

  it('admits a deprecated domain and any quality when none are configured', () => {
    const config: ImagesConfig = {
      ...CONFIG,
      domains: ['cdn.example'],
      remotePatterns: [],
      qualities: undefined,
    };

    const result = parse('url=https%3A%2F%2Fcdn.example%2Fa.png&w=64&q=33', null, config);

    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' && result.params.quality).toBe(33);
  });

  it('keeps the source format for a client that names none offered', () => {
    const result = parse('url=%2Fa.png&w=64&q=75', 'image/*,*/*;q=0.8');

    expect(result.kind === 'ok' && result.params.mimeType).toBe('');
  });

  /** As the optimizer refuses a source it resolved to a local address, unless allowed to. */
  it('refuses a local address the patterns would admit, unless the application allows one', () => {
    const anyHost: ImagesConfig = {
      ...CONFIG,
      remotePatterns: [{ protocol: 'http', hostname: '^.*$', pathname: '^.*$' }],
    };
    const allowing: ImagesConfig = { ...anyHost, dangerouslyAllowLocalIP: true };
    const loopback = remote('http://127.0.0.1/a.png');
    const named = remote('http://localhost:3000/a.png');
    const mapped = remote('http://[::ffff:10.0.0.1]/a.png');
    const global = remote('http://93.184.216.34/a.png');

    expect(errorOf(parse(loopback, null, anyHost))).toBe('"url" parameter is not allowed');
    expect(errorOf(parse(named, null, anyHost))).toBe('"url" parameter is not allowed');
    expect(errorOf(parse(mapped, null, anyHost))).toBe('"url" parameter is not allowed');
    expect(parse(global, null, anyHost).kind).toBe('ok');
    expect(parse(loopback, null, allowing).kind).toBe('ok');
  });
});

describe('isLocalAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.1.2.3', true],
    ['172.31.255.255', true],
    ['172.32.0.0', false],
    ['192.168.0.1', true],
    ['169.254.169.254', true],
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['224.0.0.1', true],
    ['198.18.0.1', true],
    ['203.0.113.7', true],
    ['192.31.196.1', true],
    ['8.8.8.8', false],
    ['[::1]', true],
    ['[::]', true],
    ['[::7f00:1]', true],
    ['[::127.0.0.1]', true],
    ['[::808:808]', true],
    ['[::ffff:ffff]', true],
    ['[::1:0:0]', false],
    ['[fe80::1]', true],
    ['[fd12::1]', true],
    ['[::ffff:7f00:1]', true],
    ['[::ffff:808:808]', false],
    ['[64:ff9b::a00:1]', true],
    ['[2001:db8::1]', true],
    ['[2001:4860:4860::8888]', false],
    ['[2606:4700::1111]', false],
    ['localhost', true],
    ['localhost.', true],
    ['app.localhost', true],
    ['app.localhost.', true],
    ['LOCALHOST', true],
    ['example.com', false],
    ['[not:an:address]', false],
  ])('judges %s as local: %s', (hostname, local) => {
    expect(isLocalAddress(hostname)).toBe(local);
  });
});

describe('negotiateImageFormat', () => {
  const FORMATS = ['image/avif', 'image/webp'];

  it.each([
    ['Chrome', CHROME_ACCEPT, 'image/avif'],
    ['an equal tie, in the application order', 'image/webp,image/avif', 'image/avif'],
    ['a q value that outranks the order', 'image/avif;q=0.5,image/webp', 'image/webp'],
    ['a format with q=0', 'image/avif;q=0,image/webp;q=0.9', 'image/webp'],
    ['WebP alone', 'image/webp,*/*;q=0.8', 'image/webp'],
    ['a wildcard alone', '*/*', ''],
    ['no header', '', ''],
  ])('negotiates %s', (_label, accept, expected) => {
    expect(negotiateImageFormat(accept, FORMATS)).toBe(expected);
  });

  it('offers nothing the application did not', () => {
    expect(negotiateImageFormat(CHROME_ACCEPT, ['image/webp'])).toBe('image/webp');
    expect(negotiateImageFormat('image/avif', ['image/webp'])).toBe('');
  });
});

describe('detectImageType', () => {
  it.each([
    ['jpeg', [0xff, 0xd8, 0xff, 0xe0], 'image/jpeg'],
    ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'image/png'],
    ['gif', [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 'image/gif'],
    ['webp', [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50], 'image/webp'],
    ['avif', [0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 'image/avif'],
    ['svg', bytesOf('<svg xmlns'), 'image/svg+xml'],
    ['svg with an xml declaration', bytesOf('<?xml ver'), 'image/svg+xml'],
    [
      'svg behind a byte order mark',
      [0xef, 0xbb, 0xbf, ...bytesOf('<svg xmlns="x">')],
      'image/svg+xml',
    ],
    [
      'svg behind a comment and a doctype',
      bytesOf('<!-- a -->\n<!DOCTYPE svg>\n<svg viewBox="0 0 1 1">'),
      'image/svg+xml',
    ],
    ['text that only mentions svg', bytesOf('<p>an <b>svg</b> file</p>'), undefined],
    // Every candidate is asked, not the first: a quote left open inside a comment ahead of the root
    // does not decide for the root.
    [
      'svg behind a commented tag whose quote never closes',
      bytesOf('<!-- <svg "x --><svg xmlns="x">'),
      'image/svg+xml',
    ],
    ['a tag whose only `>` is inside a quote', bytesOf('<!-- a --><svg title="a>b"'), undefined],
    ['ico', [0x00, 0x00, 0x01, 0x00, 1], 'image/x-icon'],
    ['bytes that only share the icon signature’s third byte', [0x12, 0x34, 0x01, 0x56], undefined],
    [
      'a RIFF that is not WebP',
      [0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45],
      undefined,
    ],
    ['bmp', [0x42, 0x4d, 0, 0], 'image/bmp'],
    ['html', bytesOf('<!doctype'), undefined],
    ['nothing', [], undefined],
  ])('recognises %s', (_label, bytes, expected) => {
    expect(detectImageType(new Uint8Array(bytes))).toBe(expected);
  });

  it('encodes as negotiated, else as the source when it can, else as JPEG', () => {
    expect(outputImageType('image/avif', 'image/png')).toBe('image/avif');
    expect(outputImageType('', 'image/png')).toBe('image/png');
    expect(outputImageType('', 'image/gif')).toBe('image/gif');
    expect(outputImageType('', 'image/webp')).toBe('image/jpeg');
    expect(outputImageType('', 'image/tiff')).toBe('image/jpeg');
  });
});

describe('imageResponseHeaders', () => {
  it('names the download after the source, in the format served', () => {
    expect(imageFilename('/images/hero.png?v=2', 'image/avif')).toBe('hero.avif');
    expect(imageFilename('https://cdn.example/u/1', 'image/webp')).toBe('1.webp');
    expect(imageFilename('/', 'image/webp')).toBe('image.bin');
    expect(imageFilename('/a.png', 'application/pdf')).toBe('image.bin');
  });

  it('sets what the optimizer sets', () => {
    const headers = imageResponseHeaders({
      href: '/logo.png',
      contentType: 'image/avif',
      isStatic: false,
      maxAge: 14_400,
      etag: '"abc"',
      config: CONFIG,
      cache: 'MISS',
    });

    expect(headers.get('vary')).toBe('Accept');
    expect(headers.get('cache-control')).toBe('public, max-age=14400, must-revalidate');
    expect(headers.get('content-type')).toBe('image/avif');
    expect(headers.get('content-disposition')).toBe('attachment; filename="logo.avif"');
    expect(headers.get('content-security-policy')).toBe(CONFIG.contentSecurityPolicy);
    expect(headers.get('x-nextjs-cache')).toBe('MISS');
    expect(headers.get('etag')).toBe('"abc"');
  });

  it('keeps a build-hashed source for ten years', () => {
    const headers = imageResponseHeaders({
      href: '/_next/static/media/a.abc123.png',
      contentType: 'image/webp',
      isStatic: true,
      maxAge: 0,
      etag: undefined,
      config: { ...CONFIG, contentDispositionType: 'inline' },
      cache: 'HIT',
    });

    expect(headers.get('cache-control')).toBe('public, max-age=315360000, immutable');
    expect(headers.get('content-disposition')).toBe('inline; filename="a.webp"');
    expect(headers.has('etag')).toBe(false);
  });

  it('encodes a name the header cannot quote', () => {
    const headers = imageResponseHeaders({
      href: '/写真.png',
      contentType: 'image/png',
      isStatic: false,
      maxAge: 1,
      etag: undefined,
      config: CONFIG,
      cache: 'MISS',
    });

    expect(headers.get('content-disposition')).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('写真.png')}`,
    );
  });

  it('reads the lifetime an upstream grants', () => {
    expect(upstreamMaxAge('public, max-age=3600, immutable')).toBe(3600);
    expect(upstreamMaxAge('max-age="600"')).toBe(600);
    expect(upstreamMaxAge('no-cache')).toBe(0);
    expect(upstreamMaxAge(null)).toBe(0);
  });
});

describe('the destination the optimizer may fetch', () => {
  /**
   * `/_next/image` takes its source from the query and anyone may call it. A pattern wide enough
   * to admit a private address — or a public host that redirects to one — would make the optimizer
   * a way to reach whatever the host reaches; Next.js gates that on `dangerouslyAllowLocalIP`.
   */
  it.each([
    'http://127.0.0.1/secret',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/internal',
    'http://192.168.1.1/',
    'http://localhost:8787/',
    'http://[::1]/',
    'http://[fe90::1]/',
    // The unspecified address reaches a listener on this host as surely as loopback does.
    'http://[::]/secret',
    'http://[::0]/',
    'http://[0:0:0:0:0:0:0:0]/',
    'http://[::7f00:1]/',
    'http://0.0.0.0/',
  ])('refuses %s', (href) => {
    expect(allowedImageDestination(configured(), new URL(href))).toBe(false);
  });

  it('admits a public destination', () => {
    expect(allowedImageDestination(configured(), new URL('https://images.example/a.png'))).toBe(
      true,
    );
  });

  it('admits a private one when the application asked for it', () => {
    const config = { ...configured(), dangerouslyAllowLocalIP: true };

    expect(allowedImageDestination(config, new URL('http://127.0.0.1/secret'))).toBe(true);
    expect(allowedImageDestination(config, new URL('http://[::7f00:1]/'))).toBe(true);
  });
});

describe('a source that names the optimizer itself', () => {
  /**
   * A path is the wrong thing to judge an absolute source by, and Next.js does not judge one that
   * way: `server/image-optimizer.js` tests the path of a relative URL only. An external image
   * service is free to answer at `/_next/image`, and an absolute URL that would come back to the
   * deployment is refused for its host, where the fetch itself is judged.
   */
  it('accepts an allowed remote whose own path is the optimizer, as Next.js does', () => {
    const config = { ...configured(), domains: ['images.example'] };

    expect(
      parseImageRequest(
        new URLSearchParams({
          url: 'https://images.example/_next/image?url=%2Fa.png&w=64&q=75',
          w: '64',
          q: '75',
        }),
        null,
        config,
      ),
    ).toMatchObject({ kind: 'ok' });
  });

  /** The relative form is the one a path can settle, and it is refused as Next.js refuses it. */
  it('refuses a relative source that names the optimizer', () => {
    expect(
      parseImageRequest(
        new URLSearchParams({ url: '/_next/image?url=%2Fa.png&w=64&q=75', w: '64', q: '75' }),
        null,
        configured(),
      ),
    ).toStrictEqual({
      kind: 'invalid',
      errorMessage: '"url" parameter cannot be recursive',
    });
  });
});
