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
 * A types package pnpm installed travels under the name TypeScript looks for it by. pnpm keeps its
 * files in its store (`node_modules/.pnpm/@types+node@…/node_modules/@types/node`) and links
 * `node_modules/@types/node` to them, and a trace through that link lists the stored files and the
 * link itself. The Function's file system has no links, and TypeScript finds an `@types` package
 * only by walking `node_modules/@types` directories, so the stored declarations go up under the
 * link's path instead, with the package's traced `package.json` (`linkTypes`), and so do the
 * packages pnpm linked beside it in its store, which its own imports name (`linkDependencies`).
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
const PACKAGES_DIR = 'node_modules';
/** What TypeScript reads a package's entry and its `typesVersions` from. */
const MANIFEST = 'package.json';
const TYPES_SCOPE = '@types';
/** Where a types package is linked: `node_modules/@types/<name>`, at any depth. */
const TYPES_LINK = /(?:^|\/)node_modules\/@types\/(?<name>[^./][^/]*)$/u;
/** A package in a `node_modules` directory: `<directory>/<name>` or `<directory>/@scope/<name>`. */
const PACKAGE_ENTRY =
  /^(?<directory>(?:.+\/)?node_modules)\/(?<name>(?:@[^./][^/]*\/)?[^./@][^/]*)$/u;
/** pnpm's virtual store: a package there is reached only through the links pnpm makes to it. */
const PNPM_STORE = '.pnpm';
/** A package's own `node_modules` in pnpm's store, holding it and links to its dependencies. */
const PNPM_PACKAGES = /(?:^|\/)node_modules\/\.pnpm\/[^/]+\/node_modules$/u;
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

/** A trace's entry: a file's or a link's path from the repository, and where it is on disk. */
type Asset = readonly [logical: string, filePath: string];

/**
 * A traced link to a package directory: the link's path in the trace, from which every file of the
 * package is reached and so proved; the name the Function holds the package by; and the directory
 * the link really leads to.
 */
interface PackageLink {
  readonly logical: string;
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

/** Whether a path is in pnpm's store, which only links lead to. */
function isInStore(name: string): boolean {
  const segments = name.split('/');
  return segments.some(
    (segment, at) => segment === PNPM_STORE && segments[at - 1] === PACKAGES_DIR,
  );
}

/**
 * `@types/<name>` for a trace's `…/node_modules/@types/<name>`: a directory TypeScript walks. One
 * in pnpm's store is not: pnpm links a stored package's dependencies there, beside it, and they are
 * held beside the package the Function holds instead (`linkDependencies`).
 */
function typesPackageOf(logical: string): string | undefined {
  const name = TYPES_LINK.exec(logical)?.groups?.['name'];
  return name !== undefined && isVfsName(logical) && !isInStore(logical)
    ? `${TYPES_SCOPE}/${name}`
    : undefined;
}

/**
 * The directory a traced link really leads to, when the link is what its path says: a symlink
 * inside the repository, which the same path reaches from the repository too, onto a directory
 * inside the real repository that holds the package named `name`.
 */
function linkTarget(
  repository: Repository,
  [logical, filePath]: Asset,
  name: string,
): string | undefined {
  if (!path.isAbsolute(filePath)) return undefined;
  try {
    if (!lstatSync(filePath).isSymbolicLink() || beneath(repository.path, filePath) === undefined) {
      return undefined;
    }
    const target = realpathSync(filePath);
    const manifest = path.join(target, MANIFEST);
    return beneath(repository.real, target) !== undefined &&
      realpathSync(path.join(repository.path, logical)) === target &&
      realpathSync(manifest) === manifest &&
      isPackageNamed(manifest, name)
      ? target
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The package a traced types link leads to, when the link is what its name says (`linkTarget`).
 * Any other link is left out, as every link always was: an npm alias (`"@types/react":
 * "npm:types-react@…"`) keeps its stored name. A link in the project is held at its path in the
 * project, since the project is the Function's `/bundle` and its working directory, where
 * TypeScript starts walking `node_modules/@types`: an app in a workspace has its own
 * `apps/site/node_modules/@types/node`. Any other link is held at its path from the repository,
 * as every declaration is.
 */
function typesLinkOf(
  repository: Repository,
  projectDir: string,
  asset: Asset,
): PackageLink | undefined {
  const [logical] = asset;
  const name = typesPackageOf(logical);
  const target = name === undefined ? undefined : linkTarget(repository, asset, name);
  if (target === undefined) return undefined;
  const local = beneath(path.resolve(projectDir), path.join(repository.path, logical));
  const held = local === undefined ? logical : local.split(path.sep).join('/');
  return isVfsName(held) ? { logical, name: held, target } : undefined;
}

/** The `node_modules` directory pnpm's store keeps a link's package in, from the repository. */
function storeOf(repository: Repository, link: PackageLink): string | undefined {
  const store = beneath(repository.real, path.dirname(path.dirname(link.target)));
  const name = store?.split(path.sep).join('/');
  return name !== undefined && PNPM_PACKAGES.test(name) ? name : undefined;
}

/**
 * Where the Function holds the dependency `name` of the package held at `owner`: beside it, unless
 * another package holds that name already, and then in its own `node_modules`.
 */
function dependencyName(
  links: ReadonlyMap<string, PackageLink>,
  owner: PackageLink,
  name: string,
  target: string,
): string {
  const beside = `${path.posix.dirname(path.posix.dirname(owner.name))}/${name}`;
  const held = links.get(beside)?.target;
  return held === undefined || held === target ? beside : `${owner.name}/${PACKAGES_DIR}/${name}`;
}

/**
 * The packages pnpm linked beside each types package in its store, where the trace lists the
 * links. pnpm keeps a package's dependencies as links in the `node_modules` directory it stores the
 * package in (`…/.pnpm/@types+node@…/node_modules/undici-types`), and TypeScript, loading the
 * package from there, finds them by looking upward. Held under its link's name, the package looks
 * upward from there, so each dependency is held beside it, in the `node_modules` directory that
 * name is in, as an npm install places it (`node_modules/undici-types`); or, where another package
 * holds that name already, in the types package's own `node_modules`, where TypeScript looks
 * first. A dependency's own dependencies are not followed.
 */
function linkDependencies(
  links: Map<string, PackageLink>,
  assets: readonly Asset[],
  repository: Repository,
): void {
  const stores = new Map<string, PackageLink[]>();
  for (const link of links.values()) {
    const store = storeOf(repository, link);
    if (store !== undefined) stores.set(store, [...(stores.get(store) ?? []), link]);
  }
  const dependencies = assets
    .flatMap((asset) => {
      const entry = PACKAGE_ENTRY.exec(asset[0])?.groups;
      const owners = stores.get(entry?.['directory'] ?? '');
      const name = entry?.['name'];
      return owners === undefined || name === undefined ? [] : [{ asset, name, owners }];
    })
    .toSorted((a, b) => a.asset[0].localeCompare(b.asset[0]));
  for (const { asset, name, owners } of dependencies) {
    const target = linkTarget(repository, asset, name);
    if (target === undefined) continue;
    for (const owner of owners) {
      const held = dependencyName(links, owner, name, target);
      if (!links.has(held) && isVfsName(held)) {
        links.set(held, { logical: asset[0], name: held, target });
      }
    }
  }
}

/** The traced links the Function holds packages under, by the name it holds each by. */
function packageLinks(
  repository: Repository,
  projectDir: string,
  assets: readonly Asset[],
): Map<string, PackageLink> {
  const links = new Map<string, PackageLink>();
  for (const asset of assets) {
    const link = typesLinkOf(repository, projectDir, asset);
    // A link in the project takes the name over one beyond it, as from the project TypeScript
    // finds the project's own first. Only a project nested in the repository has both.
    if (link !== undefined && (link.name !== link.logical || !links.has(link.name))) {
      links.set(link.name, link);
    }
  }
  linkDependencies(links, assets, repository);
  return links;
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

/** Whether `name` is the file's own path in pnpm's store, which only links lead to. */
function isStoredName(name: string, physical: string, repository: Repository): boolean {
  return isInStore(name) && beneath(repository.real, physical)?.split(path.sep).join('/') === name;
}

/**
 * Each traced declaration of a package a link leads to, under the name the Function holds the
 * package by, where TypeScript looks for it (`node_modules/@types/node/index.d.ts`) and beside the
 * files its relative references name; the link's own path in the trace proves each. With them goes
 * the package's `package.json`, where the trace lists it: TypeScript takes the package's entry from
 * it, and from its `typesVersions` the declarations meant for an older compiler (`@types/node`
 * sends TypeScript 5.6 to `ts5.6/index.d.ts`). Its name in pnpm's store is dropped, since nothing
 * in the Function reaches the store: a store package is reached only through links, and the
 * Function has none; TypeScript resolves a reference beside the file it loaded, and a dependency
 * upward from it (`linkDependencies`); and a types package has no code to name its own directory
 * with. Kept, it would only double the package. A declaration under any other name (a workspace
 * package's own directory, which the application may read) keeps that name too.
 */
function linkTypes(
  files: Map<string, TracedFile>,
  links: ReadonlyMap<string, PackageLink>,
  input: { projectDir: string; repoRoot: string; repository: Repository; assets: readonly Asset[] },
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
    if (names.length > 0 && isStoredName(file.name, physical, input.repository)) {
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
  const repository = repositoryOf(repoRoot);
  if (repository !== undefined) {
    const links = packageLinks(repository, projectDir, assets);
    linkTypes(files, links, { projectDir, repoRoot, repository, assets });
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
