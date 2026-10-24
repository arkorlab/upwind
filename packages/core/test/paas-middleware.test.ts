import { describe, expect, it } from 'vitest';

import {
  mergeMiddlewareResponseHeaders,
  middlewareApplies,
  readMiddlewareResponse,
} from '../src/paas/middleware.ts';

const REQUEST_URL = new URL('https://app.example.app/?utm=1');

function read(headers: Record<string, string>, status = 200) {
  return readMiddlewareResponse(
    new Response(null, { status, headers }),
    REQUEST_URL,
    new Headers({ accept: 'text/html', cookie: 'a=1' }),
  );
}

describe('readMiddlewareResponse', () => {
  it('continues on the same request when the middleware says next', () => {
    const result = read({ 'x-middleware-next': '1', 'set-cookie': 'locale=ja; Path=/' });

    expect(result.kind).toBe('continue');
    expect(result.kind === 'continue' && result.rewritten).toBe(false);
    expect(result.kind === 'continue' && result.url.href).toBe(REQUEST_URL.href);
    expect(result.kind === 'continue' && result.responseHeaders.get('set-cookie')).toBe(
      'locale=ja; Path=/',
    );
    expect(result.kind === 'continue' && result.requestHeaders.get('cookie')).toBe('a=1');
  });

  it('resolves a rewrite on the same origin and carries the query along', () => {
    const result = read({ 'x-middleware-rewrite': '/en?utm=1' });

    expect(result.kind).toBe('continue');
    expect(result.kind === 'continue' && result.rewritten).toBe(true);
    expect(result.kind === 'continue' && result.url.pathname).toBe('/en');
    expect(result.kind === 'continue' && result.url.search).toBe('?utm=1');
  });

  it('reports a rewrite to another origin instead of following it', () => {
    const result = read({ 'x-middleware-rewrite': 'https://elsewhere.example/x' });

    expect(result.kind).toBe('external-rewrite');
  });

  it('hands back a redirect and a whole response as the middleware answered', () => {
    const redirect = read({ location: '/ja' }, 307);
    const responded = read({ 'content-type': 'text/plain' });

    expect(redirect.kind).toBe('responded');
    expect(responded.kind).toBe('responded');
  });

  /**
   * A `Location` on a status that is not a redirect is not a redirect — but it is still the
   * middleware's own answer. Next.js's router (`server/lib/router-utils/resolve-routes.js`) skips
   * only the redirect treatment for it (no relativizing, no re-routing to that URL) and returns
   * `finished: true` with the middleware's `bodyStream` and status; the page underneath never
   * runs. Reading it as `continue` served the document or static file in place of a middleware's
   * own 401 or 403 that names a login page.
   */
  it('answers with a Location on a non-redirect status rather than routing to it', () => {
    const result = read({ location: '/ja', 'content-type': 'text/plain' }, 401);

    expect(result.kind).toBe('responded');
    expect(result.kind === 'responded' && result.response.status).toBe(401);
    expect(result.kind === 'responded' && result.response.headers.get('location')).toBe('/ja');
  });

  /**
   * The order is Next.js's: an external rewrite finishes the request before the `Location` is
   * read, and a `Location` finishes it before a same-origin rewrite or `x-middleware-next` is.
   */
  it('answers with a Location set alongside next or a rewrite, and follows an external one', () => {
    expect(read({ 'x-middleware-next': '1', location: '/login' }, 401).kind).toBe('responded');
    expect(read({ 'x-middleware-rewrite': '/en', location: '/login' }, 401).kind).toBe('responded');
    expect(
      read({ 'x-middleware-rewrite': 'https://elsewhere.example/x', location: '/login' }, 401).kind,
    ).toBe('external-rewrite');
  });

  /** The override list is the whole request header set afterwards; anything unlisted is gone. */
  it('keeps the cookies the middleware set for the render apart from both header sets', () => {
    const result = read({
      'x-middleware-next': '1',
      'set-cookie': 'session=abc; Path=/',
      'x-middleware-set-cookie': 'session=abc; Path=/',
    });

    expect(result.kind === 'continue' && result.setCookie).toBe('session=abc; Path=/');
    expect(result.kind === 'continue' && result.requestHeaders.has('x-middleware-set-cookie')).toBe(
      false,
    );
    expect(
      result.kind === 'continue' && result.responseHeaders.has('x-middleware-set-cookie'),
    ).toBe(false);
    expect(result.kind === 'continue' && result.responseHeaders.get('set-cookie')).toBe(
      'session=abc; Path=/',
    );
  });

  it('takes the render cookies from the middleware alone, never from the request', () => {
    const result = readMiddlewareResponse(
      new Response(null, { headers: { 'x-middleware-next': '1' } }),
      REQUEST_URL,
      new Headers({ 'x-middleware-set-cookie': 'forged=1' }),
    );

    expect(result.kind === 'continue' && result.setCookie).toBeUndefined();
  });

  /**
   * Next.js's router puts what a middleware answered with on the request it renders as well: a
   * `Content-Security-Policy` set with `NextResponse.next({ headers })` is how a page reads its nonce.
   */
  it('puts what the middleware answered with on the request as well, after the overrides', () => {
    const result = read({
      'x-middleware-next': '1',
      'content-security-policy': "script-src 'nonce-abc'",
      'x-middleware-override-headers': 'x-trace',
      'x-middleware-request-x-trace': 'from-override',
      'x-trace': 'answered',
      'accept-encoding': 'br',
      connection: 'keep-alive',
    });

    expect(result.kind === 'continue' && result.requestHeaders.get('content-security-policy')).toBe(
      "script-src 'nonce-abc'",
    );
    expect(result.kind === 'continue' && result.requestHeaders.get('x-trace')).toBe('answered');
    expect(result.kind === 'continue' && result.requestHeaders.has('accept-encoding')).toBe(false);
    expect(result.kind === 'continue' && result.requestHeaders.has('connection')).toBe(false);
    expect(
      result.kind === 'continue' && result.responseHeaders.get('content-security-policy'),
    ).toBe("script-src 'nonce-abc'");
  });

  it('replaces the request headers the middleware overrode', () => {
    const result = read({
      'x-middleware-next': '1',
      'x-middleware-override-headers': 'accept, x-locale',
      'x-middleware-request-accept': 'text/html',
      'x-middleware-request-x-locale': 'ja',
    });

    expect(result.kind === 'continue' && [...result.requestHeaders.entries()]).toStrictEqual([
      ['accept', 'text/html'],
      ['x-locale', 'ja'],
    ]);
    expect(result.kind === 'continue' && result.responseHeaders.has('x-locale')).toBe(false);
    expect(result.kind === 'continue' && result.responseHeaders.has('x-middleware-next')).toBe(
      false,
    );
  });
});

describe('middlewareApplies', () => {
  const matchers = [
    {
      sourceRegex: String.raw`^(?:\/((?!api\/|_next\/|.*\..*).*))(\.json)?[\/#\?]?$`,
      missing: [{ type: 'header' as const, key: 'x-prerender-revalidate' }],
    },
  ];

  function applies(path: string, headers: Record<string, string> = {}): boolean {
    return middlewareApplies(
      matchers,
      new URL(`https://app.example.app${path}`),
      new Headers(headers),
    );
  }

  it('matches the patterns Next.js compiled, with their conditions', () => {
    expect(applies('/')).toBe(true);
    expect(applies('/en/login')).toBe(true);
    expect(applies('/api/auth')).toBe(false);
    expect(applies('/_next/static/x.js')).toBe(false);
    expect(applies('/favicon.ico')).toBe(false);
    expect(applies('/', { 'x-prerender-revalidate': 'x' })).toBe(false);
  });

  /**
   * A matcher's conditions decide whether the application's own middleware runs at all, and the
   * length of a header is a visitor's to choose. Both forms are answered as Next.js answers
   * them however long the value: the whole-value attempt is never the one that is bounded
   * (`conditions.ts`).
   */
  it('runs the middleware for a `missing` value longer than the substring bound', () => {
    const guarded = [
      {
        sourceRegex: '^/private$',
        missing: [{ type: 'header' as const, key: 'x-skip', value: '^trusted$' }],
      },
    ];
    const asked = new URL('https://app.example.app/private');

    const skipping = (value: string): boolean =>
      middlewareApplies(guarded, asked, new Headers({ 'x-skip': value }));

    expect(skipping('trusted')).toBe(false);
    expect(skipping('other')).toBe(true);
    expect(skipping('a'.repeat(4097))).toBe(true);
  });

  /** And the positive form of the same: a very long bearer token still runs the middleware. */
  it('runs the middleware for a `has` value longer than the substring bound', () => {
    const guarded = [
      {
        sourceRegex: '^/private$',
        has: [{ type: 'header' as const, key: 'authorization', value: 'Bearer .*' }],
      },
    ];
    const asked = new URL('https://app.example.app/private');
    const bearing = (value: string): boolean =>
      middlewareApplies(guarded, asked, new Headers({ authorization: value }));

    expect(bearing('Bearer short')).toBe(true);
    expect(bearing('Basic short')).toBe(false);
    expect(bearing(`Bearer ${'t'.repeat(4097)}`)).toBe(true);
  });

  it('tries an escaped pathname again decoded, as @next/routing does', () => {
    const named = [{ sourceRegex: String.raw`^\/vercel copy\.svg[\/#\?]?$` }];

    expect(
      middlewareApplies(named, new URL('https://app.example.app/vercel copy.svg'), new Headers()),
    ).toBe(true);
    expect(
      middlewareApplies(named, new URL('https://app.example.app/vercel%20copy.svg'), new Headers()),
    ).toBe(true);
    expect(
      middlewareApplies(named, new URL('https://app.example.app/vercel%2'), new Headers()),
    ).toBe(false);
  });

  it('honours has conditions on headers, cookies, queries and hosts', () => {
    const conditioned = [
      {
        sourceRegex: '^/x$',
        has: [
          { type: 'cookie' as const, key: 'beta', value: 'on|yes' },
          { type: 'query' as const, key: 'v' },
          { type: 'host' as const, value: String.raw`app\.example\.app` },
        ],
      },
    ];
    const url = new URL('https://app.example.app/x?v=2');

    expect(middlewareApplies(conditioned, url, new Headers({ cookie: 'beta=yes' }))).toBe(true);
    expect(middlewareApplies(conditioned, url, new Headers({ cookie: 'beta=no' }))).toBe(false);
    expect(middlewareApplies(conditioned, url, new Headers())).toBe(false);
  });
});

describe('mergeMiddlewareResponseHeaders', () => {
  it('appends cookies, sets the rest and leaves the body headers alone', () => {
    const target = new Headers({ 'content-type': 'text/html', 'set-cookie': 'a=1' });

    mergeMiddlewareResponseHeaders(
      target,
      new Headers({
        'set-cookie': 'b=2',
        'x-robots-tag': 'noindex',
        'content-type': 'text/plain',
        'cache-control': 'public',
      }),
    );

    expect(target.getSetCookie()).toStrictEqual(['a=1', 'b=2']);
    expect(target.get('x-robots-tag')).toBe('noindex');
    expect(target.get('content-type')).toBe('text/html');
    expect(target.has('cache-control')).toBe(false);
  });
});
