import type { ImagesConfig } from '@stayingupwind/core/images';
import { buildProjectManifest } from '@stayingupwind/core/manifest';
import { DEFAULT_DELIVERY_POLICY } from '@stayingupwind/host/delivery';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeHostedImage, type HostedImageInput } from '../src/handlers/hosted-image.ts';
import { handleImage } from '../src/handlers/image.ts';
import type { MiddlewareContinued } from '../src/handlers/middleware.ts';
import type { EdgeContext } from '../src/strategies/context.ts';

vi.mock(import('../src/handlers/image.ts'), async (original) => {
  const module = await original();
  return { ...module, handleImage: vi.fn(() => Promise.resolve(new Response('optimized file'))) };
});

const SOURCE = '/_next/static/media/image.hash.png';
const CONFIG: ImagesConfig = {
  path: '/_next/image',
  basePath: '',
  sizes: [64],
  qualities: [75],
  formats: ['image/webp'],
  minimumCacheTTL: 60,
  maximumRedirects: 2,
  maximumResponseBody: 1024,
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$' }],
  dangerouslyAllowLocalIP: false,
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

function fixture(options: {
  href?: string;
  shipped?: boolean;
  shippedPathname?: string;
  gate?: 'middleware' | 'rewrite';
  protected?: boolean;
}) {
  const href = options.href ?? SOURCE;
  const manifest = buildProjectManifest({
    projectId: 'site',
    runId: 'run',
    originHost: 'site.test',
    generatedAt: '2026-11-05T00:00:00Z',
    deployment: { assetSetHash: 'a'.repeat(64), observedAt: '2026-11-05T00:00:00Z' },
    app: { deploymentId: 'deployment', scriptName: 'application' },
    routes: [],
    ...(options.protected !== false && {
      publication: { version: 1, identities: ['a'.repeat(64)], routes: ['/items'] },
    }),
    ...(options.shipped === true && {
      staticFiles: {
        [options.shippedPathname ?? href]: {
          sha256: 'b'.repeat(64),
          byteLength: 8,
          contentType: 'image/png',
          immutable: true,
        },
      },
    }),
  });
  if (options.gate === 'middleware')
    manifest.middleware = { matchers: [{ sourceRegex: '^/_next/static/media/' }] };
  else if (options.gate === 'rewrite')
    manifest.reservedRoutes = [{ sourceRegex: '^/_next/static/media/', beforeFiles: true }];
  const edge = {
    host: { credentials: { headers: [], cookies: [] }, names: {} },
    forwarding: { previewHost: 'site.test', previewDomain: 'invalid', clientIp: undefined },
    validated: false,
    app: { ...manifest.app, middlewareScriptName: 'middleware' },
    policy: DEFAULT_DELIVERY_POLICY,
    runtime: { now: () => 1_800_000_000_000 },
  } as unknown as EdgeContext;
  const request = new Request(
    `https://site.test/_next/image?url=${encodeURIComponent(href)}&w=64&q=75`,
  );
  const passthrough = vi.fn<HostedImageInput['passthrough']>(() =>
    Promise.resolve(new Response('current admitted source')),
  );
  return {
    manifest,
    request,
    edge,
    passthrough,
    render: () => {
      return routeHostedImage({
        request,
        url: new URL(request.url),
        edge,
        manifest,
        config: { ...CONFIG, domains: ['images.test'] },
        passthrough,
      });
    },
  };
}

function continued(value: Parameters<HostedImageInput['passthrough']>[1]): MiddlewareContinued {
  if (value?.kind !== 'continue') throw new Error('Expected a continued middleware handoff.');
  return value;
}

describe('protected image source selection at the edge', () => {
  afterEach(() => vi.clearAllMocks());

  it.each([
    { name: 'missing build file', shipped: false },
    {
      name: 'prefix lookalike',
      href: '/_next/static/media-private/avatar.png',
      shipped: true,
      shippedPathname: SOURCE,
    },
    { name: 'source middleware', shipped: true, gate: 'middleware' as const },
    { name: 'source rewrite', shipped: true, gate: 'rewrite' as const },
  ])('delegates $name before using the optimizer cache', async (options) => {
    const test = fixture(options);

    const response = await test.render();

    await expect(response.text()).resolves.toBe('current admitted source');
    expect(test.passthrough).toHaveBeenCalledTimes(1);
    expect(handleImage).not.toHaveBeenCalled();
  });

  it('retains the optimizer fast path for an actual ungated build file', async () => {
    const test = fixture({ shipped: true });

    const response = await test.render();

    await expect(response.text()).resolves.toBe('optimized file');
    expect(handleImage).toHaveBeenCalledTimes(1);

    const selected = vi.mocked(handleImage).mock.calls[0]![0];

    expect(selected.source).toMatchObject({ kind: 'blob', href: SOURCE, gate: 'none' });
    expect(test.passthrough).not.toHaveBeenCalled();
  });

  it('routes protected remote parameters and policy to the edge optimizer', async () => {
    const test = fixture({ href: 'https://images.test/avatar.png' });

    await expect((await test.render()).text()).resolves.toBe('optimized file');
    expect(handleImage).toHaveBeenCalledTimes(1);

    const selected = vi.mocked(handleImage).mock.calls[0]![0];

    expect(selected.params).toMatchObject({
      href: 'https://images.test/avatar.png',
      isAbsolute: true,
    });
    expect(selected.manifest.publication?.routes).toStrictEqual(['/items']);
    expect(test.passthrough).not.toHaveBeenCalled();
  });

  it('keeps the edge optimizer available for ordinary remote images', async () => {
    const test = fixture({ href: 'https://images.test/avatar.png', protected: false });

    await expect((await test.render()).text()).resolves.toBe('optimized file');
    expect(handleImage).toHaveBeenCalledTimes(1);
    expect(test.passthrough).not.toHaveBeenCalled();
  });

  it('preserves header rules selected before middleware when a protected source delegates', async () => {
    const test = fixture({ shipped: false });

    test.request.headers.set('x-visitor', 'original');

    test.manifest.dynamicRoutes = [];

    test.manifest.middleware = { matchers: [{ sourceRegex: '^/_next/image$' }] };

    test.manifest.headerRules = [
      {
        phase: 'beforeMiddleware',
        sourceRegex: '^/_next/image$',
        has: [{ type: 'header', key: 'x-visitor', value: 'original' }],
        headers: { 'x-chosen-for': 'original' },
      },
    ];

    const dispatch = vi.fn(() => {
      return Promise.resolve(
        new Response(null, {
          headers: {
            'x-middleware-next': '1',
            'x-middleware-override-headers': 'x-visitor',
            'x-middleware-request-x-visitor': 'changed',
          },
        }),
      );
    });
    Object.assign(test.edge.runtime, { dispatchApp: dispatch });

    await expect((await test.render()).text()).resolves.toBe('current admitted source');
    expect(dispatch).toHaveBeenCalledTimes(1);

    const handed = continued(test.passthrough.mock.calls[0]![1]);

    expect(handed.requestHeaders.get('x-visitor')).toBe('changed');
    expect(handed.judgedRules).toStrictEqual({
      headers: { 'x-chosen-for': 'original' },
      conditioned: true,
    });
    expect(handleImage).not.toHaveBeenCalled();
  });
});
