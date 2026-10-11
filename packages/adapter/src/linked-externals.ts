import { stat } from 'node:fs/promises';
import path from 'node:path';

import { type OutputChunk, type Plugin, rolldown } from 'rolldown';

import { bundled, type BundleTrace } from './dependencies.ts';
import { dynamicLoadsInChunk } from './dynamic-loads.ts';
import { externalsPlugin } from './patches/index.ts';
import { THROWING_GLOBALS } from './throwing-globals.ts';

/**
 * The packages a build leaves to the runtime as ES modules, carried as modules of the Function's own.
 *
 * Turbopack leaves some packages out of the server chunks — `serverExternalPackages`, and an ES
 * module package a Pages Router page imports — and links each under `.next/node_modules`, by its
 * name and a hash (`esm-package1-1bee965fe4e3c79d`). A chunk asks for a CommonJS one with a thunk
 * the bundler follows (`<context>.x(id, () => require(id))`); an ES module one it names to the
 * runtime (`<context>.y(id)`), whose `externalImport` hands the name to `import()`, and the Function
 * had no module of that name: every render of a page that imported one failed with "No such
 * module" (`esm-externals`).
 *
 * Each one a chunk names is bundled here as Node.js would have loaded it — resolved through the
 * link from the server chunks, under the `import` condition — into an ES module the Function carries
 * under that very name, which is what workerd's `import()` looks a bare name up by. An ES module of
 * its own rather than a part of `app.cjs`: a package may await at its top level, which a CommonJS
 * bundle cannot carry. A name with no link under `.next/node_modules` is not one of these, and is
 * left as it was.
 */

/** `a.y("esm-package1-1bee965fe4e3c79d/entry")`: the name a chunk imports a linked package by. */
const LINKED_IMPORT =
  // eslint-disable-next-line sonarjs/super-linear-regex -- run once per build over a chunk `next build` wrote, never over anything a request carries
  /[\w$]+\.y\("(?<id>(?:@[\w.-]+\/)?[\w.-]+-[0-9a-f]{16}(?:\/[^"\\]*)?)"\)/gu;

/** The names a chunk's code imports linked packages by, each once, in the order they appear. */
export function linkedImportsIn(code: string): string[] {
  const ids = new Set<string>();
  for (const match of code.matchAll(LINKED_IMPORT)) {
    const id = match.groups?.['id'];
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return [...ids];
}

/** Shared code between two of them, beside the modules named for what imports them. */
const SHARED_CHUNKS = '__linked/[name]-[hash].js';

/** The names the chunks import linked packages by, as each chunk is loaded into the app bundle. */
export function linkedImportsPlugin(onLinked: (id: string) => void): Plugin {
  return {
    name: 'arkor-linked-imports',
    transform: {
      filter: { id: /\/server\/chunks\/.*\.js$/u, code: /\.y\("/u },
      handler(code) {
        for (const id of linkedImportsIn(code)) {
          onLinked(id);
        }
        return null;
      },
    },
  };
}

/** The link a name is imported through: its package, `@scope/name-hash` or `name-hash`. */
function linkOf(id: string): string {
  const segments = id.split('/');
  return (id.startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1)).join('/');
}

async function isLinked(distDir: string, id: string): Promise<boolean> {
  try {
    await stat(path.join(distDir, 'node_modules', linkOf(id)));
    return true;
  } catch {
    return false;
  }
}

/** A module the Function carries, by the name its file was written under. */
function moduleOf(outDir: string, chunk: OutputChunk): { name: string; file: string } {
  return { name: chunk.fileName, file: path.join(outDir, chunk.fileName) };
}

export interface LinkedExternals {
  /** Each module the Function carries: the name it is imported by, and the file it was written to. */
  readonly modules: readonly { readonly name: string; readonly file: string }[];
  readonly trace: BundleTrace;
}

/**
 * The linked packages `ids` names, bundled as ES modules named by what the chunks import them by;
 * `undefined` when none of them is linked.
 */
export async function bundleLinkedExternals(input: {
  readonly distDir: string;
  readonly workDir: string;
  readonly kind: string;
  readonly ids: Iterable<string>;
}): Promise<LinkedExternals | undefined> {
  const named = new Set(input.ids);
  const linked: string[] = [];
  for (const id of named) {
    if (await isLinked(input.distDir, id)) {
      linked.push(id);
    }
  }
  if (linked.length === 0) {
    return undefined;
  }
  const externals = new Set<string>();
  const unresolved = new Set<string>();
  const outDir = path.join(input.workDir, `${input.kind}-linked`);
  await using bundle = await rolldown({
    // Where the runtime that imports them lives: Node.js resolves the name from there, up to the
    // link in `.next/node_modules`.
    cwd: path.join(input.distDir, 'server', 'chunks'),
    input: Object.fromEntries(linked.toSorted((a, b) => a.localeCompare(b)).map((id) => [id, id])),
    platform: 'node',
    plugins: [externalsPlugin((specifier) => externals.add(specifier))],
    transform: { define: { ...THROWING_GLOBALS, 'process.env.NODE_ENV': '"production"' } },
    // A module these packages name and nobody installed is left to fail as it would under
    // Node.js — at run time, when the import runs — rather than failing the build: the package
    // was loaded lazily before it was bundled here, and `esm-externals` guards an `import('fail')`
    // no request ever reaches. It is recorded all the same.
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT' && log.exporter !== undefined) {
        unresolved.add(log.exporter);
      }
    },
  });
  const { output } = await bundle.write({
    dir: outDir,
    format: 'esm',
    // The name the chunk imports, exactly: workerd finds a module by the name it was given.
    entryFileNames: '[name]',
    chunkFileNames: SHARED_CHUNKS,
    minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
    comments: { legal: false },
    sourcemap: false,
  });
  const chunks = output.filter((item): item is OutputChunk => item.type === 'chunk');
  return {
    modules: chunks.map((chunk) => moduleOf(outDir, chunk)),
    trace: {
      inputs: chunks.flatMap((chunk) =>
        Object.entries(chunk.modules).map(([file, module]) => bundled(file, module)),
      ),
      externals: [...externals],
      unresolved: [...unresolved],
      patches: [],
      stubs: [],
      wasmModules: [],
      dynamicLoads: chunks.flatMap((chunk) => dynamicLoadsInChunk(chunk)),
    },
  };
}
