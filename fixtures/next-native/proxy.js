import { NextResponse } from 'next/server';

export function proxy() {
  const response = NextResponse.next();
  response.headers.set('x-native-proxy', 'ran');
  return response;
}

export const config = { matcher: ['/ssr', '/native.txt'] };
