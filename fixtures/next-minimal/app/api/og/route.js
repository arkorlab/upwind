import { connection } from 'next/server';
import { ImageResponse } from 'next/og';

/**
 * `next/og` is where the `vercel-og` patch lands: Turbopack compiles the module into a chunk and
 * keeps its `import()` of the library's Node.js build external, and that external is what the
 * patch rewrites to the edge build.
 *
 * `connection()` first, so the build does not render the image: rendering one costs a font read
 * and a WebAssembly compile, and what the patch needs is the module in the graph, not a picture.
 */
export async function GET() {
  await connection();
  return new ImageResponse(
    (
      <div style={{ display: 'flex', fontSize: 48, width: '100%', height: '100%' }}>
        next-minimal
      </div>
    ),
    { width: 320, height: 160 },
  );
}
