import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { beneath, buildPaths, type BuildPaths } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import {
  type Asset,
  type Context,
  contextOf,
  isDeclaration,
  isPackageNamed,
  isVfsName,
  MANIFEST,
  type PackageLink,
  packageLinks,
  PACKAGES_DIR,
  storedIn,
} from './package-links.ts';

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
 * package carries (except explicitly traced declarations, and the manifest of a package held under
 * a link, below), nor anything `next build` wrote, with one further exception: those reach the
 * Function the ways they always have, or not at all.
 *
 * The exception is a file a server module refers to by URL — `new URL('./data.json',
 * import.meta.url)` — which Turbopack copies into the build output's `server/assets` and lists
 * among the output's `assets`, and which the module then reads through `node:fs` at the path the
 * Turbopack runtime resolves it to (`patches/turbopack-root.ts`). It is the application's file
 * under a name the build gave it, so it travels as the others do, under its path in the project.
 *
 * A package pnpm installed travels under the name TypeScript looks for it by. pnpm keeps its files
 * in its store (`node_modules/.pnpm/@types+node@…/node_modules/@types/node`) and links
 * `node_modules/@types/node` to them, and a trace through that link lists the stored files and the
 * link itself. The Function's file system has no links, and TypeScript finds a package only by
 * walking `node_modules` directories upward, so the stored declarations go up, with the package's
 * traced `package.json` (`linkTypes`), where TypeScript in the Function finds the package from
 * `/bundle` as TypeScript finds it from the project, and so does what each depends on, found as
 * TypeScript finds it from where the package really is (`packageLinks`, in `package-links.ts`).
 */
export interface TracedFile {
  /**
   * Its path under `/bundle`: project-relative data, repository-relative declarations, or a linked
   * package's file under the name the Function holds that package by (`PackageLink`).
   */
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
const SCOPED_PACKAGE_SEGMENTS = 2;
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
  if (!isPackageNamed(manifest, alias.name)) {
    declarationRefusal('package alias does not match its actual identity');
  }
}

/**
 * Assets name paths relative to the build's repository root. Admit a new declaration only if
 * that interpretation is proved here: its logical path from the declared repository resolves to
 * exactly the traced physical file, and the application stays within that repository.
 * Package-directory symlinks (including pnpm's) are allowed; escaping the real repository or the
 * actual package is not. Nothing is discovered or copied beyond the output's own trace.
 */
function declarationFile(
  projectDir: string,
  repoRoot: string,
  logical: string,
  filePath: string,
): TracedFile {
  if (!isDeclaration(logical) || !path.isAbsolute(filePath) || !isVfsName(logical)) {
    return declarationRefusal('noncanonical logical path');
  }
  const segments = logical.split('/');
  try {
    const project = path.resolve(projectDir);
    const repository = path.resolve(repoRoot);
    const realProject = realpathSync(project);
    const realRepository = realpathSync(repository);
    if (
      beneath(repository, project) === undefined ||
      beneath(realRepository, realProject) === undefined
    ) {
      return declarationRefusal('project escapes the declared repository');
    }
    const physical = realpathSync(filePath);
    if (
      beneath(repository, filePath) === undefined ||
      beneath(realRepository, physical) === undefined ||
      realpathSync(path.join(repository, logical)) !== physical ||
      !statSync(physical).isFile()
    ) {
      return declarationRefusal('logical path does not identify a file within the repository');
    }
    checkPackage(repository, segments, physical);
    return { name: logical, filePath };
  } catch (error) {
    if (error instanceof AuditError) throw error;
    return declarationRefusal('logical path or package identity cannot be verified');
  }
}

function collectFile(
  files: Map<string, TracedFile>,
  paths: BuildPaths,
  input: {
    projectDir: string;
    distDir: string;
    repoRoot: string;
    logical: string;
    filePath: string;
  },
): void {
  const { projectDir, distDir, repoRoot, logical, filePath } = input;
  const name = nameOf(projectDir, distDir, filePath, paths);
  if (name !== undefined) {
    if (!files.has(name)) files.set(name, { name, filePath });
    return;
  }
  if (!isDeclaration(filePath)) return;
  addDeclaration(files, declarationFile(projectDir, repoRoot, logical, filePath));
}

function addDeclaration(files: Map<string, TracedFile>, file: TracedFile): void {
  const previous = files.get(file.name);
  if (previous !== undefined && realpathSync(previous.filePath) !== realpathSync(file.filePath)) {
    declarationRefusal('one logical name identifies different physical files');
  }
  if (previous === undefined) files.set(file.name, file);
}

/** A file's `/`-separated path in the package at `root`, unless a package nested there owns it. */
function ownPath(root: string, file: string): string | undefined {
  const relative = beneath(root, file);
  if (relative === undefined || relative === '') return undefined;
  const segments = relative.split(path.sep);
  return segments.includes(PACKAGES_DIR) ? undefined : segments.join('/');
}

/** The name a file takes under each traced link whose package owns it, and the path proving it. */
function linkedNames(
  links: ReadonlyMap<string, PackageLink>,
  physical: string,
): { link: PackageLink; name: string; logical: string }[] {
  return [...links.values()].flatMap((link) => {
    const own = ownPath(link.target, physical);
    return own === undefined
      ? []
      : [{ link, name: `${link.name}/${own}`, logical: `${link.logical}/${own}` }];
  });
}

/** Each traced `package.json`, by where it really is. */
function manifestsOf(assets: readonly Asset[]): Map<string, string> {
  const manifests = new Map<string, string>();
  for (const [, filePath] of assets) {
    if (!path.isAbsolute(filePath) || path.basename(filePath) !== MANIFEST) continue;
    try {
      manifests.set(realpathSync(filePath), filePath);
    } catch {
      // A manifest that is not there is no package's.
    }
  }
  return manifests;
}

/**
 * Whether `name` is a file's own path in a package that only links lead to, as pnpm's store keeps
 * them, wherever its `virtualStoreDir` is (`storedIn`).
 */
function isStoredName(
  context: Context,
  file: { readonly name: string; readonly physical: string },
  owners: readonly PackageLink[],
): boolean {
  const real = beneath(context.repository.real, file.physical)?.split(path.sep).join('/');
  return real === file.name && owners.some((link) => storedIn(context, link.target) !== undefined);
}

/**
 * Each traced declaration of a package a link leads to, under the name the Function holds the
 * package by, where TypeScript looks for it (`node_modules/@types/node/index.d.ts`) and beside the
 * files its relative references name; the link's own path in the trace proves each. With them goes
 * the package's `package.json`, where the trace lists it: TypeScript takes the package's entry from
 * it, and from its `typesVersions` the declarations meant for an older compiler (`@types/node`
 * sends TypeScript 5.6 to `ts5.6/index.d.ts`). Its name in pnpm's store, wherever its
 * `virtualStoreDir` puts the store, is dropped, since nothing in the Function reaches the store: a
 * store package is reached only through links, and the Function has none; TypeScript resolves a
 * reference beside the file it loaded, and a dependency upward from it (`packageLinks`); and a
 * package's code is bundled, so no code names the store's directories. Kept, it would only double
 * the package. A declaration under any other name (a workspace package's own directory, which the
 * application may read) keeps that name too.
 */
function linkTypes(
  files: Map<string, TracedFile>,
  links: ReadonlyMap<string, PackageLink>,
  input: { projectDir: string; repoRoot: string; context: Context; assets: readonly Asset[] },
): void {
  if (links.size === 0) return;
  const linked: TracedFile[] = [];
  const stored: string[] = [];
  const carried = new Set<PackageLink>();
  for (const file of files.values()) {
    if (!isDeclaration(file.name)) continue;
    const physical = realpathSync(file.filePath);
    const names = linkedNames(links, physical);
    for (const { link, name, logical } of names) {
      declarationFile(input.projectDir, input.repoRoot, logical, file.filePath);
      linked.push({ name, filePath: file.filePath });
      carried.add(link);
    }
    const owners = names.map(({ link }) => link);
    if (isStoredName(input.context, { name: file.name, physical }, owners)) {
      stored.push(file.name);
    }
  }
  for (const name of stored) files.delete(name);
  for (const file of linked) addDeclaration(files, file);
  const manifests = manifestsOf(input.assets);
  for (const link of carried) {
    const manifest = manifests.get(path.join(link.target, MANIFEST));
    if (manifest !== undefined) {
      addDeclaration(files, { name: `${link.name}/${MANIFEST}`, filePath: manifest });
    }
  }
}

/** The data files the outputs on the Node.js runtime read, once each, in a stable order. */
export function tracedFiles(
  outputs: readonly { readonly runtime?: string; readonly assets: Record<string, string> }[],
  projectDir: string,
  distDir: string,
  repoRoot: string = projectDir,
): TracedFile[] {
  const paths = buildPaths(projectDir, distDir);
  const files = new Map<string, TracedFile>();
  const assets: Asset[] = outputs.flatMap((output) =>
    output.runtime === 'edge' ? [] : Object.entries(output.assets),
  );
  for (const [logical, filePath] of assets) {
    collectFile(files, paths, { projectDir, distDir, repoRoot, logical, filePath });
  }
  const context = contextOf(repoRoot, projectDir, assets);
  if (context !== undefined) {
    linkTypes(files, packageLinks(context, assets), { projectDir, repoRoot, context, assets });
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
