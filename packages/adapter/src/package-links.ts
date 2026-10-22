import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { beneath } from './build-paths.ts';

export const PACKAGES_DIR = 'node_modules';
/** What TypeScript reads a package's entry and its `typesVersions` from. */
export const MANIFEST = 'package.json';
/** TypeScript's own package, whose library `@typescript/vfs` reads where the trace names it. */
const COMPILER = 'typescript';
/** A package's name at the start of a path in a `node_modules` directory. */
const PACKAGE_NAME = /^(?:@[^./][^/]*\/)?[^./@][^/]*/u;
/** A package in a `node_modules` directory: `<directory>/<name>` or `<directory>/@scope/<name>`. */
const PACKAGE_ENTRY =
  /^(?<directory>(?:.+\/)?node_modules)\/(?<name>(?:@[^./][^/]*\/)?[^./@][^/]*)$/u;
const DECLARATION = /\.d\.(?:ts|mts|cts)$/u;
const RESERVED_DECLARATION_ROOTS = new Set(['.arkor', '.upwind-build']);
// eslint-disable-next-line no-control-regex -- Reject control bytes in a traced VFS path rather than letting them name a module.
const CONTROL_CHARACTER = /[\u{0}-\u{1F}\u{7F}]/u;

/** The repository the trace names paths from, as it was given and as it is on disk. */
interface Repository {
  readonly path: string;
  readonly real: string;
}

/** A trace's entry: a file's or a link's path from the repository, and where it is on disk. */
export type Asset = readonly [logical: string, filePath: string];

/**
 * A traced link to a package directory: the link's path in the trace, from which every file of the
 * package is reached and so proved; the name the Function holds the package by; and the directory
 * the link really leads to.
 */
export interface PackageLink {
  readonly logical: string;
  readonly name: string;
  readonly target: string;
}

/** What a resolver meets first at a package name in a `node_modules` directory. */
interface Seen {
  /** Its path in the trace, from the repository. */
  readonly logical: string;
  /** The directory it leads to, where it is a link that is what its path says (`linkTarget`). */
  readonly target: string | undefined;
}

/**
 * What placing the traced packages reads: the repository; the project's chain (`projectChain`);
 * the entries the trace lists in each `node_modules` directory, by package name (`entriesOf`);
 * where each traced path is on disk; and, read once each, what is traced at a path (`seenAt`) and
 * what a `node_modules` directory holds on disk (`present`).
 */
export interface Context {
  readonly repository: Repository;
  readonly chain: readonly string[];
  readonly entries: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly listed: ReadonlyMap<string, string>;
  readonly seen: Map<string, Seen>;
  readonly present: Map<string, ReadonlySet<string>>;
}

/** A declaration is data only when this output explicitly traced its logical name. */
export function isDeclaration(file: string): boolean {
  return DECLARATION.test(file.toLowerCase());
}

/**
 * A name the Function's file system may hold a traced file under: relative, `/`-separated, with no
 * empty, `.` or `..` part, and outside the roots the adapter keeps for itself.
 */
export function isVfsName(logical: string): boolean {
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

/** Whether the package manifest at `manifest` gives its package the name `name`. */
export function isPackageNamed(manifest: string, name: string): boolean {
  const identity: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  return (
    typeof identity === 'object' &&
    identity !== null &&
    'name' in identity &&
    identity.name === name
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

/**
 * The entries the trace lists in each `node_modules` directory, by package name: each link, and
 * each package directory a traced file is in, wherever on its path that directory is.
 */
function entriesOf(assets: readonly Asset[]): Map<string, Map<string, string>> {
  const entries = new Map<string, Map<string, string>>();
  for (const [logical] of assets) {
    const segments = logical.split('/');
    for (const [at, segment] of segments.entries()) {
      const name =
        segment === PACKAGES_DIR
          ? PACKAGE_NAME.exec(segments.slice(at + 1).join('/'))?.[0]
          : undefined;
      if (name === undefined) continue;
      const directory = segments.slice(0, at + 1).join('/');
      const names = entries.get(directory) ?? new Map<string, string>();
      names.set(name, `${directory}/${name}`);
      entries.set(directory, names);
    }
  }
  return entries;
}

/** What the trace lists at `logical`, a package named `name`: read once, the same each time. */
function seenAt(context: Context, logical: string, name: string): Seen {
  const known = context.seen.get(logical);
  if (known !== undefined) return known;
  const filePath = context.listed.get(logical) ?? path.join(context.repository.path, logical);
  const seen = { logical, target: linkTarget(context.repository, [logical, filePath], name) };
  context.seen.set(logical, seen);
  return seen;
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
 * What placing a trace's packages reads, for the repository the trace names its paths from; none
 * where that repository is not on disk.
 */
export function contextOf(
  repoRoot: string,
  projectDir: string,
  assets: readonly Asset[],
): Context | undefined {
  let repository: Repository;
  try {
    const resolved = path.resolve(repoRoot);
    repository = { path: resolved, real: realpathSync(resolved) };
  } catch {
    return undefined;
  }
  const chain = projectChain(repository, projectDir);
  return {
    repository,
    chain,
    entries: entriesOf(assets),
    listed: new Map(assets),
    seen: new Map(),
    present: new Map(),
  };
}

/**
 * What a resolver walking from the project up to the repository root meets first at each package
 * name, among what the trace lists (`entriesOf`). A link that is what its path says leads to a
 * package the Function can hold; anything else (a package's own directory, an npm alias, a link
 * out of the repository) is nothing the Function can hold, and hides what is farther all the
 * same, as it does from the project.
 */
function projectView(context: Context): Map<string, Seen> {
  const view = new Map<string, Seen>();
  for (const directory of context.chain) {
    const names = context.entries.get(directory);
    if (names === undefined) continue;
    for (const [name, logical] of names) {
      if (!view.has(name)) view.set(name, seenAt(context, logical, name));
    }
  }
  return view;
}

/**
 * The `node_modules` directory a package at `target` sits in, from the repository, where it is off
 * the project's chain: in pnpm's store, wherever its `virtualStoreDir` puts it
 * (`<store>/<id>/node_modules`), where only links lead to it.
 */
export function storedIn(context: Context, target: string): string | undefined {
  const real = beneath(context.repository.real, target)?.split(path.sep).join('/');
  const directory =
    real === undefined ? undefined : PACKAGE_ENTRY.exec(real)?.groups?.['directory'];
  return directory === undefined || context.chain.includes(directory) ? undefined : directory;
}

/**
 * The `node_modules` directories of pnpm's store, found from where the trace's links lead rather
 * than by its name, which `virtualStoreDir` sets: each one a linked package sits in off the
 * project's chain (`<store>/<id>/node_modules`, which holds it and pnpm's links to what it depends
 * on), and the store's own (`<store>/node_modules`), where pnpm hoists every package.
 */
function storeDirectories(context: Context): Set<string> {
  const directories = new Set<string>();
  for (const [logical, filePath] of context.listed) {
    if (PACKAGE_ENTRY.exec(logical) === null || !path.isAbsolute(filePath)) continue;
    let directory: string | undefined;
    try {
      const linked = lstatSync(filePath).isSymbolicLink() ? realpathSync(filePath) : undefined;
      directory = linked === undefined ? undefined : storedIn(context, linked);
    } catch {
      directory = undefined;
    }
    if (directory !== undefined) {
      directories.add(directory);
      directories.add(`${path.posix.dirname(path.posix.dirname(directory))}/${PACKAGES_DIR}`);
    }
  }
  return directories;
}

/**
 * The directories of the project's chain between the project and the repository root that a
 * traced declaration outside the project resolves through, from where it is: a workspace's shared
 * declarations (`apps/group/shared/index.d.ts`, beside the app `apps/group/site`) look in
 * `apps/group/node_modules` before the root's. The project's own `node_modules` is the Function's
 * `/bundle/node_modules`, and so is the repository root's, which a declaration anywhere in the
 * repository reaches last: there, it finds what the project finds.
 */
function sharedDirectories(chain: readonly string[], assets: readonly Asset[]): Set<string> {
  const project = path.posix.dirname(chain[0] ?? PACKAGES_DIR);
  const outside = assets
    .map(([logical]) => logical)
    .filter((logical) => isDeclaration(logical) && !logical.startsWith(`${project}/`));
  return new Set(
    chain.slice(1, -1).filter((directory) => {
      const ancestor = `${path.posix.dirname(directory)}/`;
      const own = `${directory}/`;
      return outside.some((logical) => logical.startsWith(ancestor) && !logical.startsWith(own));
    }),
  );
}

/**
 * A traced link the project's resolver does not decide, held at its own path from the repository,
 * where TypeScript looks for it from the files beside it, which travel under their paths from the
 * repository too, as every declaration does: one in a workspace package's own `node_modules`
 * (`packages/lib/node_modules/zod`), a workspace package in a nested project's directory among
 * them, and one on the project's chain that a declaration outside the project resolves through
 * (`sharedDirectories`). pnpm's links in its store are what the packages beside them depend on,
 * and are placed as such (`linkDependencies`).
 */
function linkElsewhere(
  context: Context,
  directories: { readonly shared: ReadonlySet<string>; readonly stores: ReadonlySet<string> },
  asset: Asset,
): PackageLink | undefined {
  const [logical] = asset;
  const entry = PACKAGE_ENTRY.exec(logical)?.groups;
  const name = entry?.['name'];
  const directory = entry?.['directory'] ?? '';
  const elsewhere = context.chain.includes(directory)
    ? directories.shared.has(directory)
    : !directories.stores.has(directory);
  if (name === undefined || name === COMPILER || !elsewhere) return undefined;
  const target = linkTarget(context.repository, asset, name);
  return target !== undefined && isVfsName(logical)
    ? { logical, name: logical, target }
    : undefined;
}

/** The `node_modules` directories TypeScript looks in from inside a package at `name`. */
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
 * for TypeScript to find from the package as the package finds it where it really is, looking in
 * each `node_modules` upward from inside it. Where the first package it meets by that name is this
 * one, nothing more is held. Where it meets another first, the dependency is held in the owner's
 * own `node_modules`, unless the owner is held inside this package already: a cycle. Where it
 * meets none, the dependency is held beside the owner, where an npm install places it.
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

/** The names in a directory, or none where it is not there. */
function listing(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/** The package names a `node_modules` directory holds on disk, traced or not. */
function present(context: Context, directory: string): ReadonlySet<string> {
  const known = context.present.get(directory);
  if (known !== undefined) return known;
  const at = path.join(context.repository.path, directory);
  const names = new Set(
    listing(at).flatMap((name) => {
      if (!name.startsWith('@')) return [name];
      return listing(path.join(at, name)).map((scoped) => `${name}/${scoped}`);
    }),
  );
  context.present.set(directory, names);
  return names;
}

/**
 * What the package at `target` depends on, as TypeScript finds it from there: by each name the
 * trace lists, the entry in the first `node_modules` directory that holds one by that name on disk,
 * looking upward from inside the package to the repository root's. Where the trace does not list
 * that entry, nothing farther stands in for it, as it would not where the package really is. For a
 * package in pnpm's store, wherever `virtualStoreDir` puts it, those directories are pnpm's links
 * beside it, the store's own hoisted `node_modules`, and then the repository's; for a workspace
 * package, its own `node_modules`, its parents', and the repository's. TypeScript's own package is
 * none of them, as its library keeps its names (`packageLinks`).
 */
function dependenciesOf(
  context: Context,
  target: string,
): { readonly name: string; readonly seen: Seen }[] {
  const real = beneath(context.repository.real, target)?.split(path.sep).join('/');
  if (real === undefined || real === '') return [];
  const directories = upward(real);
  const traced = new Set(directories.flatMap((d) => [...(context.entries.get(d)?.keys() ?? [])]));
  const found: { readonly name: string; readonly logical: string }[] = [];
  for (const name of traced) {
    const first = directories.find((directory) => present(context, directory).has(name));
    const logical = first === undefined ? undefined : context.entries.get(first)?.get(name);
    if (name !== COMPILER && logical !== undefined && logical !== real) {
      found.push({ name, logical });
    }
  }
  return found
    .toSorted((a, b) => a.logical.localeCompare(b.logical))
    .map(({ name, logical }) => ({ name, seen: seenAt(context, logical, name) }));
}

/**
 * What each package the Function holds depends on (`dependenciesOf`), and then what those depend
 * on: the Function holds each where TypeScript finds it from where the package is held
 * (`dependencyName`). A package is placed only after the package it is held inside has placed all
 * it depends on, so what is above it is settled. Each traced entry is followed once from each
 * place its package is held, and no package is held inside itself, so this ends with what the
 * trace lists.
 */
function linkDependencies(
  links: Map<string, PackageLink>,
  view: ReadonlyMap<string, Seen>,
  context: Context,
): void {
  const queue = [...links.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  for (let owner = queue.shift(); owner !== undefined; owner = queue.shift()) {
    for (const { name, seen } of dependenciesOf(context, owner.target)) {
      const { logical, target } = seen;
      const at =
        target === undefined ? undefined : dependencyName({ links, view }, owner, name, target);
      if (target !== undefined && at !== undefined && isVfsName(at) && !links.has(at)) {
        const link = { logical, name: at, target };
        links.set(at, link);
        queue.push(link);
      }
    }
  }
}

/**
 * The packages the Function holds, by the name it holds each by, for TypeScript in it to find each
 * as TypeScript finds it in the repository, through links the Function's file system does not
 * have: each package the project's resolver finds by a link (`projectView`), at
 * `node_modules/<name>`, which is where the Function finds it from `/bundle`, whichever level of
 * the repository the link is at; each other traced link a declaration's own path resolves
 * through, at its own path (`linkElsewhere`); and what each depends on (`linkDependencies`).
 * TypeScript's own package keeps the names the trace gives it: `@typescript/vfs` reads its library
 * from the one directory the build checked by that name (`vfs-typescript.ts`).
 */
export function packageLinks(context: Context, assets: readonly Asset[]): Map<string, PackageLink> {
  const view = projectView(context);
  const links = new Map<string, PackageLink>();
  for (const [name, { logical, target }] of view) {
    const held = `${PACKAGES_DIR}/${name}`;
    if (name !== COMPILER && target !== undefined) links.set(held, { logical, name: held, target });
  }
  const directories = {
    shared: sharedDirectories(context.chain, assets),
    stores: storeDirectories(context),
  };
  for (const asset of assets) {
    const link = linkElsewhere(context, directories, asset);
    if (link !== undefined && !links.has(link.name)) links.set(link.name, link);
  }
  linkDependencies(links, view, context);
  return links;
}
