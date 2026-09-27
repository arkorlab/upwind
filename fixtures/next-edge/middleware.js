import { NextResponse } from 'next/server';

// The deprecated `middleware`, which is built for the edge runtime: it goes into both Functions'
// edge bundles rather than being a module either of them can require.
import add from './wasm/add.wasm?module';

export const config = {
  matcher: '/edge/:path*',
};

export default async function middleware(request) {
  const instance = await WebAssembly.instantiate(add, {});
  const response = NextResponse.next();
  response.headers.set('x-upwind-middleware-wasm', String(instance.exports.add(1, 2)));
  response.headers.set('x-upwind-middleware-path', new URL(request.url).pathname);
  return response;
}
