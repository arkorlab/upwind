import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

/**
 * The scaffolder as a published package reads: one JavaScript module with a hashbang, beside the
 * templates it copies.
 *
 * It has to be JavaScript for the reason `upwind`'s own build says: Node strips the types from a
 * `.ts` file only outside `node_modules`, and a copy installed from a registry — or run once by
 * `pnpm create` and thrown away — is inside one. `templates/` is not bundled and must not be: it is
 * data this copies, not code it runs, and `files` in the manifest is what ships it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'dist');

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  const build = await rolldown({
    input: path.join(ROOT, 'src/cli.ts'),
    platform: 'node',
    external: [/^node:/u],
  });
  // No `banner`: the hashbang is `src/cli.ts`'s own and Rolldown carries it to the top of the bundle.
  const { output } = await build.write({
    dir: OUT_DIR,
    format: 'esm',
    entryFileNames: 'cli.js',
    chunkFileNames: '[name]-[hash].js',
  });
  await build.close();
  const [entry] = output;
  const bytes = Buffer.byteLength(entry.code);
  console.log(`dist/cli.js: ${String(bytes)} bytes, ${String(output.length)} chunk(s)`);
}

await main();
