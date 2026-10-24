import type { NextRequest } from 'next/server';

import { incrementEagerly } from '../../../src/add-instantiated.ts';
import { increment } from '../../../src/add.ts';

/**
 * The same WebAssembly call on the Node.js runtime. Next.js says nothing about this module in the
 * adapter's context — it arrives as a `.wasm` among the route's traced `assets`, and Turbopack's
 * loader reads it off disk, which a Worker has none of. The `wasm-loader` patch turns that read
 * into the module the Worker carries.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const input = Number.parseInt(request.nextUrl.searchParams.get('input') ?? '1', 10);
  return Response.json({
    input,
    value: await increment(input),
    eager: incrementEagerly(input),
  });
}
