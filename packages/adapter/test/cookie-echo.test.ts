import { createRequire } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { unsentCookieNames } from '../../host/src/splice/cookies.ts';

/**
 * The edge lets a resume repeat the cookies a middleware set on the shell (`@stayingupwind/host`,
 * `splice/cookies.ts`): Next.js hands them to the render and writes them back on its response. How
 * it writes them back is Next.js's to decide, so this asks the Next.js the repository builds with —
 * its own `NextResponse` for the middleware, its own request store for the render — and an upgrade
 * that writes them otherwise fails here, rather than sending a route's shell off the edge.
 */

interface MiddlewareCookies {
  set(name: string, value: string, options?: Record<string, unknown>): void;
  delete(name: string): void;
}

interface MiddlewareResponse {
  readonly headers: Headers;
  readonly cookies: MiddlewareCookies;
}

interface NextResponseClass {
  next(init?: { readonly headers?: Record<string, string> }): MiddlewareResponse;
}

type CreateRequestStore = (...args: unknown[]) => { readonly mutableCookies: unknown };

const require = createRequire(import.meta.url);
const { NextResponse } = require('next/dist/server/web/spec-extension/response.js') as {
  readonly NextResponse: NextResponseClass;
};
const { createRequestStoreForRender } =
  require('next/dist/server/async-storage/request-store.js') as {
    readonly createRequestStoreForRender: CreateRequestStore;
  };

const MIDDLEWARE_AT = Date.parse('2026-09-26T08:00:00.400Z');
/** A resume starts after the middleware ran, over a second boundary for `Expires` to move. */
const RESUMED_AT = MIDDLEWARE_AT + 1500;
const DAY_MS = 86_400_000;

/** What the render writes back of the cookies it was handed, as Next.js's request store does. */
function writtenBack(forwarded: string | null): string[] {
  if (forwarded === null) {
    return [];
  }
  let written: string[] = [];
  const store = createRequestStoreForRender(
    { headers: { 'x-middleware-set-cookie': forwarded } },
    undefined,
    { pathname: '/', search: '' },
    {},
    { tags: [] },
    (cookies: string[]) => {
      written = cookies;
    },
    undefined,
    false,
    undefined,
    null,
    null,
    undefined,
  );
  // What `cookies()` touches in a render that reads them.
  const touched = store.mutableCookies;
  return touched === undefined ? [] : written;
}

/**
 * The middleware's cookies as the visitor got them, what the render was handed of them, and what
 * the resume answers with.
 */
function resume(middleware: () => MiddlewareResponse): {
  readonly sent: string[];
  readonly handed: string;
  readonly set: string[];
} {
  vi.setSystemTime(MIDDLEWARE_AT);
  const response = middleware();
  const visitor = new Headers();
  for (const [name, value] of response.headers) {
    if (name !== 'x-middleware-set-cookie') {
      visitor.append(name, value);
    }
  }
  vi.setSystemTime(RESUMED_AT);
  const handed = response.headers.get('x-middleware-set-cookie');
  return { sent: visitor.getSetCookie(), handed: handed ?? '', set: writtenBack(handed) };
}

type Middleware = () => MiddlewareResponse;

/** A middleware that sets one cookie. */
function setting(name: string, value: string, options?: Record<string, unknown>): Middleware {
  return () => {
    const response = NextResponse.next();
    response.cookies.set(name, value, options);
    return response;
  };
}

/** A middleware that deletes one. */
function deleting(name: string): Middleware {
  return () => {
    const response = NextResponse.next();
    response.cookies.delete(name);
    return response;
  };
}

/** A middleware that passes a raw `Set-Cookie` of its own, and sets one beside it. */
function raw(): MiddlewareResponse {
  const response = NextResponse.next({ headers: { 'set-cookie': 'raw=1' } });
  response.cookies.set('b', '2');
  return response;
}

/** A middleware that appends a raw `Set-Cookie` after it set one: the render is not handed it. */
function rawAfter(): MiddlewareResponse {
  const response = setting('b', '2')();
  response.headers.append('set-cookie', 'raw=1');
  return response;
}

/**
 * A middleware that sets two, each written back otherwise than it was sent, the first with a date:
 * the header the render reads them from joins them with a comma, and the date has one of its own.
 */
function twoWithADate(): MiddlewareResponse {
  const response = NextResponse.next();
  response.cookies.set('next', '%2Faccount', { expires: new Date(MIDDLEWARE_AT + DAY_MS) });
  response.cookies.set('token', '', { maxAge: 0 });
  return response;
}

/** A middleware that sets one for the render only, taking it off the visitor's response. */
function renderOnly(): MiddlewareResponse {
  const response = setting('b', '2')();
  response.headers.delete('set-cookie');
  return response;
}

describe('the cookies a middleware set, as the render writes them back', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ['a plain one', setting('session', 'abc')],
    ['one with a lifetime', setting('seen', '1', { maxAge: 60 })],
    ['one cleared', setting('token', '', { maxAge: 0 })],
    ['one deleted', deleting('gone')],
    [
      'one with every attribute',
      setting('f', '1', {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        priority: 'High',
        partitioned: true,
        path: '/app',
        domain: 'Example.COM',
      }),
    ],
    ['one with a SameSite of true', setting('f', '1', { sameSite: true })],
    ['a value already encoded', setting('next', '%2Faccount')],
    ['a raw one beside a set one', raw],
    ['a raw one appended after a set one', rawAfter],
    ['two, the first with a date', twoWithADate],
  ])('lets the resume repeat %s', (_label, middleware) => {
    vi.useFakeTimers();
    const { sent, handed, set } = resume(middleware);

    expect(set.length).toBeGreaterThan(0);
    expect(unsentCookieNames(set, sent, handed)).toStrictEqual([]);
  });

  /**
   * The raw one names no path, so a browser keeps it under the directory of the page that set it
   * (RFC 6265, section 5.1.4), and the render writes it back with `Path=/`: below the root that is
   * another cookie, which the visitor never got.
   */
  it('refuses the raw one written back to the root from a page below it', () => {
    vi.useFakeTimers();
    const { sent, handed, set } = resume(raw);

    expect(unsentCookieNames(set, sent, handed, '/account/page')).toStrictEqual(['raw']);
    expect(unsentCookieNames(set, sent, handed, '/account')).toStrictEqual([]);
  });

  /**
   * A path the cookie names is read decoded, and written back so: `/a%2Fb` comes back as `/a/b`.
   * The browser keeps the two apart, so the copy is a cookie the visitor never got.
   */
  it('refuses a copy written back to the decoded path of the one sent', () => {
    vi.useFakeTimers();
    const { sent, handed, set } = resume(setting('a', 'b', { path: '/a%2Fb' }));

    expect(sent).toStrictEqual(['a=b; Path=/a%2Fb']);
    expect(set).toStrictEqual(['a=b; Path=/a/b']);
    expect(unsentCookieNames(set, sent, handed, '/a%2Fb/page')).toStrictEqual(['a']);
  });

  /** Every one written back is one the visitor got: nothing of the raw one comes back. */
  it('hands the render only what the middleware set through its cookies', () => {
    vi.useFakeTimers();
    const { sent, set } = resume(rawAfter);

    expect(sent).toStrictEqual(['b=2; Path=/', 'raw=1']);
    expect(set).toStrictEqual(['b=2; Path=/']);
  });

  it('still refuses a cookie the render was handed and the visitor never got', () => {
    vi.useFakeTimers();
    const { sent, handed, set } = resume(renderOnly);

    expect(sent).toStrictEqual([]);
    expect(unsentCookieNames(set, sent, handed)).toStrictEqual(['b']);
  });
});
