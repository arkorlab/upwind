import { mkdir, rm } from 'node:fs/promises';
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
 * `@stayingupwind/core` is bundled in: it is this adapter's own vocabulary, and a reader of the published
 * package has no reason to resolve it. `@stayingupwind/runtime` is not, and must not be — the adapter
 * resolves it to a *path* and hands that to the bundler that builds a Function, so it has to be a
 * package on disk rather than something inlined here.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = path.join(ROOT, 'dist');

const EXTERNAL = [
  // Resolved to a path and bundled into the Function, never imported here.
  '@stayingupwind/runtime',
  // The bundlers and parsers the adapter drives.
  // `rolldown` by pattern, not by name: `rolldown/parseAst` is a subpath, and inlining it drags
  // in the loader that finds rolldown's native binding — which then looks for it beside *this*
  // file and fails.
  /^rolldown(\/|$)/u,
  '@oxc-project/types',
  'jsonc-parser',
  // The source map readers, which are dependencies of their own rather than code of this package's.
  '@jridgewell/sourcemap-codec',
  '@jridgewell/trace-mapping',
  // The build this adapter is called by.
  'next',
];

async function main(): Promise<void> {
  await rm(OUT_DIR, { recursive: true, force: true });
  const build = await rolldown({
    input: {
      index: path.join(ROOT, 'src/index.ts'),
      'project-config': path.join(ROOT, 'src/project-config.ts'),
    },
    platform: 'node',
    external: [...EXTERNAL, /^node:/u],
  });
  const { output } = await build.write({
    dir: OUT_DIR,
    format: 'esm',
    entryFileNames: '[name].js',
    chunkFileNames: '[name]-[hash].js',
  });
  await build.close();
  for (const entry of output) {
    if (entry.type !== 'chunk' || !entry.isEntry) continue;
    const bytes = Buffer.byteLength(entry.code);
    console.log(
      `dist/${entry.fileName}: ${String(bytes)} bytes, ${String(output.length)} chunk(s)`,
    );
  }
  // These templates contain the private host/cache packages. An installed adapter copies the
  // finished JavaScript; a customer never has to install the host's workspace-only packages.
  const nativeDir = path.join(OUT_DIR, 'native');
  await mkdir(nativeDir, { recursive: true });
  for (const [name, source] of [
    ['server', path.join(ROOT, 'src/native/server.ts')],
    ['cache-worker', fileURLToPath(new URL('../../cache/src/native/worker.ts', import.meta.url))],
  ] as const) {
    await using native = await rolldown({
      input: source,
      platform: 'node',
      external: [/^node:/u],
      plugins: [
        {
          name: 'native-host-function',
          resolveId: (id) =>
            id === 'arkor:native-function' ? { id: './function.mjs', external: true } : null,
        },
      ],
      onLog(_level, log) {
        if (log.code === 'UNRESOLVED_IMPORT') throw new Error(log.message);
      },
    });
    await native.write({
      file: path.join(nativeDir, `${name}.mjs`),
      format: 'esm',
      codeSplitting: false,
    });
  }
}

await main();
