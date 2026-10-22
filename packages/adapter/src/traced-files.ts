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
 * A package pnpm installed travels under the name TypeScript looks for it by. pnpm keeps its files
 * in its store (`node_modules/.pnpm/@types+node@…/node_modules/@types/node`) and links
 * `node_modules/@types/node` to them, and a trace through that link lists the stored files and the
 * link itself. The Function's file system has no links, and TypeScript finds a package only by
 * walking `node_modules` directories upward, so the stored declarations go up, with the package's
 * traced `package.json` (`linkTypes`), where TypeScript in the Function finds the package from
 * `/bundle` as TypeScript finds it from the project (`packageLinks`), and so do the packages pnpm
 * linked beside each in its store, from where that package is held (`linkDependencies`).
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
/** TypeScript's own package, whose library `@typescript/vfs` reads where the trace names it. */
const COMPILER = 'typescript';
/** A package's name at the start of a path in a `node_modules` directory. */
const PACKAGE_NAME = /^(?:@[^./][^/]*\/)?[^./@][^/]*/u;
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

/** What a resolver from the project meets first at a package name. */
interface Seen {
  /** Its path in the trace, from the repository. */
  readonly logical: string;
  /** The directory it leads to, where it is a link that is what its path says (`linkTarget`). */
  readonly target: string | undefined;
}

/**
 * The `node_modules` directories a resolver looks in from the project, nearest first, up to the
 * repository's own: `apps/site/node_modules`, `apps/node_modules`, `node_modules`. None for a
 * project outside the repository, whose declarations are refused.
 */
function projectChain(repository: Repository, projectDir: string): string[] {
  const project = beneath(repository.path, path.resolve(projectDir));
  if (project === undefined) return [];
  const segments = project === '' ? [] : project.split(path.sep);
  return [
    ...segments.map((_, at) =>
      [...segments.slice(0, segments.length - at), PACKAGES_DIR].join('/'),
    ),
    PACKAGES_DIR,
  ];
}

/**
 * What a resolver walking from the project up to the repository root meets first at each package
 * name, among what the trace lists: each link, and each package directory a traced file is in. A
 * link that is what its path says leads to a package the Function can hold; anything else (a
 * package's own directory, an npm alias, a link out of the repository) is nothing the Function can
 * hold, and hides what is farther all the same, as it does from the project.
 */
function projectView(
  repository: Repository,
  chain: readonly string[],
  assets: readonly Asset[],
): Map<string, Seen> {
  const nearest = new Map<string, { readonly distance: number; readonly logical: string }>();
  for (const [logical] of assets) {
    for (const [distance, directory] of chain.entries()) {
      const name = logical.startsWith(`${directory}/`)
        ? PACKAGE_NAME.exec(logical.slice(directory.length + 1))?.[0]
        : undefined;
      if (name !== undefined && distance < (nearest.get(name)?.distance ?? chain.length)) {
        nearest.set(name, { distance, logical: `${directory}/${name}` });
      }
    }
  }
  const listed = new Map(assets);
  return new Map(
    [...nearest].map(([name, { logical }]) => {
      const filePath = listed.get(logical) ?? path.join(repository.path, logical);
      return [name, { logical, target: linkTarget(repository, [logical, filePath], name) }];
    }),
  );
}

/**
 * A traced link off the project's chain and outside pnpm's store (a workspace package's own
 * `packages/lib/node_modules/zod`), held at its own path from the repository, where TypeScript looks
 * for it from the files beside it: those travel under their paths from the repository too, as every
 * declaration does (`declarationFile`), a workspace package in a nested project's directory among
 * them.
 */
function linkElsewhere(
  repository: Repository,
  input: { readonly chain: readonly string[]; readonly asset: Asset },
): PackageLink | undefined {
  const [logical] = input.asset;
  const entry = PACKAGE_ENTRY.exec(logical)?.groups;
  const name = entry?.['name'];
  if (
    name === undefined ||
    name === COMPILER ||
    input.chain.includes(entry?.['directory'] ?? '') ||
    isInStore(logical)
  ) {
    return undefined;
  }
  const target = linkTarget(repository, input.asset, name);
  if (target === undefined) return undefined;
  return isVfsName(logical) ? { logical, name: logical, target } : undefined;
}

/** The `node_modules` directory pnpm's store keeps a held package in, from the repository. */
function storeOf(repository: Repository, link: PackageLink): string | undefined {
  const stored = beneath(repository.real, link.target)?.split(path.sep).join('/');
  const directory =
    stored === undefined ? undefined : PACKAGE_ENTRY.exec(stored)?.groups?.['directory'];
  return directory !== undefined && PNPM_PACKAGES.test(directory) ? directory : undefined;
}

/** The `node_modules` directories TypeScript looks in from inside a package held at `name`. */
function upward(name: string): string[] {
  const segments = name.split('/');
  return [
    ...segments
      .map((_, at) => segments.slice(0, segments.length - at))
      .filter((directory) => directory.at(-1) !== PACKAGES_DIR)
      .map((directory) => [...directory, PACKAGES_DIR].join('/')),
    PACKAGES_DIR,
  ];
}

/** Whether the package held at `name`, or a package it is held inside, is `target`. */
function isWithin(links: ReadonlyMap<string, PackageLink>, name: string, target: string): boolean {
  const segments = name.split('/');
  return segments.some(
    (_, at) => links.get(segments.slice(0, at + 1).join('/'))?.target === target,
  );
}

/**
 * Where the Function holds a dependency `name` of the package held at `owner`, really `target`,
 * for TypeScript to find from the package as the package finds it in pnpm's store, looking in each
 * `node_modules` upward from inside it. Where the first package it meets by that name is this one,
 * nothing more is held. Where it meets another first, the dependency is held in the owner's own
 * `node_modules`, unless the owner is held inside this package already: a cycle. Where it meets
 * none, the dependency is held beside the owner, where an npm install places it.
 */
function dependencyName(
  held: {
    readonly links: ReadonlyMap<string, PackageLink>;
    readonly view: ReadonlyMap<string, Seen>;
  },
  owner: PackageLink,
  name: string,
  target: string,
): string | undefined {
  for (const directory of upward(owner.name)) {
    const at = `${directory}/${name}`;
    const met =
      held.links.get(at) ?? (directory === PACKAGES_DIR ? held.view.get(name) : undefined);
    if (met === undefined) continue;
    if (met.target === target) return undefined;
    const inside = `${owner.name}/${PACKAGES_DIR}/${name}`;
    return at === inside || isWithin(held.links, owner.name, target) ? undefined : inside;
  }
  return `${PACKAGE_ENTRY.exec(owner.name)?.groups?.['directory'] ?? PACKAGES_DIR}/${name}`;
}

/**
 * The traced links pnpm made in each `node_modules` directory of its store, in a stable order, but
 * TypeScript's own, whose library keeps its names (`packageLinks`).
 */
function storeLinks(assets: readonly Asset[]): Map<string, { asset: Asset; name: string }[]> {
  const stores = new Map<string, { asset: Asset; name: string }[]>();
  const sorted = assets.toSorted(([a], [b]) => a.localeCompare(b));
  for (const asset of sorted) {
    const entry = PACKAGE_ENTRY.exec(asset[0])?.groups;
    const directory = entry?.['directory'];
    const name = entry?.['name'];
    if (
      directory !== undefined &&
      name !== undefined &&
      name !== COMPILER &&
      PNPM_PACKAGES.test(directory)
    ) {
      stores.set(directory, [...(stores.get(directory) ?? []), { asset, name }]);
    }
  }
  return stores;
}

/**
 * The packages pnpm linked beside each package the Function holds, in the `node_modules` directory
 * it stores that package in (`…/.pnpm/@types+node@…/node_modules/undici-types`), where the trace
 * lists the links, and then the packages linked beside those: TypeScript, loading a package from
 * the store, finds them by looking upward from it, and the Function holds each where TypeScript
 * finds it from where the package is held (`dependencyName`). A package is placed only after the
 * package it is held inside has placed all it depends on, so what is above it is settled. Each
 * traced link is followed once from each place its package is held, and no package is held inside
 * itself, so this ends with what the trace lists.
 */
function linkDependencies(
  links: Map<string, PackageLink>,
  view: ReadonlyMap<string, Seen>,
  assets: readonly Asset[],
  repository: Repository,
): void {
  const stores = storeLinks(assets);
  const queue = [...links.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  for (let owner = queue.shift(); owner !== undefined; owner = queue.shift()) {
    const store = storeOf(repository, owner);
    const dependencies = store === undefined ? undefined : stores.get(store);
    if (dependencies === undefined) continue;
    for (const { asset, name } of dependencies) {
      const target = linkTarget(repository, asset, name);
      const at =
        target === undefined ? undefined : dependencyName({ links, view }, owner, name, target);
      if (target !== undefined && at !== undefined && isVfsName(at) && !links.has(at)) {
        const link = { logical: asset[0], name: at, target };
        links.set(at, link);
        queue.push(link);
      }
    }
  }
}

/**
 * The packages the Function holds, by the name it holds each by: each package the project's
 * resolver finds by a link (`projectView`), at `node_modules/<name>`, which is where the Function
 * finds it from `/bundle`, whichever level of the repository the link is at; each other traced
 * link outside pnpm's store, at its own path (`linkElsewhere`); and what each depends on
 * (`linkDependencies`). TypeScript's own package keeps the names the trace gives it:
 * `@typescript/vfs` reads its library from the one directory the build checked by that name
 * (`vfs-typescript.ts`).
 */
function packageLinks(
  repository: Repository,
  projectDir: string,
  assets: readonly Asset[],
): Map<string, PackageLink> {
  const chain = projectChain(repository, projectDir);
  const view = projectView(repository, chain, assets);
  const links = new Map<string, PackageLink>();
  for (const [name, seen] of view) {
    const held = `${PACKAGES_DIR}/${name}`;
    if (name !== COMPILER && seen.target !== undefined) {
      links.set(held, { logical: seen.logical, name: held, target: seen.target });
    }
  }
  for (const asset of assets) {
    const link = linkElsewhere(repository, { chain, asset });
    if (link !== undefined && !links.has(link.name)) links.set(link.name, link);
  }
  linkDependencies(links, view, assets, repository);
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
 * upward from it (`linkDependencies`); and a package's code is bundled, so no code names the
 * store's directories. Kept, it would only double the package. A declaration under any other name
 * (a workspace package's own directory, which the application may read) keeps that name too.
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
