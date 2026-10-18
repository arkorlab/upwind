import { NextResponse } from 'next/server';

import { snapshot, state } from './state.js';

export const config = { matcher: '/:path*' };

export function middleware(request) {
  state().handled += 1;
  if (request.nextUrl.pathname === '/throw') throw new Error('fixture middleware failure');
  return NextResponse.json(snapshot());
}
