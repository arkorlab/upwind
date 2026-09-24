import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

/**
 * The adapter as a published package reads: one JavaScript module.
 *
 * `next build` loads the adapter through `adapterPath` or `NEXT_ADAPTER_PATH`, which means **Node**
 * loads it — and Node strips the types from a `.ts` file only outside `node_modules`. So a copy
 * installed from a registry has to be JavaScript, where a copy linked from a workspace can stay
 * the sources it is.
 *
 * `@upwind/core` is bundled in: it is this adapter's own vocabulary, and a reader of the published
 * package has no reason to resolve it. `@upwind/runtime` is not, and must not be — the adapter
 * resolves it to a *path* and hands that to the bundler that builds a Worker, so it has to be a
 * package on disk rather than something inlined here.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'dist');

const EXTERNAL = [
  // Resolved to a path and bundled into the Worker, never imported here.
  '@upwind/runtime',
  // The bundlers and parsers the adapter drives, and the schema library it validates with.
  // `rolldown` by pattern, not by name: `rolldown/parseAst` is a subpath, and inlining it drags
  // in the loader that finds rolldown's native binding — which then looks for it beside *this*
  // file and fails.
  'esbuild',
  /^rolldown(\/|$)/u,
  '@oxc-project/types',
  'jsonc-parser',
  'zod',
  // The build this adapter is called by.
  'next',
];

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  const build = await rolldown({
    input: path.join(ROOT, 'src/index.ts'),
    platform: 'node',
    external: [...EXTERNAL, /^node:/u],
  });
  const { output } = await build.write({
    dir: OUT_DIR,
    format: 'esm',
    entryFileNames: 'index.js',
    chunkFileNames: '[name]-[hash].js',
  });
  await build.close();
  const [entry] = output;
  const bytes = Buffer.byteLength(entry.code);
  console.log(`dist/index.js: ${String(bytes)} bytes, ${String(output.length)} chunk(s)`);
}

await main();
