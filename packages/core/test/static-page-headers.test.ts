import { describe, expect, it } from 'vitest';

import {
  staticPageHeadersAllowSharing,
  staticPageHasNoTransform,
} from '../src/cache/static-pages.ts';

describe('static Pages sharing privacy before filtering', () => {
  it.each([
    ['Cache-Control', 'PRIVATE'],
    ['cache-control', 'public, no-store'],
    ['cache-control', 'private = "field"'],
    ['cdn-cache-control', 'no-store'],
    ['cloudflare-cdn-cache-control', 'private'],
    ['Set-Cookie', ''],
    ['content-range', 'bytes 0-1/2'],
    ['content-encoding', 'gzip'],
    ['content-type', 'application/xhtml+xml'],
    ['content-type', 'application/json'],
    ['Vary', '*'],
    ['Vary', 'Authorization'],
    ['Vary', 'Accept-Encoding, Cookie'],
    ['content-disposition', 'attachment'],
    ['location', '/elsewhere'],
    ['refresh', '0;url=/elsewhere'],
    ['clear-site-data', '"cookies"'],
    ['connection', 'cache-control'],
    ['connection', 'set-cookie'],
    ['connection', 'content-security-policy'],
    ['content-security-policy', "script-src 'nonce-secret'"],
    ['content-security-policy-report-only', "script-src 'nonce-{ppr}'"],
  ])('refuses %s=%s', (name, value) => {
    expect(staticPageHeadersAllowSharing([[name, value]])).toBe(false);
  });

  it('keeps static HTML content and encoding policy with no personal fields', () => {
    expect(
      staticPageHeadersAllowSharing([
        ['Content-Type', 'text/html; charset=utf-8'],
        ['Cache-Control', 'public, max-age=0, must-revalidate'],
        ['Vary', 'Accept-Encoding'],
        ['Content-Encoding', 'identity'],
        ['Content-Disposition', 'inline'],
        ['content-security-policy', "script-src 'self'"],
      ]),
    ).toBe(true);
    expect(staticPageHeadersAllowSharing([])).toBe(true);
  });
});

describe('static Pages transform prohibitions', () => {
  it.each(['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control'])(
    'retains %s prohibition without a public TTL grant',
    (name) => {
      const headers: [string, string][] = [[name, 'public, s-maxage=600, NO-TRANSFORM']];

      expect(staticPageHasNoTransform(headers)).toBe(true);
      expect(staticPageHeadersAllowSharing(headers)).toBe(true);
    },
  );

  it('does not mistake another directive or a different header value for the prohibition', () => {
    expect(
      staticPageHasNoTransform([
        ['cache-control', 'public, s-maxage=600'],
        ['x-policy', 'no-transform'],
      ]),
    ).toBe(false);
  });
});

describe('duplicate and whitespace policy fields', () => {
  it('keeps every original duplicate privacy veto before filtering', () => {
    expect(
      staticPageHeadersAllowSharing([
        ['Cache-Control', 'public'],
        ['cache-control', ' no-store = value'],
      ]),
    ).toBe(false);
  });
});
