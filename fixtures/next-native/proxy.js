import { NextResponse } from 'next/server';

export function proxy(request) {
  if (request.nextUrl.pathname.startsWith('/rewrite/')) {
    return NextResponse.rewrite(
      new URL(request.nextUrl.pathname, process.env.UPWIND_NATIVE_CONTROL_ORIGIN),
    );
  }
  const response = NextResponse.next();
  response.headers.set('x-native-proxy', 'ran');
  return response;
}

export const config = { matcher: ['/ssr', '/native.txt', '/rewrite/:path*'] };
