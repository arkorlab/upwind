import { describe, expect, it } from 'vitest';

import type { ImagesConfig } from '../src/images/config.ts';
import { parseImageRequest } from '../src/images/params.ts';

/**
 * The optimizer's `url` parameter for a source of the application's own, checked as Next.js checks
 * it — and a path the URL parser cannot read refused in the words an absolute URL that does not
 * parse is (Sentry), where Next.js's own check would throw.
 */

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
  remotePatterns: [],
  domains: [],
  localPatterns: [{ pathname: '^.*$', search: '' }],
  dangerouslyAllowSVG: false,
  contentSecurityPolicy: "script-src 'none'; frame-src 'none'; sandbox;",
  contentDispositionType: 'attachment',
};

function parsed(url: string) {
  return parseImageRequest(new URLSearchParams({ url, w: '64', q: '75' }), 'image/webp', CONFIG);
}

describe('a source the application serves itself', () => {
  it('refuses a path the URL parser cannot read, rather than throwing', () => {
    expect(parsed(String.raw`/\ [`)).toStrictEqual({
      kind: 'invalid',
      errorMessage: '"url" parameter is invalid',
    });
  });

  it('takes a path it can read', () => {
    expect(parsed('/images/a.png')).toMatchObject({
      kind: 'ok',
      params: { href: '/images/a.png', isAbsolute: false },
    });
  });

  it('still refuses the optimizer as its own source', () => {
    expect(parsed('/_next/image?url=/a.png')).toStrictEqual({
      kind: 'invalid',
      errorMessage: '"url" parameter cannot be recursive',
    });
  });
});
