import type { ImageRequestParams, ImagesConfig } from '@stayingupwind/core/images';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { describe, expect, it, vi } from 'vitest';

import { requestContextFor } from '../src/cache/context.ts';
import type { CacheRuntime } from '../src/cache/runtime.ts';
import { fetchRemoteSource, sourceResponse } from '../src/image-fallback.ts';
import { markBuildPublication } from '../src/publication-proof.ts';
import { admitBuildSource, admitRequestPublication } from '../src/publication.ts';
import type { RoutedInput } from '../src/serve.ts';

/**
 * What the Worker's own answer for `/_next/image` holds a source to — the fallback for when the
 * edge has no manifest to optimize from: a URL of the internet is fetched as the optimizer
 * fetches one, and what comes back goes out only as far as the optimizer would let it.
 */

const HTTP_OK = 200;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_LOOP_DETECTED = 508;
const KIB = 1024;
const UPSTREAM_INVALID = '"url" parameter is valid but upstream response is invalid';
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGES: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  sizes: [64],
  qualities: [75],
  formats: ['image/avif', 'image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 4 * KIB,
  remotePatterns: [{ protocol: 'https', hostname: String.raw`^cdn\.example$`, pathname: '^.*$' }],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const OWN_HOSTS: ReadonlySet<string> = new Set(['app.example']);
const PARAMS: ImageRequestParams = {
  href: 'https://cdn.example/a.png',
  isAbsolute: true,
  isStatic: false,
  width: 64,
  quality: 75,
  mimeType: 'image/webp',
};

/** A PNG by its signature, padded to `length` bytes. */
function png(length = PNG_SIGNATURE.byteLength): Uint8Array {
  return concatBytes([PNG_SIGNATURE, new Uint8Array(length - PNG_SIGNATURE.byteLength)]);
}

/** The client's request for the image, by its method. */
function asked(method: string): Request {
  return new Request('https://app.example/_next/image?url=x&w=64&q=75', { method });
}

function redirect(location: string): Response {
  return new Response(null, { status: HTTP_FOUND, headers: { location } });
}

interface FakeNetwork {
  readonly fetched: Request[];
  readonly fetchImpl: typeof fetch;
}

/** A network answering by pathname, recording what was asked of it. */
function network(answers: readonly (readonly [string, () => Response])[]): FakeNetwork {
  const fetched: Request[] = [];
  const byPathname = new Map(answers);
  const fetchImpl: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    fetched.push(request);
    const answer = byPathname.get(new URL(request.url).pathname);
    return Promise.resolve(answer === undefined ? new Response('lost', { status: 404 }) : answer());
  };
  return { fetched, fetchImpl };
}

function body(bytes: Uint8Array): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

/** The remote source `https://cdn.example/a.png`, fetched over `net` under `images`. */
function remote(net: FakeNetwork, images = IMAGES) {
  return fetchRemoteSource({
    href: 'https://cdn.example/a.png',
    images,
    ownHosts: OWN_HOSTS,
    fetchImpl: net.fetchImpl,
  });
}

describe('publication-tagged optimized image sources', () => {
  it('retains a shipped image source snapshot through optimization and final v3 admission', async () => {
    const id = 'a'.repeat(64);
    const witness = `upwind:resource-snapshot:v1:${id}:4`;
    const tags = [
      `upwind:publication:v1:${id}:${String(Date.now() + 60_000)}`,
      'resource:image',
      witness,
    ];
    const required = {
      version: 3 as const,
      valueObservers: true as const,
      resourceSnapshots: true as const,
      identities: [id],
      routes: ['/image'],
    };
    const request = asked('GET');
    const runtime = { host: { publication: required } } as unknown as CacheRuntime;
    const context = requestContextFor({
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime,
      request,
      startedAt: Date.now(),
      waitUntil: vi.fn(),
      clock: undefined,
    });
    context.publicationRequirement = required;
    context.publicationReadStarted = true;
    const input: RoutedInput = {
      request,
      initURL: request.url,
      app: { entries: {} },
      edge: { entries: {} },
      cache: runtime,
      run: context.run,
      waitUntil: vi.fn(),
    };
    const rawSource = new Response(body(png()), {
      headers: { 'content-type': 'image/png', 'x-next-cache-tags': tags.join(',') },
    });
    const response = await context.run(async () => {
      const source = admitBuildSource(input, '/image', rawSource, tags);

      expect(context.resourceTags).toContain(witness);

      const derived = await sourceResponse({
        source,
        params: PARAMS,
        images: IMAGES,
        internal: true,
        request,
        publicationProtected: true,
      });
      return admitRequestPublication(derived, context);
    });

    expect(response.headers.get('x-next-cache-tags')).toContain(witness);
    expect(response.headers.get('x-next-cache-tags')).toContain('resource:image');
    await expect(response.arrayBuffer()).resolves.toHaveProperty(
      'byteLength',
      PNG_SIGNATURE.byteLength,
    );
  });

  it('keeps an independent source proof on its derived image through final admission', async () => {
    const required = {
      version: 2 as const,
      valueObservers: true as const,
      identities: ['a'.repeat(64)],
      routes: ['/image'],
      independentBuild: ['/image'],
    };
    const request = asked('GET');
    const runtime = { host: { publication: required } } as unknown as CacheRuntime;
    const context = requestContextFor({
      tables: { app: { entries: {} }, edge: { entries: {} } },
      runtime,
      request,
      startedAt: Date.now(),
      waitUntil: vi.fn(),
      clock: undefined,
    });
    context.publicationRequirement = required;
    context.publicationReadStarted = true;
    const source = new Response(body(png()), { headers: { 'content-type': 'image/png' } });
    markBuildPublication(source, required);
    const response = await context.run(async () => {
      const derived = await sourceResponse({
        source,
        params: PARAMS,
        images: IMAGES,
        internal: true,
        request,
        publicationProtected: true,
      });
      return admitRequestPublication(derived, context);
    });

    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).resolves.toHaveProperty(
      'byteLength',
      PNG_SIGNATURE.byteLength,
    );
  });

  it.each([1, 60_000])(
    'never keeps a protected image beyond its source grant (%s)',
    async (left) => {
      const source = new Response(body(png()), {
        headers: {
          'x-next-cache-tags': `upwind:publication:v1:${'a'.repeat(64)}:${String(Date.now() + left)}`,
          'cache-control': 'public,max-age=3600',
          etag: '"source"',
        },
      });
      const keep = vi.fn();
      const answer = await sourceResponse({
        source,
        params: PARAMS,
        images: IMAGES,
        internal: true,
        request: asked('GET'),
        keep,
      });

      expect(keep).not.toHaveBeenCalled();
      expect(answer.headers.get('cache-control')).toContain('no-store');
    },
  );
});

describe('the Worker’s own answer for an image source', () => {
  it('follows a remote source’s redirects up to the configured count, nothing forwarded', async () => {
    const net = network([
      ['/a.png', () => redirect('/b.png')],
      ['/b.png', () => redirect('https://cdn.example/c.png')],
      ['/c.png', () => new Response(body(png()))],
    ]);

    const result = await remote(net);

    expect(result.kind).toBe('ok');
    expect(result.response.status).toBe(HTTP_OK);
    expect(net.fetched.map((request) => request.url)).toStrictEqual([
      'https://cdn.example/a.png',
      'https://cdn.example/b.png',
      'https://cdn.example/c.png',
    ]);
    expect(net.fetched.every((request) => request.redirect === 'manual')).toBe(true);
    expect(net.fetched[0]?.headers.has('cookie')).toBe(false);
  });

  it('refuses a redirect past the count, in the optimizer’s words', async () => {
    const net = network([['/a.png', () => redirect('/a.png')]]);

    const result = await remote(net, {
      ...IMAGES,
      maximumRedirects: 1,
    });

    expect(result.kind).toBe('refused');
    expect(result.response.status).toBe(HTTP_LOOP_DETECTED);
    await expect(result.response.text()).resolves.toBe(UPSTREAM_INVALID);
    expect(net.fetched).toHaveLength(2);
  });

  it.each([
    ['back to this application', 'https://app.example/_next/image?url=%2Fa.png&w=64&q=75'],
    ['off the web', 'ftp://cdn.example/a.png'],
    ['to a local address', 'http://169.254.169.254/latest/a.png'],
  ])('refuses a redirect %s without following it', async (_label, location) => {
    const net = network([['/a.png', () => redirect(location)]]);

    const result = await remote(net);

    expect(result.kind).toBe('refused');
    expect(result.response.status).toBe(HTTP_BAD_REQUEST);
    expect(net.fetched).toHaveLength(1);
  });

  it('follows a redirect to a local address when the application allows one', async () => {
    const net = network([
      ['/a.png', () => redirect('http://127.0.0.1/b.png')],
      ['/b.png', () => new Response(body(png()))],
    ]);
    const allowing = { ...IMAGES, dangerouslyAllowLocalIP: true };

    const result = await remote(net, allowing);

    expect(result.kind).toBe('ok');
    expect(net.fetched.map((request) => request.url)).toStrictEqual([
      'https://cdn.example/a.png',
      'http://127.0.0.1/b.png',
    ]);
  });

  it('refuses a source larger than the configuration allows when it says so', async () => {
    const source = new Response(body(png()), {
      headers: { 'content-length': String(IMAGES.maximumResponseBody + 1) },
    });

    const response = await sourceResponse({
      source,
      params: PARAMS,
      images: IMAGES,
      internal: false,
      request: asked('GET'),
    });

    expect(response.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    await expect(response.text()).resolves.toBe(UPSTREAM_INVALID);
  });

  /** Read whole before anything is answered, as the edge reads one: no 200 cut short. */
  it('refuses a source that runs past the size without having said so', async () => {
    const source = new Response(body(png(IMAGES.maximumResponseBody + KIB)));

    const response = await sourceResponse({
      source,
      params: PARAMS,
      images: IMAGES,
      internal: false,
      request: asked('GET'),
    });

    expect(response.status).toBe(HTTP_PAYLOAD_TOO_LARGE);
    await expect(response.text()).resolves.toBe(UPSTREAM_INVALID);
  });

  it('answers HEAD with the optimizer’s headers and no body', async () => {
    const bytes = png(2 * KIB);

    const head = await sourceResponse({
      source: new Response(body(bytes), { headers: { 'cache-control': 'public, max-age=600' } }),
      params: PARAMS,
      images: IMAGES,
      internal: false,
      request: asked('HEAD'),
    });
    const get = await sourceResponse({
      source: new Response(body(bytes)),
      params: PARAMS,
      images: IMAGES,
      internal: false,
      request: asked('GET'),
    });
    const got = new Uint8Array(await get.arrayBuffer());

    expect(head.status).toBe(HTTP_OK);
    expect(head.headers.get('content-type')).toBe('image/png');
    expect(head.headers.get('cache-control')).toBe('public, max-age=600, must-revalidate');
    expect(head.body).toBeNull();
    expect(head.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(got).toStrictEqual(bytes);
    expect(get.headers.get('content-disposition')).toBe('attachment; filename="a.png"');
  });

  it('refuses what is not an image in the optimizer’s words', async () => {
    const html = body(encodeUtf8('<!doctype html>'));
    const response = await sourceResponse({
      source: new Response(html),
      params: PARAMS,
      images: IMAGES,
      internal: false,
      request: asked('GET'),
    });

    expect(response.status).toBe(HTTP_BAD_REQUEST);
    await expect(response.text()).resolves.toBe("The requested resource isn't a valid image.");
  });
});
