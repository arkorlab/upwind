import path from 'node:path';

import { jsLiteral } from '../codegen.ts';
import { type Patch, Rewrite } from './types.ts';

/**
 * Where `[turbopack]_runtime.js` takes itself to be. It finds the build's output directory and the
 * project's root from its own file — `path.resolve(__filename, relativePathToRuntimeRoot)` and the
 * same with `relativePathToDistRoot` — and resolves against those what a server module names by
 * path at run time: a file it refers to by URL (`new URL('./data.json', import.meta.url)`, which
 * Turbopack writes under `server/assets` and hands back as a `file:` URL), and the `__dirname` and
 * `import.meta.url` it does not write into the code.
 *
 * In the Function the runtime is bundled into the Function's own module, and `__filename` is that
 * module's, at the top of the module tree: both roots came out as `/`, and a file referred to by
 * URL was read from `/server/assets/…`, where nothing is. What the Function carries for the
 * application to read is at `/bundle`, under its path in the project (`traced-files.ts`), so the
 * runtime is told that it is at its own path there. Loading a chunk or a WebAssembly module goes
 * through tables keyed by the path relative to the root (`turbopack-runtime.ts`,
 * `wasm-loader.ts`), so the roots are read for nothing else.
 *
 * The same two lines in every release `SUPPORTED_NEXT_RANGE` admits; each is held to one match.
 */

const NAME = 'turbopack-root';
const TARGET = /\[turbopack\]_runtime\.js$/u;
/** Where the Function's virtual file system holds what it carries (`store.ts` reads it there). */
const BUNDLE_ROOT = '/bundle';
const RUNTIME_ROOT = 'path.resolve(__filename, relativePathToRuntimeRoot)';
const ABSOLUTE_ROOT = 'path.resolve(__filename, relativePathToDistRoot)';
/** Anything else resolved against the runtime's own file would be a root this left behind. */
const LEFTOVERS = [/path\.resolve\(__filename\b/u];

export const turbopackRootPatch: Patch = {
  name: NAME,
  target: TARGET,
  // The runtime chunk `next build` writes; a published package holds nothing for this.
  reaches: ['build-output'],
  apply(source, file, ctx) {
    const at = jsLiteral(
      `${BUNDLE_ROOT}/${path.relative(ctx.projectDir, file).split(path.sep).join('/')}`,
    );
    const result = new Rewrite(NAME, file, source)
      .replace(
        RUNTIME_ROOT,
        `path.resolve(${at}, relativePathToRuntimeRoot)`,
        1,
        'the root of the build output',
      )
      .replace(
        ABSOLUTE_ROOT,
        `path.resolve(${at}, relativePathToDistRoot)`,
        1,
        'the root of the project',
      )
      .forbid(LEFTOVERS, "a root resolved against the runtime's own file");
    return {
      contents: result.contents,
      edits: result.edits,
      notes: [`runtime at ${at}`],
    };
  },
};
