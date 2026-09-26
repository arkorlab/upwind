import path from 'node:path';

/**
 * The files an application reads through `node:fs` while it serves a request, as the build traced
 * them: `fs.readFileSync(path.join(process.cwd(), 'data.json'))` in a page, `package.json` in a
 * middleware. Next.js's file tracing finds such a read and lists the file among the output's
 * `assets`, beside the code the output loads, for a platform to ship in the function's bundle —
 * which is what `@vercel/nft` traces reads for. The Worker's code is bundled instead, and its
 * virtual file system holds only what is uploaded with it, at `/bundle`, which is where
 * `process.cwd()` points; a file missing there failed the render that read it.
 *
 * So each such file goes up as a module named by its path in the project, which is where the
 * application's own path to it lands. Code is not among them — it is bundled — nor is anything a
 * package carries, nor anything `next build` wrote: those reach the Worker the ways they always
 * have, or not at all.
 */
export interface TracedFile {
  /** The module's name, and so its path under `/bundle`: the file's path in the project. */
  readonly name: string;
  readonly filePath: string;
}

/** What the bundler reads, or the Worker cannot: never a file an application reads as data. */
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

/** `file` beneath `dir`, as a relative path; `undefined` when it is not beneath it. */
function beneath(dir: string, file: string): string | undefined {
  const relative = path.relative(dir, file);
  return relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
    ? undefined
    : relative;
}

function nameOf(projectDir: string, distDir: string, filePath: string): string | undefined {
  const relative = beneath(projectDir, filePath);
  if (relative === undefined || beneath(distDir, filePath) !== undefined) {
    return undefined;
  }
  const segments = relative.split(path.sep);
  if (segments.includes(PACKAGES_DIR) || NOT_DATA.has(path.extname(relative).toLowerCase())) {
    return undefined;
  }
  return segments.join('/');
}

/** The data files the outputs on the Node.js runtime read, once each, in a stable order. */
export function tracedFiles(
  outputs: readonly { readonly runtime?: string; readonly assets: Record<string, string> }[],
  projectDir: string,
  distDir: string,
): TracedFile[] {
  const files = new Map<string, TracedFile>();
  for (const output of outputs) {
    if (output.runtime === 'edge') {
      continue;
    }
    for (const filePath of Object.values(output.assets)) {
      const name = nameOf(projectDir, distDir, filePath);
      if (name !== undefined && !files.has(name)) {
        files.set(name, { name, filePath });
      }
    }
  }
  return [...files.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

/**
 * The module a file inside the project travels as: its path there, with `/` between segments,
 * which is where it is found under `/bundle`. `undefined` for a file outside the project.
 */
export function projectModuleName(projectDir: string, filePath: string): string | undefined {
  return beneath(projectDir, filePath)?.split(path.sep).join('/');
}

/**
 * The files the edge runtime's entries fetch as `blob:` assets (`EdgeEntry.inlineAssets`), as the
 * modules they travel as: under the build's output, where no other file of the application is
 * shipped from, and read by nothing but the fetch that asks for them (`edgeEntrySource`).
 */
export function inlineAssetFiles(
  entries: readonly { readonly inlineAssets: readonly { filePath: string }[] }[],
  projectDir: string,
): TracedFile[] {
  const files = new Map<string, TracedFile>();
  for (const entry of entries) {
    for (const { filePath } of entry.inlineAssets) {
      const name = projectModuleName(projectDir, filePath);
      if (name !== undefined && !files.has(name)) {
        files.set(name, { name, filePath });
      }
    }
  }
  return [...files.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}
