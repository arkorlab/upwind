import { describe, expect, it } from 'vitest';

import { missesInPlainText } from '../../src/routing.ts';

/**
 * Which misses Next.js answers in plain text rather than with the not-found page: a file under
 * `_next/static`, wherever the application's base path and asset prefix put it. An application
 * with an `assetPrefix` loads its scripts from `<assetPrefix>/_next/static/…`, and Next.js answers
 * one that is not there as it answers one under `/_next/static/` (`router-server.ts` takes the
 * prefix off the path first); it was answered with the not-found page, a document no script tag
 * can use (`invalid-static-asset-404-app-asset-prefix`).
 */

interface Config {
  readonly basePath: string;
  readonly assetPrefix?: string;
}

function missesPlainly(pathname: string, config: Config): boolean {
  const url = new URL(`https://app.test${pathname}`);
  return missesInPlainText(new Request(url), url, config);
}

describe('a miss Next.js answers in plain text', () => {
  it('is of a file under `_next/static`, behind the base path and behind the asset prefix', () => {
    expect(missesPlainly('/_next/static/nothing.js', { basePath: '' })).toBe(true);
    expect(missesPlainly('/docs/_next/static/nothing.js', { basePath: '/docs' })).toBe(true);
    expect(
      missesPlainly('/assets/_next/static/nothing.js', { basePath: '', assetPrefix: '/assets' }),
    ).toBe(true);
  });

  /**
   * Next.js's rewrite for the prefix is matched against the path as it came, base path and all:
   * a prefix under the base path is taken off whole, where the base path taken off first left one
   * no prefix check could match.
   */
  it('is of a file behind an asset prefix under the base path, and one beside it', () => {
    const config = { basePath: '/docs', assetPrefix: '/docs/cdn' };

    expect(missesPlainly('/docs/cdn/_next/static/nothing.js', config)).toBe(true);
    expect(missesPlainly('/docs/_next/static/nothing.js', config)).toBe(true);
    expect(
      missesPlainly('/cdn/_next/static/nothing.js', { basePath: '/docs', assetPrefix: '/cdn' }),
    ).toBe(true);
    expect(missesPlainly('/docs/cdn/nothing', config)).toBe(false);
  });

  it('is not of a page, under the asset prefix or not', () => {
    const config = { basePath: '', assetPrefix: '/assets' };

    expect(missesPlainly('/assets/nothing', config)).toBe(false);
    expect(missesPlainly('/nothing', config)).toBe(false);
    expect(missesPlainly('/assets_next/static/nothing.js', config)).toBe(false);
  });
});
