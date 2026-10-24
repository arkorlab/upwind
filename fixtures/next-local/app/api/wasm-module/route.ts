import type { NextRequest } from 'next/server';

import { increment } from '../../../src/add.ts';

/**
 * WebAssembly reached through `?module` and nothing else.
 *
 * Its own route, apart from `/api/wasm`, because how many ways a chunk imports a `.wasm` decides
 * what Turbopack's loader looks like: with one call site the helper that reads the file is
 * inlined as an anonymous expression, with two it is a named declaration. A build that only ever
 * saw the second shape had a `wasm-loader` patch that refused the first — which is the shape an
 * application that writes the documented `?module` import and nothing else actually produces.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const input = Number.parseInt(request.nextUrl.searchParams.get('input') ?? '1', 10);
  return Response.json({ input, value: await increment(input) });
}
