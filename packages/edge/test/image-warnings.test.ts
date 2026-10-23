import type { ImagesConfig } from '@stayingupwind/core/images';
import { concatBytes, encodeUtf8 } from '@stayingupwind/core/util';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withinBudget } from '../src/handlers/image-transform.ts';
import { createEdgeMemory } from '../src/memory/caches.ts';
import { serveFromPointer } from '../src/route.ts';
import { standaloneHost, standaloneRuntime } from '../src/standalone/index.ts';
import { pprDocument, seedSite } from './helpers/site.ts';

const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  dangerouslyAllowLocalIP: false,
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1_000_000,
  remotePatterns: [
    { protocol: 'https', hostname: String.raw`^(?:cdn\.site\.example)$`, pathname: '^.*$' },
  ],
  domains: [],
  localPatterns: [{ pathname: '^.*$' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};
const PNG = concatBytes([
  new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  encodeUtf8('source'),
]);
const OUTPUT = encodeUtf8('optimized');

async function serving(failed: boolean) {
  const site = await seedSite({ document: pprDocument(), images: CONFIG });
  const fetched: string[] = [];
  const fetchSource = (request: Request) => {
    fetched.push(request.url);
    return Promise.resolve(new Response(PNG));
  };
  const transform = vi.fn(async (body: ReadableStream<Uint8Array>) => {
    await new Response(body).arrayBuffer();
    if (failed) throw new Error('transform failed');
    return { contentType: 'image/webp', body: new Blob([OUTPUT]).stream() };
  });
  const runtime = standaloneRuntime(env, {
    memory: createEdgeMemory(() => Date.now()),
    fetchImpl: fetchSource,
    dispatchApp: (_script, request) => fetchSource(request),
    transformImage: transform,
  });
  const get = async (source: string) => {
    const query = new URLSearchParams({ url: source, w: '64', q: '75' });
    const request = new Request<unknown, IncomingRequestCfProperties>(
      `https://site.example/_next/image?${query.toString()}`,
      { headers: { accept: 'image/webp', 'sec-fetch-dest': 'image' } },
    );
    const ctx = createExecutionContext();
    const response = await serveFromPointer({
      request,
      url: new URL(request.url),
      env,
      ctx,
      runtime,
      host: standaloneHost(env),
      pointer: site.pointer,
      pointerMs: 0,
      privateDelivery: false,
      cspReportingPath: undefined,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    await waitOnExecutionContext(ctx);
    return { response, bytes };
  };
  return { get, fetched, transform };
}

function warnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {
    // Assertions read the structured line without printing test credentials.
  });
}

function sourcePath(remote: boolean) {
  const path = `/${crypto.randomUUID()}.png`;
  return remote ? `https://cdn.site.example${path}` : path;
}

describe('image source URLs in warnings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    'redacts transform warnings for remote=%s without changing the fetch',
    async (remote) => {
      const warn = warnings();
      const served = await serving(true);
      const path = sourcePath(remote);
      const { response, bytes } = await served.get(
        `${path}?signature=private-token#private-fragment`,
      );

      expect(response.status).toBe(200);
      expect(bytes).toStrictEqual(PNG);
      expect(served.fetched).toHaveLength(2);
      expect(
        served.fetched.every((href) => new URL(href).search === '?signature=private-token'),
      ).toBe(true);
      expect(warn.mock.calls).toStrictEqual([
        [
          JSON.stringify({
            level: 'warn',
            message: 'image transformation failed',
            href: path,
            detail: 'transform failed',
          }),
        ],
      ]);
    },
  );

  it.each([
    [
      'https://user:private-password@cdn.site.example/image.png?signature=private-token#private-fragment',
      'https://cdn.site.example/image.png',
    ],
    ['/image.png?signature=private-token#private-fragment', '/image.png'],
    ['https://cdn.site.example/image.png', 'https://cdn.site.example/image.png'],
    ['/image.png', '/image.png'],
  ])('redacts a failed result stream from %s', async (href, expected) => {
    const warn = warnings();
    const ended = vi.fn();
    const body = withinBudget(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('result unavailable'));
        },
      }),
      { runtime: { now: () => Date.now() }, budgetMs: 100, spentOnFirstPart: 0, href, ended },
    );

    await expect(new Response(body).arrayBuffer()).rejects.toThrow('result unavailable');
    expect(ended).toHaveBeenCalledExactlyOnceWith(0);
    expect(warn.mock.calls).toStrictEqual([
      [
        JSON.stringify({
          level: 'warn',
          message: 'image result stopped arriving',
          href: expected,
          detail: 'result unavailable',
        }),
      ],
    ]);
  });

  it.each([false, true])(
    'keeps successful remote=%s source queries distinct in the cache',
    async (remote) => {
      const warn = warnings();
      const served = await serving(false);
      const path = sourcePath(remote);
      const first = await served.get(`${path}?signature=first`);
      const second = await served.get(`${path}?signature=second`);
      const cached = await served.get(`${path}?signature=first`);

      for (const answer of [first, second, cached]) {
        expect(answer.response.status).toBe(200);
        expect(answer.bytes).toStrictEqual(OUTPUT);
      }

      expect(served.fetched.map((href) => new URL(href).search)).toStrictEqual([
        '?signature=first',
        '?signature=second',
      ]);
      expect(served.transform).toHaveBeenCalledTimes(2);
      expect(cached.response.headers.get('x-nextjs-cache')).toBe('HIT');
      expect(warn).not.toHaveBeenCalled();
    },
  );
});
