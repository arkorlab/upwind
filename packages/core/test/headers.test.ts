import { describe, expect, it } from 'vitest';

import {
  filterShellResponseHeaders,
  filterStoredResponseHeaders,
  rewritePassthroughResponseHeaders,
  sanitizeContinuationHeaders,
  sanitizePassthroughHeaders,
} from '../src/request/headers.ts';

const ctx = {
  previewDomain: 'example.app',
  previewHost: 'site1.example.app',
  clientIp: '203.0.113.9',
};

function clientHeaders(): Headers {
  return new Headers({
    cookie: 'session=abc; __arkor_edge_bypass=1',
    'accept-encoding': 'br, gzip',
    accept: 'text/html',
    'user-agent': 'UA',
    rsc: '1',
    'next-router-state-tree': 'tree',
    'if-none-match': '"etag"',
    range: 'bytes=0-1',
    'next-resume': '1',
    'x-nextjs-data': '1',
    'x-forwarded-for': '1.1.1.1',
    'cf-connecting-ip': '2.2.2.2',
    connection: 'keep-alive',
  });
}

describe('sanitizeContinuationHeaders', () => {
  it('forces identity encoding and drops router, conditional and internal headers', () => {
    const out = sanitizeContinuationHeaders(clientHeaders(), ctx);

    expect(out.get('accept-encoding')).toBe('identity');
    expect(out.get('accept')).toContain('text/html');
    expect(out.get('cookie')).toBe('session=abc');
    expect(out.has('rsc')).toBe(false);
    expect(out.has('next-router-state-tree')).toBe(false);
    expect(out.has('if-none-match')).toBe(false);
    expect(out.has('range')).toBe(false);
    expect([
      out.has('next-resume'),
      out.has('x-nextjs-data'),
      out.has('cf-connecting-ip'),
      out.has('connection'),
    ]).toStrictEqual([false, false, false, false]);
  });

  /**
   * A client that could speak the host's own headers to a runtime could make it run only the
   * middleware, or resume a prerender of its choosing; the edge alone sets them, after this.
   */
  it('drops host headers a client sent and forwards the country the edge observed', () => {
    const headers = clientHeaders();
    headers.set('x-arkor-middleware', '1');
    headers.set('x-arkor-ip-country', 'XX');

    const out = sanitizeContinuationHeaders(headers, { ...ctx, clientCountry: 'JP' });
    const proxied = sanitizePassthroughHeaders(headers, ctx);

    expect(out.has('x-arkor-middleware')).toBe(false);
    expect(out.get('x-arkor-ip-country')).toBe('JP');
    expect(proxied.has('x-arkor-middleware')).toBe(false);
    expect(proxied.has('x-arkor-ip-country')).toBe(false);
  });

  it('sets the forwarding headers', () => {
    const out = sanitizeContinuationHeaders(clientHeaders(), ctx);

    expect(out.get('x-forwarded-host')).toBe(ctx.previewHost);
    expect(out.get('x-forwarded-proto')).toBe('https');
    expect(out.get('x-forwarded-for')).toBe(ctx.clientIp);
  });
});

describe('sanitizePassthroughHeaders', () => {
  it('keeps the router protocol, range and conditional headers', () => {
    const headers = clientHeaders();
    headers.set('origin', 'https://site1.example.app');
    const out = sanitizePassthroughHeaders(headers, ctx);

    expect(out.get('rsc')).toBe('1');
    expect(out.get('next-router-state-tree')).toBe('tree');
    expect(out.get('range')).toBe('bytes=0-1');
    expect(out.get('if-none-match')).toBe('"etag"');
    expect(out.get('accept-encoding')).toBe('br, gzip');
    expect(out.has('x-nextjs-data')).toBe(false);
  });

  it.each([
    'https://site1.example.app',
    'https://other.example',
    'http://site1.example.app',
    'https://site1.example.app:8443',
    'https://site1.example.app/path',
    'null',
  ])('preserves the Origin %s for the application’s own authorization check', (origin) => {
    const headers = new Headers({ origin });

    expect(sanitizePassthroughHeaders(headers, ctx).get('origin')).toBe(origin);
  });

  it('does not invent an Origin when the client supplies none', () => {
    expect(sanitizePassthroughHeaders(new Headers(), ctx).has('origin')).toBe(false);
  });

  /**
   * Next.js's Pages Router marks a prefetch it makes through a middleware with
   * `x-middleware-prefetch`, and Next.js leaves the header on the request: the server answers such
   * a prefetch without rendering. Every other `x-middleware-*` a client sends is still dropped.
   */
  it('keeps the middleware prefetch marker a client router sends, and no other of the prefix', () => {
    const out = sanitizePassthroughHeaders(
      new Headers({ 'x-middleware-prefetch': '1', 'x-middleware-set-cookie': 'forged=1' }),
      ctx,
    );

    expect(out.get('x-middleware-prefetch')).toBe('1');
    expect(out.has('x-middleware-set-cookie')).toBe(false);
  });
});

describe('filterShellResponseHeaders', () => {
  it('keeps allowlisted headers and drops the rest', () => {
    const out = filterShellResponseHeaders(
      new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'set-cookie': 'a=1',
        'cache-control': 'private',
        'x-nextjs-stale-time': '5',
        'x-frame-options': 'DENY',
        server: 'workerd',
        vary: 'rsc',
      }),
    );

    expect(out).toStrictEqual({
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      vary: 'rsc',
    });
  });

  /**
   * A speculation rule's prerender from another origin of the site is served the shell, and a
   * browser cancels it unless the document says it may be loaded so.
   */
  it('keeps the loading mode a document opts into', () => {
    const out = filterShellResponseHeaders(
      new Headers({
        'content-type': 'text/html',
        'supports-loading-mode': 'credentialed-prerender',
      }),
    );

    expect(out['supports-loading-mode']).toBe('credentialed-prerender');
  });
});

describe('filterStoredResponseHeaders', () => {
  it('keeps what a response replayed whole said for itself, and nothing of the one it went out as', () => {
    const out = filterStoredResponseHeaders(
      new Headers({
        'Content-Type': 'text/csv',
        'content-disposition': 'attachment; filename="feed.csv"',
        'access-control-allow-origin': '*',
        location: '/feed.csv',
        etag: '"v3"',
        'x-feed-version': '3',
        'set-cookie': 'visitor=1',
        'cache-control': 's-maxage=60, stale-while-revalidate=31535940',
        'content-length': '42',
        date: 'Tue, 22 Sep 2026 00:00:00 GMT',
        'transfer-encoding': 'chunked',
        'x-next-cache-tags': '_N_T_/api/feed',
        'x-nextjs-cache': 'MISS',
        'x-arkor-cache-outcome': 'committed',
      }),
    );

    expect(out).toStrictEqual({
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="feed.csv"',
      'access-control-allow-origin': '*',
      location: '/feed.csv',
      etag: '"v3"',
      'x-feed-version': '3',
    });
  });
});

describe('rewritePassthroughResponseHeaders', () => {
  /**
   * The tags a render was cached under are the host's to read: Next.js leaves them on the
   * response in minimal mode (`x-next-cache-tags`), and `next start` sends a client none.
   */
  it('keeps the cache tags Next.js leaves for the host off a relayed response', () => {
    const out = rewritePassthroughResponseHeaders(
      new Headers({
        'x-next-cache-tags': '_N_T_/layout,_N_T_/page,posts',
        'content-type': 'text/html; charset=utf-8',
      }),
      ctx,
    );

    expect(out.has('x-next-cache-tags')).toBe(false);
    expect(out.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('scopes cookies to the preview host and leaves a redirect alone', () => {
    const out = rewritePassthroughResponseHeaders(
      new Headers({
        'set-cookie': 's=1; Domain=site1.example.app; Path=/',
        location: 'https://site1.example.app/login?next=%2F',
        'transfer-encoding': 'chunked',
      }),
      ctx,
    );

    expect(out.get('set-cookie')).toBe('s=1; Path=/');
    expect(out.get('location')).toBe('https://site1.example.app/login?next=%2F');
    expect(out.has('transfer-encoding')).toBe(false);
  });

  /**
   * On a customer's own hostname nothing is translated, and a cookie the application scoped to
   * that domain keeps its scope: the session is meant for the sibling hosts too.
   */
  it("keeps a cookie's domain on a customer hostname within it", () => {
    const custom = { ...ctx, previewHost: 'www.customer.example' };
    const headers = new Headers({
      'set-cookie': 'session=1; Domain=.customer.example; Path=/; HttpOnly',
      location: 'https://www.customer.example/account',
    });

    const out = rewritePassthroughResponseHeaders(headers, custom);

    expect(out.get('set-cookie')).toBe('session=1; Domain=.customer.example; Path=/; HttpOnly');
    expect(out.get('location')).toBe('https://www.customer.example/account');
  });

  /** Nothing about a redirect is re-homed: the Worker was asked on the host the client used. */
  it.each([
    'http://site1.example.app/next',
    '//site1.example.app/next',
    'https://site1.example.app:8443/next?a=b#c',
    '//other.example/login',
    '/relative',
  ])('leaves the redirect %s as the application wrote it', (location) => {
    const headers = new Headers({ location, 'x-action-redirect': `${location};push` });

    const out = rewritePassthroughResponseHeaders(headers, ctx);

    expect(out.get('location')).toBe(location);
    expect(out.get('x-action-redirect')).toBe(`${location};push`);
  });
});
