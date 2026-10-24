import { type NextRequest, NextResponse } from 'next/server';

import { kv, published } from './lib/resources';

/**
 * What a middleware may do to a request, one of each: rewrite a path, rewrite one to a path that
 * has no page, send one to another origin, answer a redirect, set a cookie and a request header,
 * and let everything else through. And one thing it may read: the deployment's storage, which its
 * Worker is bound to as the application's is.
 */
export const config = {
  // Next.js evaluates this statically, so it has to be a plain string literal.
  // eslint-disable-next-line unicorn/prefer-string-raw -- a tagged template cannot be analysed.
  matcher: ['/((?!_next/|.*\\..*).*)'],
};

const PERMANENT_REDIRECT = 308;

/** Where a path goes on: `/home` to the front page, `/moved` to a page that does not exist. */
function rewritten(request: NextRequest, pathname: string, headers: Headers): NextResponse {
  if (pathname === '/home') {
    return NextResponse.rewrite(new URL('/', request.url), { request: { headers } });
  }
  if (pathname === '/moved') {
    const target = new URL(request.url);
    target.pathname = '/no/such/place';
    return NextResponse.rewrite(target, { request: { headers } });
  }
  return NextResponse.next({ request: { headers } });
}

/** The storage the middleware's Worker finds, and a key written and read back through it. */
async function resourcesSeen(): Promise<NextResponse> {
  const cache = kv('CACHE');
  await cache?.put('middleware', 'seen');
  return NextResponse.json({
    resources: Object.keys(published()?.resources ?? {}),
    kv: (await cache?.get('middleware')) ?? null,
  });
}

export function proxy(request: NextRequest): NextResponse | Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  // The one path that waits on anything; every other one is answered as it comes.
  if (pathname === '/resources-mw') {
    return resourcesSeen();
  }
  if (pathname === '/old') {
    return NextResponse.redirect(new URL('/static', request.url), PERMANENT_REDIRECT);
  }
  if (pathname.startsWith('/ext/')) {
    return NextResponse.rewrite(new URL(pathname.slice('/ext'.length), 'https://example.test'));
  }
  const headers = new Headers(request.headers);
  headers.set('x-proxied', '1');
  const response = rewritten(request, pathname, headers);
  response.cookies.set('seen', '1', { path: '/' });
  response.headers.set('x-from-proxy', '1');
  return response;
}
