import path from 'node:path';

import { beneath, buildPaths, type BuildPaths } from './build-paths.ts';

/**
 * The files an application reads through `node:fs` while it serves a request, as the build traced
 * them: `fs.readFileSync(path.join(process.cwd(), 'data.json'))` in a page, `package.json` in a
 * middleware. Next.js's file tracing finds such a read and lists the file among the output's
 * `assets`, beside the code the output loads, for a platform to ship in the function's bundle —
 * which is what `@vercel/nft` traces reads for. The Function's code is bundled instead, and its
 * virtual file system holds only what is uploaded with it, at `/bundle`, which is where
 * `process.cwd()` points; a file missing there failed the render that read it.
 *
 * So each such file goes up as a module named by its path in the project, which is where the
 * application's own path to it lands. Code is not among them — it is bundled — nor is anything a
 * package carries, nor anything `next build` wrote, with one exception: those reach the Function
 * the ways they always have, or not at all.
 *
 * The exception is a file a server module refers to by URL — `new URL('./data.json',
 * import.meta.url)` — which Turbopack copies into the build output's `server/assets` and lists
 * among the output's `assets`, and which the module then reads through `node:fs` at the path the
 * Turbopack runtime resolves it to (`patches/turbopack-root.ts`). It is the application's file
 * under a name the build gave it, so it travels as the others do, under its path in the project.
 */
export interface TracedFile {
  /** The module's name, and so its path under `/bundle`: the file's path in the project. */
  readonly name: string;
  readonly filePath: string;
}

/** What the bundler reads, or the Function cannot: never a file an application reads as data. */
const NOT_DATA = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.map',
  '.mjs',
  '.mts',
  '.node',
  '.ts',
  '.tsx',
  '.wasm',
]);
const PACKAGES_DIR = 'node_modules';
/** Where Turbopack writes a file a server module refers to by URL, beneath the build output. */
const SERVER_ASSETS_DIR = path.join('server', 'assets');

function nameOf(
  projectDir: string,
  distDir: string,
  filePath: string,
  paths: BuildPaths,
): string | undefined {
  const built = beneath(distDir, filePath);
  if (built !== undefined) {
    const asset = beneath(SERVER_ASSETS_DIR, built);
    if (asset === undefined || asset === '') return undefined;
    paths.assertDataFile(filePath);
    return paths.moduleName(filePath);
  }
  const relative = beneath(projectDir, filePath);
  if (relative === undefined || relative === '') {
    return undefined;
  }
  const segments = relative.split(path.sep);
  if (segments.includes(PACKAGES_DIR) || NOT_DATA.has(path.extname(relative).toLowerCase())) {
    return undefined;
  }
  return paths.moduleName(filePath);
}

/** The data files the outputs on the Node.js runtime read, once each, in a stable order. */
export function tracedFiles(
  outputs: readonly { readonly runtime?: string; readonly assets: Record<string, string> }[],
  projectDir: string,
  distDir: string,
): TracedFile[] {
  const paths = buildPaths(projectDir, distDir);
  const files = new Map<string, TracedFile>();
  for (const output of outputs) {
    if (output.runtime === 'edge') {
      continue;
    }
    for (const filePath of Object.values(output.assets)) {
      const name = nameOf(projectDir, distDir, filePath, paths);
      if (name !== undefined && !files.has(name)) {
        files.set(name, { name, filePath });
      }
    }
  }
  return [...files.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * The files the edge runtime fetches as `blob:` assets, under the same VFS names its generated
 * entry uses. An external build output uses the reserved mount rather than a parent path.
 */
export function inlineAssetFiles(
  entries: readonly { readonly inlineAssets: readonly { filePath: string }[] }[],
  projectDir: string,
  distDir: string,
): TracedFile[] {
  const paths = buildPaths(projectDir, distDir);
  const files = new Map<string, TracedFile>();
  for (const entry of entries) {
    for (const { filePath } of entry.inlineAssets) {
      paths.assertDataFile(filePath);
      const name = paths.moduleName(filePath);
      if (name !== undefined && !files.has(name)) {
        files.set(name, { name, filePath });
      }
    }
  }
  return [...files.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}
