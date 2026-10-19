import { describe, expect, it } from 'vitest';

import { generationResponseHeaders } from '../src/cache/response-headers.ts';
import { SHARED_CACHE_CONTROL_HEADERS } from '../src/request/constants.ts';

const HTTP_OK = 200;

describe('stored route-body transformation policy', () => {
  it.each(SHARED_CACHE_CONTROL_HEADERS)(
    'retains the prohibition from %s without copying its sharing or freshness grants',
    (header) => {
      const headers: [string, string][] = [[header, 'public, s-maxage=3600, No-Transform']];
      const stored = generationResponseHeaders('app-route', HTTP_OK, headers);

      expect(stored['cache-control']).toBe('no-transform');
      expect(generationResponseHeaders('app-page', HTTP_OK, headers)).not.toHaveProperty(
        'cache-control',
      );
    },
  );

  it.each(SHARED_CACHE_CONTROL_HEADERS)(
    'preserves ordinary freshness while retaining the prohibition from %s',
    (header) => {
      const stored = generationResponseHeaders('app-route', HTTP_OK, [
        ['cache-control', 'public, max-age=60'],
        [header, 'no-transform'],
      ]);

      expect(stored['cache-control']).toBe('public, max-age=60, no-transform');
    },
  );

  it.each(['cache-control', ...SHARED_CACHE_CONTROL_HEADERS])(
    'retains %s no-transform even when a cookie forces the response private',
    (header) => {
      const stored = generationResponseHeaders('app-route', HTTP_OK, [
        [header, 'public, no-transform'],
        ['set-cookie', 'session=never-store-this'],
      ]);

      expect(stored['cache-control']).toBe('private, no-store, no-transform');
      expect(stored).not.toHaveProperty('set-cookie');
    },
  );

  it('does not duplicate an ordinary prohibition or treat extension names as directives', () => {
    expect(
      generationResponseHeaders('app-route', HTTP_OK, [
        ['cache-control', 'public, max-age=60, no-transform'],
        ['cloudflare-cdn-cache-control', 'no-transform'],
      ])['cache-control'],
    ).toBe('public, max-age=60, no-transform');
    expect(
      generationResponseHeaders('app-route', HTTP_OK, [
        ['cloudflare-cdn-cache-control', 'x-no-transform, extension="no-transform"'],
      ]),
    ).not.toHaveProperty('cache-control');
  });

  it('keeps a targeted privacy veto alongside its transformation prohibition', () => {
    const stored = generationResponseHeaders('app-route', HTTP_OK, [
      ['cdn-cache-control', 'private, no-transform'],
    ]);

    expect(stored['cache-control']).toBe('private, no-store, no-transform');
  });
});
