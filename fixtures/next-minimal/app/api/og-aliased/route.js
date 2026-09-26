import { connection } from 'next/server';
import { ImageResponse } from '@vercel/og';

/**
 * The same `ImageResponse`, reached the other way. `next build` aliases `@vercel/og` to
 * `next/dist/server/og/image-response` (`create-compiler-aliases`) and Turbopack keeps that module
 * external, so the Function bundles the file itself — which is the one the
 * `vercel-og-image-response` patch rewrites. Through `next/og` the module is compiled into a chunk
 * instead and it is the external import inside it that is rewritten, by `vercel-og`. Both paths
 * ship, so the fixture takes both.
 */
export async function GET() {
  await connection();
  return new ImageResponse(
    (
      <div style={{ display: 'flex', fontSize: 48, width: '100%', height: '100%' }}>aliased</div>
    ),
    { width: 320, height: 160 },
  );
}
