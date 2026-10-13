import { describe, expect, it } from 'vitest';

import { rewriteSetCookieForPreview } from '../src/request/cookies.ts';

/**
 * A browser trims the whitespace around a `Set-Cookie` attribute's name and value (RFC 6265, section
 * 5.2): `Domain =example.com` and `domain= example.com` scope a cookie just as `Domain=example.com`
 * does, so each is judged as that one is.
 */
describe('rewriteSetCookieForPreview', () => {
  /** A preview host, under the apex all of them share, and a site's own hostname outside it. */
  const preview = { previewDomain: 'example.com', previewHost: 'site.example.com' };
  const own = { previewDomain: 'example.com', previewHost: 'www.example.net' };

  /** A domain on one preview host would send the cookie to every other one under the same apex. */
  it.each([
    ['s=1; Domain=example.com; Path=/', 's=1; Path=/'],
    ['s=1; Domain =example.com; Path=/', 's=1; Path=/'],
    ['s=1; domain= example.com; Path=/', 's=1; Path=/'],
    ['s=1; Domain = .example.com ; HttpOnly', 's=1; HttpOnly'],
    ['s=1;\tDOMAIN\t=\tsite.example.com', 's=1'],
  ])('removes the domain on a preview host, however it is spaced: %s', (value, expected) => {
    expect(rewriteSetCookieForPreview(value, preview)).toBe(expected);
  });

  /** A site's own hostname may share a cookie with the rest of its domain, as the origin meant. */
  it.each([
    ['s=1; Domain=example.net; Path=/', 's=1; Domain=example.net; Path=/'],
    ['s=1; Domain =example.net; Path=/', 's=1; Domain =example.net; Path=/'],
    ['s=1; domain= .example.net ; Secure', 's=1; domain= .example.net ; Secure'],
  ])("keeps a domain a site's own hostname is in, however it is spaced: %s", (value, expected) => {
    expect(rewriteSetCookieForPreview(value, own)).toBe(expected);
  });

  /** One the hostname is not in would have the browser drop the cookie: it becomes host-only. */
  it.each([
    ['s=1; Domain=example.org; Path=/', 's=1; Path=/'],
    ['s=1; Domain =example.org; Path=/', 's=1; Path=/'],
  ])(
    "removes a domain a site's own hostname is not in, however it is spaced: %s",
    (value, expected) => {
      expect(rewriteSetCookieForPreview(value, own)).toBe(expected);
    },
  );
});
