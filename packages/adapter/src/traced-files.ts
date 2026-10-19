import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { beneath, buildPaths, type BuildPaths } from './build-paths.ts';
import { AuditError } from './dependencies.ts';

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
 * package carries (except explicitly traced declarations), nor anything `next build` wrote, with
 * one further exception: those reach the Function the ways they always have, or not at all.
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
const DECLARATION = /\.d\.(?:ts|mts|cts)$/u;
const RESERVED_DECLARATION_ROOTS = new Set(['.arkor', '.upwind-build']);
const SCOPED_PACKAGE_SEGMENTS = 2;
// eslint-disable-next-line no-control-regex -- Reject control bytes in a traced VFS path rather than letting them name a module.
const CONTROL_CHARACTER = /[\u{0}-\u{1F}\u{7F}]/u;
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

/** A declaration is data only when this output explicitly traced its logical name. */
function isDeclaration(file: string): boolean {
  return DECLARATION.test(file.toLowerCase());
}

function declarationRefusal(message: string): never {
  throw new AuditError(`@stayingupwind/adapter: unsafe traced declaration: ${message}`);
}

/** The package alias in the logical path, including a pnpm store's final node_modules hop. */
function packageAlias(segments: readonly string[]): { name: string; path: string } | undefined {
  const at = segments.lastIndexOf(PACKAGES_DIR);
  if (at === -1) return undefined;
  const first = segments[at + 1];
  if (first === undefined) return declarationRefusal('missing package name');
  const count = first.startsWith('@') ? SCOPED_PACKAGE_SEGMENTS : 1;
  const end = at + 1 + count;
  const name = segments.slice(at + 1, end).join('/');
  if (name === '' || first === '.pnpm' || end >= segments.length) {
    return declarationRefusal('missing package declaration path');
  }
  return { name, path: segments.slice(0, end).join('/') };
}

function checkPackage(project: string, segments: readonly string[], file: string): void {
  const alias = packageAlias(segments);
  if (alias === undefined) return;
  const root = realpathSync(path.join(project, alias.path));
  const manifest = path.join(root, 'package.json');
  if (beneath(root, file) === undefined || realpathSync(manifest) !== manifest) {
    declarationRefusal('declaration escapes its package');
  }
  const identity: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (
    typeof identity !== 'object' ||
    identity === null ||
    !('name' in identity) ||
    identity.name !== alias.name
  ) {
    declarationRefusal('package alias does not match its actual identity');
  }
}

/**
 * Assets name paths relative to the build's repository root. Admit a new declaration only if
 * that interpretation is proved here: its logical path from this project resolves to exactly
 * the traced physical file. A differently rooted monorepo needs an explicit root contract.
 * Package-directory symlinks (including pnpm's) are allowed; escaping the real project or the
 * actual package is not. Nothing is discovered or copied beyond the output's own trace.
 */
function declarationFile(projectDir: string, logical: string, filePath: string): TracedFile {
  const segments = logical.split('/');
  if (
    !isDeclaration(logical) ||
    !path.isAbsolute(filePath) ||
    path.isAbsolute(logical) ||
    logical.includes('\\') ||
    logical.includes(':') ||
    CONTROL_CHARACTER.test(logical) ||
    segments.some((segment) => ['', '.', '..'].includes(segment)) ||
    RESERVED_DECLARATION_ROOTS.has(segments[0] ?? '')
  ) {
    return declarationRefusal('noncanonical logical path');
  }
  try {
    const project = path.resolve(projectDir);
    const realProject = realpathSync(project);
    const physical = realpathSync(filePath);
    if (
      beneath(project, filePath) === undefined ||
      beneath(realProject, physical) === undefined ||
      realpathSync(path.join(project, logical)) !== physical ||
      !statSync(physical).isFile()
    ) {
      return declarationRefusal('logical path does not identify a file within the project');
    }
    checkPackage(project, segments, physical);
    return { name: logical, filePath };
  } catch (error) {
    if (error instanceof AuditError) throw error;
    return declarationRefusal('logical path or package identity cannot be verified');
  }
}

function collectFile(
  files: Map<string, TracedFile>,
  paths: BuildPaths,
  input: { projectDir: string; distDir: string; logical: string; filePath: string },
): void {
  const { projectDir, distDir, logical, filePath } = input;
  const name = nameOf(projectDir, distDir, filePath, paths);
  if (name !== undefined) {
    if (!files.has(name)) files.set(name, { name, filePath });
    return;
  }
  if (!isDeclaration(filePath)) return;
  const file = declarationFile(projectDir, logical, filePath);
  const previous = files.get(file.name);
  if (previous !== undefined && realpathSync(previous.filePath) !== realpathSync(file.filePath)) {
    declarationRefusal('one logical name identifies different physical files');
  }
  if (previous === undefined) files.set(file.name, file);
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
    for (const [logical, filePath] of Object.entries(output.assets)) {
      collectFile(files, paths, { projectDir, distDir, logical, filePath });
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
