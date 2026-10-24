import { describe, expect, it } from 'vitest';

import {
  CACHE_ROUTE_ESCAPED_HEADER,
  CACHE_ROUTE_HEADER,
  pathFromHeader,
  pathFromHeaders,
  pathHeaders,
  pathHeaderValue,
  PLATFORM_REQUEST_HEADERS,
  RESUME_PRERENDER_ESCAPED_HEADER,
  RESUME_PRERENDER_HEADER,
} from '../src/paas/protocol.ts';

/**
 * Next.js names a prerender by the characters its path reads as, and a header value is bytes: a
 * Japanese slug named in `x-arkor-prerender` as it is threw in `Headers` before the request left.
 */
describe('a path-like name in a header', () => {
  it.each(['/en/[orgSlug]', '/docs/_next/data/b/gssp.json'])(
    'goes as it is when it is plain visible ASCII: %s',
    (name) => {
      expect(pathHeaderValue(name)).toBe(name);
    },
  );

  it.each(['/記事', '/sticks & stones', '/100%25', '/%E8%A8', '/😀/x', ' /padded '])(
    'comes back whole, and fits in a header: %s',
    (name) => {
      const headers = new Headers();

      headers.set('x-name', pathHeaderValue(name));

      expect(pathFromHeader(headers.get('x-name'))).toBe(name);
    },
  );

  it('reads no header as no name, and an escape that is not one as it came', () => {
    expect(pathFromHeader(null)).toBeUndefined();
    expect(pathFromHeader('/%E8%A8')).toBe('/%E8%A8');
  });
});

/**
 * The edge and an application's Worker are deployed apart, and a Worker built before the escape
 * reads the plain header as it comes. A name a header can carry as it is still goes there so, the
 * escaped one beside it for a Worker that reads that; one no header can carry as it is goes
 * escaped alone, as nothing reached an older Worker for it before.
 */
describe('the two headers that name a path', () => {
  const PLAIN = 'x-name';
  const ESCAPED = 'x-name-escaped';

  function sent(name: string): Headers {
    return new Headers(pathHeaders(PLAIN, ESCAPED, name));
  }

  it.each(['/en/[orgSlug]', '/sticks & stones', '/café', '/100%25'])(
    'carry a name a header can hold as it is in the plain one too: %s',
    (name) => {
      const headers = sent(name);

      expect(headers.get(PLAIN)).toBe(name);
      expect(pathFromHeaders(headers, PLAIN, ESCAPED)).toBe(name);
    },
  );

  it.each(['/記事', '/😀/x'])('carry one no header can hold as it is escaped alone: %s', (name) => {
    const headers = sent(name);

    expect(headers.has(PLAIN)).toBe(false);
    expect(pathFromHeaders(headers, PLAIN, ESCAPED)).toBe(name);
  });

  it('read the plain header as it came from an edge that sends no escaped one', () => {
    const fromBefore = new Headers({ [PLAIN]: '/sticks & stones' });

    expect(pathFromHeaders(fromBefore, PLAIN, ESCAPED)).toBe('/sticks & stones');
    expect(pathFromHeaders(new Headers(), PLAIN, ESCAPED)).toBeUndefined();
  });

  it.each([
    [RESUME_PRERENDER_HEADER, RESUME_PRERENDER_ESCAPED_HEADER],
    [CACHE_ROUTE_HEADER, CACHE_ROUTE_ESCAPED_HEADER],
  ])('leave nothing of %s for the application to read', (plain, escaped) => {
    const headers = new Headers(pathHeaders(plain, escaped, '/café'));

    for (const name of PLATFORM_REQUEST_HEADERS) {
      headers.delete(name);
    }

    expect([...headers.keys()]).toStrictEqual([]);
  });
});
