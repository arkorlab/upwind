import type { ImagesConfig } from '@stayingupwind/core/images';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openImageCache } from '../src/image-cache.ts';
import { serveImageSource } from '../src/image-serving.ts';
import type { RoutedInput } from '../src/serve.ts';
import type { Store } from '../src/store.ts';

vi.mock(import('../src/image-cache.ts'), () => ({ openImageCache: vi.fn() }));
vi.mock(import('../src/node-bridge.ts'), () => ({ invokeNodeHandler: vi.fn() }));

const IMAGES: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1024,
  remotePatterns: [],
  domains: ['site.test', 'site.test.', 'forwarded.test', 'external.test'],
  localPatterns: [{ pathname: '^.*$' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

function render(hostname: string): Promise<Response> {
  const source = `https://${hostname}/image.png`;
  const path = `/_next/image?url=${encodeURIComponent(source)}&w=64&q=75`;
  const request = new Request(`https://site.test${path}`, {
    headers: { 'x-forwarded-host': 'forwarded.test' },
  });
  const input: RoutedInput = {
    request,
    initURL: request.url,
    app: { entries: {} },
    edge: { entries: {} },
    waitUntil: vi.fn(),
    run: (work) => work(),
  };
  const store = { manifest: { deploymentId: 'deployment' } } as unknown as Store;
  return serveImageSource({
    input,
    store,
    images: IMAGES,
    routed: { resolved: { route: '/_next/image', pathname: '/_next/image', url: path } },
    routeSource: vi.fn(),
  });
}

describe('own-host image source admission before cache lookup', () => {
  afterEach(() => vi.resetAllMocks());

  it.each(['site.test', 'site.test.', 'forwarded.test'])(
    'rejects an existing cache hit for %s',
    async (host) => {
      vi.mocked(openImageCache).mockResolvedValue({
        hit: new Response('previously cached own-host data'),
        keep: undefined,
      });

      const response = await render(host);

      expect(response.status).toBe(400);
      expect(openImageCache).not.toHaveBeenCalled();
      await expect(response.text()).resolves.not.toContain('previously cached own-host data');
    },
  );

  it('keeps the existing external image cache hit path', async () => {
    vi.mocked(openImageCache).mockResolvedValue({
      hit: new Response('cached external image'),
      keep: undefined,
    });

    const response = await render('external.test');

    expect(openImageCache).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe('cached external image');
  });
});
