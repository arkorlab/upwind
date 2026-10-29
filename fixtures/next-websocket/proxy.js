import { NextResponse } from 'next/server';

export function proxy(request) {
  if (request.nextUrl.pathname === '/api/denied') {
    return new Response('not authorized', { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.set('x-upgrade-visits', String(Number(headers.get('x-upgrade-visits') ?? '0') + 1));
  const response = request.nextUrl.pathname === '/alias'
    ? NextResponse.rewrite(new URL(`${request.nextUrl.basePath}/api/native/rewritten`, request.url), { request: { headers } })
    : NextResponse.next({ request: { headers } });
  response.cookies.set('proxy-cookie', 'kept');
  return response;
}

export const config = { matcher: ['/api/:path*', '/alias'] };
