import path from 'node:path';

import { type Patch, Rewrite } from './types.ts';

/**
 * `[turbopack]_runtime.js` loads a server chunk with `require(path.resolve(RUNTIME_ROOT,
 * chunkPath))`. workerd's CommonJS loader resolves only the names in the bundle, and a bundler
 * cannot follow a computed path either, so the resolution becomes a static table from chunk path
 * to `require` of the chunk's file: what the bundler bundles, and what the Function can load.
 *
 * Two runtimes come out of a build — `chunks/[turbopack]_runtime.js` for the instrumentation
 * hook and the middleware, `chunks/ssr/[turbopack]_runtime.js` for the app — and each has two
 * loading sites (chunks for a module, chunks for an entry).
 */

const NAME = 'turbopack-runtime';
const TARGET = /\[turbopack\]_runtime\.js$/u;
const LOAD_SITES = 2;
const CHUNK_REQUIRE =
  /const resolved = path\.resolve\(RUNTIME_ROOT, chunkPath\);\s*(?:\/\/[^\n]*\n\s*)*const chunkModules = require\(resolved\);/gu;
/**
 * A chunk require that survived, which is what this patch is about. Resolving against the root is
 * not itself one: 16.2's runtime resolves a `.wasm` against the same root in two more places, and
 * `runtime-wasm-loader` is what rewrites those. `require(resolved)` is the thing that would be
 * left, and the rewrite above already insists on how many there were.
 */
const LEFTOVERS = [/require\(resolved\)/u];

function chunkTable(distDir: string, chunks: readonly string[]): string {
  const cases = chunks.map(
    (chunk) =>
      `    case ${JSON.stringify(path.relative(distDir, chunk).split(path.sep).join('/'))}: return require(${JSON.stringify(chunk)});`,
  );
  return [
    '',
    'function __arkorRequireChunk(chunkPath) {',
    '  switch (chunkPath) {',
    ...cases,
    '  }',
    "  throw new Error('unknown server chunk ' + chunkPath);",
    '}',
    '',
  ].join('\n');
}

export const turbopackRuntimePatch: Patch = {
  name: NAME,
  target: TARGET,
  apply(source, file, ctx) {
    const rewrite = new Rewrite(NAME, file, source);
    if (ctx.chunks.length === 0) {
      throw rewrite.fail('no server chunks to load; the build has some');
    }
    const result = rewrite
      .replace(
        CHUNK_REQUIRE,
        'const chunkModules = __arkorRequireChunk(chunkPath);',
        LOAD_SITES,
        'the chunk loader',
      )
      .forbid(LEFTOVERS, 'a resolved chunk require')
      .append(chunkTable(ctx.distDir, ctx.chunks));
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`chunk table: ${ctx.chunks.length} entries`],
    };
  },
};
