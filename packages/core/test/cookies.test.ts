import { describe, expect, it } from 'vitest';

import {
  getCookieValue,
  parseCookieHeader,
  rewriteSetCookieForPreview,
  serializeCookieHeader,
  stripCookies,
} from '../src/request/cookies.ts';

describe('parseCookieHeader', () => {
  it('parses pairs and keeps raw values', () => {
    expect(parseCookieHeader('a=1; b=x=y; flag')).toStrictEqual([
      { name: 'a', value: '1' },
      { name: 'b', value: 'x=y' },
      { name: 'flag', value: '' },
    ]);
    expect(parseCookieHeader(null)).toStrictEqual([]);
  });

  it('strips and serialises', () => {
    expect(stripCookies('a=1; __arkor_edge_bypass=1; b=2', ['__arkor_edge_bypass'])).toBe(
      'a=1; b=2',
    );
    expect(stripCookies('__arkor_edge_bypass=1', ['__arkor_edge_bypass'])).toBeNull();
    expect(serializeCookieHeader([{ name: 'a', value: '1' }])).toBe('a=1');
    expect(getCookieValue('a=1; __vdpl=dpl_1', '__vdpl')).toBe('dpl_1');
  });
});

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

describe('rewriteSetCookieForPreview, by the host it answers on', () => {
  const preview = { previewDomain: 'example.app', previewHost: 'site1.example.app' };
  const own = { previewDomain: 'example.app', previewHost: 'www.customer.example' };

  /** Previews share one apex: no cookie is let out of its own host there. */
  it('removes the domain attribute, and only that, on a preview host', () => {
    expect(rewriteSetCookieForPreview('s=1; Domain=example.com; Path=/; HttpOnly', preview)).toBe(
      's=1; Path=/; HttpOnly',
    );
    expect(rewriteSetCookieForPreview('s=1; Domain=.example.app; Path=/', preview)).toBe(
      's=1; Path=/',
    );
    expect(rewriteSetCookieForPreview('s=1; Domain=site1.example.app', preview)).toBe('s=1');
  });

  /**
   * A site's own hostname is where the application runs for real: a domain it scoped the cookie
   * to, and that the hostname is in, is what it meant. One the hostname is not in would have the
   * browser drop the cookie, so it becomes host-only instead.
   */
  it.each([
    ['s=1; Domain=.customer.example; Path=/', 's=1; Domain=.customer.example; Path=/'],
    ['s=1; Domain=customer.example', 's=1; Domain=customer.example'],
    ['s=1; Domain=www.customer.example', 's=1; Domain=www.customer.example'],
    ['s=1; domain=WWW.Customer.Example; Secure', 's=1; domain=WWW.Customer.Example; Secure'],
    ['s=1; Domain=example.com; Path=/', 's=1; Path=/'],
    ['s=1; Domain=ww.customer.example', 's=1'],
    ['s=1; Domain=stomer.example', 's=1'],
    ['s=1; Domain=; Path=/', 's=1; Path=/'],
  ])("keeps a domain a site's own hostname is in: %s", (value, expected) => {
    expect(rewriteSetCookieForPreview(value, own)).toBe(expected);
  });
});
