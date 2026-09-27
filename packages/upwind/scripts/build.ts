import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rolldown } from 'rolldown';

/**
 * The CLI as a published package reads: one JavaScript module with a hashbang.
 *
 * It has to be JavaScript. Node strips the types from a `.ts` file only outside `node_modules`, and a
 * copy installed from a registry is inside one — where the sources a workspace links are not, which is
 * why `bin` names `src/cli.ts` here and `publishConfig.bin` names this output there.
 *
 * `@stayingupwind/core` is bundled in for the same reason: it is published as the TypeScript it is, so
 * an installed copy of this CLI could not import it at runtime. `next` is not bundled and must not be
 * — the whole point is that the Next.js a run drives is the project's own, resolved from the project
 * at startup.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'dist');

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  const build = await rolldown({
    input: path.join(ROOT, 'src/cli.ts'),
    platform: 'node',
    external: [/^next(\/|$)/u, /^node:/u],
  });
  // No `banner`: the hashbang is `src/cli.ts`'s own and Rolldown carries it to the top of the
  // bundle. Adding one as well makes two, which is a syntax error — and Rolldown answers that by
  // emitting the banner alone.
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
