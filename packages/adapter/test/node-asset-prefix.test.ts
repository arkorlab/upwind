import { describe, expect, it } from 'vitest';

import { manifestRuntimeAssetPrefix, nextClientAssetPrefix } from '../src/node-asset-prefix.ts';

describe('trusted Next.js compiler asset prefix', () => {
  it.each([
    [{}, '/_next/'],
    [{ basePath: '/docs' }, '/docs/_next/'],
    [{ basePath: '/docs///' }, '/docs/_next/'],
    [{ basePath: '/docs', assetPrefix: '' }, '/_next/'],
    [{ assetPrefix: 'https://cdn.example/assets///' }, 'https://cdn.example/assets/_next/'],
    [{ assetPrefix: '///' }, '/_next/'],
  ] as const)('matches the pinned computed prefix for %j', (config, expected) => {
    expect(nextClientAssetPrefix(config)).toBe(expected);
  });

  it.each(['app-page', 'pages', 'app-route', 'pages-api'] as const)(
    'keeps omitted trusted config optional for existing standalone %s proofs',
    (kind) => {
      expect(manifestRuntimeAssetPrefix(undefined, kind)).toBeUndefined();
    },
  );

  it.each([
    ['app-page', 'https://cdn.example/_next/'],
    ['pages', 'https://cdn.example/_next/'],
    ['app-route', '/'],
    ['pages-api', '/'],
  ] as const)('selects only the sealed %s producer profile', (kind, expected) => {
    expect(manifestRuntimeAssetPrefix('https://cdn.example/_next/', kind)).toBe(expected);
  });
});
