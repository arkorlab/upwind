import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
 *
 * A types package pnpm installed travels under the name TypeScript looks for it by. pnpm keeps its
 * files in its store (`node_modules/.pnpm/@types+node@…/node_modules/@types/node`) and links
 * `node_modules/@types/node` to them, and a trace through that link lists the stored files and the
 * link itself. The Function's file system has no links, and TypeScript finds an `@types` package
 * only by walking `node_modules/@types` directories, so the stored declarations go up under the
 * link's path instead (`linkTypes`).
 */
export interface TracedFile {
  /** Its path under `/bundle`: project-relative data, or repository-relative declarations. */
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
const TYPES_SCOPE = '@types';
/** Where a types package is linked: `node_modules/@types/<name>`, at any depth. */
const TYPES_LINK = /(?:^|\/)node_modules\/@types\/(?<name>[^./][^/]*)$/u;
/** pnpm's virtual store: a package there is reached only through the links pnpm makes to it. */
const PNPM_STORE = '.pnpm';
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

/**
 * A name the Function's file system may hold a traced file under: relative, `/`-separated, with no
 * empty, `.` or `..` part, and outside the roots the adapter keeps for itself.
 */
function isVfsName(logical: string): boolean {
  const segments = logical.split('/');
  return (
    !path.isAbsolute(logical) &&
    !logical.includes('\\') &&
    !logical.includes(':') &&
    !CONTROL_CHARACTER.test(logical) &&
    segments.every((segment) => !['', '.', '..'].includes(segment)) &&
    !RESERVED_DECLARATION_ROOTS.has(segments[0] ?? '')
  );
}

function declarationRefusal(message: string): never {
  throw new AuditError(`@stayingupwind/adapter: unsafe traced declaration: ${message}`);
}

/** Whether the package manifest at `manifest` gives its package the name `name`. */
function isPackageNamed(manifest: string, name: string): boolean {
  const identity: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  return (
    typeof identity === 'object' &&
    identity !== null &&
    'name' in identity &&
    identity.name === name
  );
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

/** The repository the trace names paths from, as it was given and as it is on disk. */
interface Repository {
  readonly path: string;
  readonly real: string;
}

/** A traced `node_modules/@types/<name>` link, and the package directory it really leads to. */
interface TypesLink {
  readonly name: string;
  readonly target: string;
}

function repositoryOf(repoRoot: string): Repository | undefined {
  try {
    const resolved = path.resolve(repoRoot);
    return { path: resolved, real: realpathSync(resolved) };
  } catch {
    return undefined;
  }
}

/** `@types/<name>` for a trace's `…/node_modules/@types/<name>`: a directory TypeScript walks. */
function typesPackageOf(logical: string): string | undefined {
  const name = TYPES_LINK.exec(logical)?.groups?.['name'];
  return name !== undefined && isVfsName(logical) ? `${TYPES_SCOPE}/${name}` : undefined;
}

/**
 * The package a traced types link leads to, when the link is what its name says: a symlink inside
 * the repository, which the same name reaches from the repository too, onto a directory inside the
 * real repository that holds the types package of that name. Any other link is left out, as every
 * link always was: an npm alias (`"@types/react": "npm:types-react@…"`) keeps its stored name.
 */
function typesLinkOf(
  repository: Repository | undefined,
  logical: string,
  filePath: string,
): TypesLink | undefined {
  const name = typesPackageOf(logical);
  if (repository === undefined || name === undefined || !path.isAbsolute(filePath)) {
    return undefined;
  }
  try {
    if (!lstatSync(filePath).isSymbolicLink() || beneath(repository.path, filePath) === undefined) {
      return undefined;
    }
    const target = realpathSync(filePath);
    const manifest = path.join(target, 'package.json');
    return beneath(repository.real, target) !== undefined &&
      realpathSync(path.join(repository.path, logical)) === target &&
      realpathSync(manifest) === manifest &&
      isPackageNamed(manifest, name)
      ? { name: logical, target }
      : undefined;
  } catch {
    return undefined;
  }
}

/** A file's `/`-separated path in the package at `root`, unless a package nested there owns it. */
function ownPath(root: string, file: string): string | undefined {
  const relative = beneath(root, file);
  if (relative === undefined || relative === '') return undefined;
  const segments = relative.split(path.sep);
  return segments.includes(PACKAGES_DIR) ? undefined : segments.join('/');
}

/** The names a file takes under each traced types link whose package owns it. */
function linkedNames(links: ReadonlyMap<string, TypesLink>, physical: string): string[] {
  return [...links.values()].flatMap((link) => {
    const own = ownPath(link.target, physical);
    return own === undefined ? [] : [`${link.name}/${own}`];
  });
}

/** Whether `name` is the file's own path in pnpm's store, which only links lead to. */
function isStoredName(name: string, physical: string, repository: Repository): boolean {
  const segments = name.split('/');
  const stored = segments.some(
    (segment, at) => segment === PNPM_STORE && segments[at - 1] === PACKAGES_DIR,
  );
  return stored && beneath(repository.real, physical)?.split(path.sep).join('/') === name;
}

/**
 * Each traced declaration of a package a types link leads to, under the link's own path, where
 * TypeScript looks for it (`node_modules/@types/node/index.d.ts`) and beside the files its relative
 * references name. Its name in pnpm's store is dropped, since nothing in the Function reaches the
 * store: a store package is reached only through links, and the Function has none; TypeScript
 * resolves a reference beside the file it loaded; `typesVersions`, which could redirect one, is in
 * a `package.json`, which the Function never carries from `node_modules`; and a types package has
 * no code to name its own directory with. Kept, it would only double the package. A declaration
 * under any other name (a workspace package's own directory, which the application may read)
 * keeps that name too.
 */
function linkTypes(
  files: Map<string, TracedFile>,
  links: ReadonlyMap<string, TypesLink>,
  input: { projectDir: string; repoRoot: string; repository: Repository },
): void {
  if (links.size === 0) return;
  const linked: TracedFile[] = [];
  const stored: string[] = [];
  for (const file of files.values()) {
    if (!isDeclaration(file.name)) continue;
    const physical = realpathSync(file.filePath);
    const names = linkedNames(links, physical);
    for (const name of names) {
      linked.push(declarationFile(input.projectDir, input.repoRoot, name, file.filePath));
    }
    if (names.length > 0 && isStoredName(file.name, physical, input.repository)) {
      stored.push(file.name);
    }
  }
  for (const name of stored) files.delete(name);
  for (const file of linked) addDeclaration(files, file);
}

/** The data files the outputs on the Node.js runtime read, once each, in a stable order. */
export function tracedFiles(
  outputs: readonly { readonly runtime?: string; readonly assets: Record<string, string> }[],
  projectDir: string,
  distDir: string,
  repoRoot: string = projectDir,
): TracedFile[] {
  const paths = buildPaths(projectDir, distDir);
  const repository = repositoryOf(repoRoot);
  const files = new Map<string, TracedFile>();
  const links = new Map<string, TypesLink>();
  for (const output of outputs) {
    if (output.runtime === 'edge') {
      continue;
    }
    for (const [logical, filePath] of Object.entries(output.assets)) {
      collectFile(files, paths, { projectDir, distDir, repoRoot, logical, filePath });
      const link = typesLinkOf(repository, logical, filePath);
      if (link !== undefined) links.set(link.name, link);
    }
  }
  if (repository !== undefined) linkTypes(files, links, { projectDir, repoRoot, repository });
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
