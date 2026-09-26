import { NextResponse } from 'next/server';

/**
 * The middleware on the Node.js runtime (`proxy`, which replaced `middleware`). It becomes a
 * Function of its own, bundled from the same graph as the app's, so the matrix sees both.
 */
export function proxy(request) {
  const response = NextResponse.next();
  response.headers.set('x-upwind-fixture', new URL(request.url).pathname);
  return response;
}

export const config = {
  matcher: '/blog/:path*',
};
