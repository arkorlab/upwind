import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';

import { compareCodeUnits } from '@stayingupwind/core/util';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';
import type { NativeLoad } from './native-loads.ts';
import type { NodeArchiveFile } from './node-archive.ts';
import { nodePackageName, preserveNodePackageSubpaths } from './node-package-subpaths.ts';
import { originalNodeSpecifiers } from './node-source-specifiers.ts';

const MAX_FILE_BYTES = 134_217_728;
const EXECUTABLE_BITS = 0o111;
const PACKAGE_MANIFEST = 'package.json';
const COMMONJS_SUFFIXES = ['', '.js', '.json', '.node'] as const;

export interface NodePhysicalFiles {
  readonly files: NodeArchiveFile[];
  /** Build-machine source locations; never serialized into the public archive. */
  readonly sourcePaths: ReadonlyMap<string, string>;
  readonly links: readonly { readonly path: string; readonly target: string }[];
  readonly cwd: string;
  /** The original compiled project hook, distinct from the generated host composition. */
  readonly instrumentation: string | undefined;
  readonly nameOf: (file: string) => string;
}

type NameOf = NodePhysicalFiles['nameOf'];
interface PhysicalLayout {
  readonly root: string;
  readonly distDir: string;
  readonly cwd: string;
  readonly nameOf: NameOf;
}
interface PhysicalSources {
  readonly files: Map<string, Uint8Array>;
  readonly executable: Set<string>;
  readonly originals: Map<string, string>;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function boundedFile(file: string): Promise<Uint8Array> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    throw new AuditError('Node artifact requires bounded, regular input files');
  const bytes = new Uint8Array(await readFile(file));
  if (bytes.byteLength !== info.size)
    throw new AuditError('Node artifact input changed while it was read');
  return bytes;
}

/** A moved distDir must not make an unchanged relative lookup name a different location. */
function assertRelativeTopology(importer: string, target: string, nameOf: NameOf): void {
  const relative = path.relative(path.dirname(importer), target).split(path.sep).join('/');
  const owner = path.posix.dirname(nameOf(importer));
  const lookedUp = path.posix.normalize(path.posix.join(owner, relative));
  if (lookedUp !== nameOf(target)) {
    throw new AuditError(
      'Native Function relocation changes a relative module or native binary lookup; refusing publication',
    );
  }
}

function physicalLayout(input: BuildFunctionInput): PhysicalLayout {
  const root = path.resolve(input.repoRoot ?? input.projectDir);
  const project = beneath(root, path.resolve(input.projectDir));
  if (project === undefined)
    throw new AuditError('Node project directory escapes its tracing root');
  const cwd = path.posix.join('project', project.split(path.sep).join('/'));
  const nameOf: NameOf = (file) => {
    const relative = beneath(root, path.resolve(file));
    if (relative !== undefined)
      return path.posix.join('project', relative.split(path.sep).join('/'));
    const built = beneath(input.patch.distDir, path.resolve(file));
    if (built !== undefined)
      return path.posix.join(cwd, '.upwind-build', built.split(path.sep).join('/'));
    throw new AuditError('Node artifact input escapes both its tracing root and build output');
  };
  return { root, distDir: input.patch.distDir, cwd, nameOf };
}

async function projectInstrumentation(input: BuildFunctionInput): Promise<string | undefined> {
  if (input.patch.instrumentation === undefined) return undefined;
  try {
    return await realpath(path.join(input.patch.distDir, 'server', 'instrumentation.js'));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return undefined;
  }
}

function inputFiles(input: BuildFunctionInput, instrumentation: string | undefined): Set<string> {
  const files = new Set(input.entries.map((entry) => entry.filePath));
  if (instrumentation !== undefined) files.add(instrumentation);
  if (input.entryTraces !== undefined) {
    for (const trace of input.entryTraces)
      for (const file of Object.values(trace.assets)) files.add(file);
  }
  for (const file of input.files) files.add(file.filePath);
  for (const entry of input.edgeEntries) for (const file of entry.files) files.add(file);
  for (const manifest of input.manifests)
    if (manifest.routeFile !== undefined) files.add(manifest.routeFile);
  return files;
}

async function packageMetadata(
  file: string,
  layout: PhysicalLayout,
  files: Map<string, Uint8Array>,
): Promise<void> {
  for (
    let dir = path.dirname(file);
    beneath(layout.root, dir) !== undefined;
    dir = path.dirname(dir)
  ) {
    const manifest = path.join(dir, PACKAGE_MANIFEST);
    try {
      files.set(layout.nameOf(manifest), await boundedFile(manifest));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (dir === layout.root) break;
  }
}

async function physicalSources(
  files: Iterable<string>,
  layout: PhysicalLayout,
): Promise<PhysicalSources> {
  const sources: PhysicalSources = {
    files: new Map(),
    executable: new Set(),
    originals: new Map(),
  };
  for (const file of files) {
    const canonical = await realpath(file);
    const name = layout.nameOf(canonical);
    sources.files.set(name, await boundedFile(canonical));
    const mode = (await stat(canonical)).mode;
    // eslint-disable-next-line no-bitwise -- POSIX executable permission bits are the artifact's file mode.
    if ((mode & EXECUTABLE_BITS) !== 0) sources.executable.add(name);
    sources.originals.set(canonical, name);
    await packageMetadata(canonical, layout, sources.files);
  }
  return sources;
}

function assertSpecifierTopology(file: string, specifier: string, layout: PhysicalLayout): void {
  if (!specifier.startsWith('.')) return;
  const target = path.resolve(path.dirname(file), specifier);
  // Optional missing modules outside the closed trace retain their existing audit/fallback.
  // Known roots, including an extensionless relative import, must preserve their topology.
  if (beneath(layout.root, target) !== undefined || beneath(layout.distDir, target) !== undefined)
    assertRelativeTopology(file, target, layout.nameOf);
}

interface PackageAliasContext {
  readonly layout: PhysicalLayout;
  readonly sources: PhysicalSources;
  readonly links: Map<string, string>;
}

function ownsDirectory(sources: PhysicalSources, target: string): boolean {
  for (const file of sources.originals.keys()) if (beneath(target, file) !== undefined) return true;
  return false;
}

async function assertPackageTarget(target: string, context: PackageAliasContext): Promise<void> {
  const info = await stat(target);
  const name = context.layout.nameOf(target);
  if (info.isFile()) {
    if (!context.sources.originals.has(target))
      throw new AuditError('The first existing Node package target is outside its closed trace');
    return;
  }
  if (!info.isDirectory())
    throw new AuditError('A Node package alias requires a regular physical target');
  if (!ownsDirectory(context.sources, target))
    throw new AuditError('The first existing Node package target is outside its closed trace');
  const metadata = path.join(target, PACKAGE_MANIFEST);
  try {
    await stat(metadata);
    if (!context.sources.files.has(path.posix.join(name, PACKAGE_MANIFEST)))
      throw new AuditError('Node package export metadata is absent from its physical artifact');
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function recordPackageAlias(alias: string, context: PackageAliasContext): Promise<boolean> {
  try {
    const target = await realpath(alias);
    await assertPackageTarget(target, context);
    if (path.resolve(alias) !== target)
      context.links.set(context.layout.nameOf(alias), context.layout.nameOf(target));
    return true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    return false;
  }
}

async function packageAliases(
  file: string,
  specifier: string,
  context: PackageAliasContext,
): Promise<boolean> {
  if (isBuiltin(specifier)) return true;
  if (path.isAbsolute(specifier) || specifier.startsWith('file:'))
    throw new AuditError('Absolute Node module imports cannot be relocated into an artifact');
  const pkg = nodePackageName(specifier);
  if (pkg === undefined) return false;
  const require = createRequire(file);
  // Search paths are independent of exports conditions. Import-only packages may forbid both
  // require(pkg) and require(pkg/package.json), but still need their original physical alias.
  const searches = require.resolve.paths(pkg) ?? [];
  for (const search of searches) {
    const alias = path.join(search, pkg);
    if (!(await recordPackageAlias(alias, context))) continue;
    await packageSubpathAliases(await realpath(alias), specifier, pkg, context);
    return true;
  }
  return false;
}

async function packageSubpathAliases(
  directory: string,
  specifier: string,
  pkg: string,
  context: PackageAliasContext,
): Promise<void> {
  if (specifier === pkg) return;
  const file = path.join(directory, PACKAGE_MANIFEST);
  await preserveNodePackageSubpaths({
    directory,
    specifier,
    packageName: pkg,
    metadata: context.sources.files.get(context.layout.nameOf(file)),
    relativeAlias: (target) => relativeAliases(file, target, context),
    exactAlias: (target) => relativePackageImport(file, target, context),
  });
}

function packageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function packageScope(
  importer: string,
  context: PackageAliasContext,
): Promise<{ readonly file: string; readonly metadata: Record<string, unknown> }> {
  for (
    let dir = path.dirname(importer);
    beneath(context.layout.root, dir) !== undefined && path.basename(dir) !== 'node_modules';
    dir = path.dirname(dir)
  ) {
    const file = path.join(dir, PACKAGE_MANIFEST);
    try {
      await stat(file);
      const bytes = context.sources.files.get(context.layout.nameOf(file));
      if (bytes === undefined)
        throw new AuditError('Node package import scope metadata is not closed');
      const metadata: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!packageRecord(metadata))
        throw new AuditError('Invalid Node package import scope metadata');
      return { file, metadata };
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    if (dir === context.layout.root) break;
  }
  throw new AuditError('Node package import has no closed package scope');
}

function packageImportTarget(metadata: Record<string, unknown>, specifier: string): string {
  const imports = metadata['imports'];
  if (
    !packageRecord(imports) ||
    !Object.hasOwn(imports, specifier) ||
    !/^#[\w./-]+$/u.test(specifier) ||
    specifier.endsWith('/')
  )
    throw new AuditError(
      'Node package import requires a proved exact mapping; patterns are unsupported',
    );
  const target = imports[specifier];
  if (typeof target !== 'string' || target === '' || /[*#?%\\]/u.test(target))
    throw new AuditError(
      'Node package import requires a literal target; conditions and chains are unsupported',
    );
  return target;
}

async function relativePackageImport(
  file: string,
  target: string,
  context: PackageAliasContext,
): Promise<void> {
  const logical = path.resolve(path.dirname(file), target);
  if (
    beneath(path.dirname(file), logical) === undefined ||
    target
      .slice(2)
      .split('/')
      .some((segment) => ['.', '..', 'node_modules'].includes(segment))
  )
    throw new AuditError('Node package import target escapes its package scope');
  const canonical = await realpath(logical);
  if (!(await stat(canonical)).isFile())
    throw new AuditError('Node package import requires an exact regular target file');
  await assertPackageTarget(canonical, context);
  assertSpecifierTopology(file, target, context.layout);
  await relativeAliases(file, target, context);
}

function resolvedPackageBuiltin(importer: string, specifier: string): boolean {
  let resolved: string;
  try {
    resolved = createRequire(importer).resolve(specifier);
  } catch {
    return false;
  }
  return isBuiltin(resolved);
}

/** Exact package imports resolve external targets from package.json, never an importer subfolder. */
async function packageImports(
  importer: string,
  specifier: string,
  context: PackageAliasContext,
): Promise<void> {
  if (!specifier.startsWith('#')) return;
  const scope = await packageScope(importer, context);
  const target = packageImportTarget(scope.metadata, specifier);
  if (target.startsWith('./')) return relativePackageImport(scope.file, target, context);
  if (isBuiltin(target)) {
    // Node imports rejects URL-scheme targets; bare builtins resolve through packageResolve.
    if (target.includes(':') || !resolvedPackageBuiltin(importer, specifier))
      throw new AuditError('Node package import has an unproved builtin target');
    return;
  }
  const pkg = nodePackageName(target);
  const segments = target.split('/');
  if (
    pkg === undefined ||
    !/^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/u.test(target) ||
    segments.some((segment) => ['.', '..', 'node_modules'].includes(segment)) ||
    (pkg === scope.metadata['name'] && scope.metadata['exports'] !== undefined)
  )
    throw new AuditError('Node package import has an unproved external target');
  if (!(await packageAliases(scope.file, target, context)))
    throw new AuditError('Node package import external alias has no closed physical target');
}

function absentRelativePath(error: unknown): boolean {
  return (
    isMissingFile(error) || (error instanceof Error && 'code' in error && error.code === 'ENOTDIR')
  );
}

async function relativeMain(
  logical: string,
  context: PackageAliasContext,
): Promise<string | undefined> {
  let metadata: unknown;
  try {
    const file = await realpath(path.join(logical, PACKAGE_MANIFEST));
    const bytes = context.sources.files.get(context.layout.nameOf(file));
    if (bytes === undefined)
      throw new AuditError('A relative package entry has no closed metadata');
    metadata = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (!absentRelativePath(error)) throw error;
    return undefined;
  }
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('main' in metadata) ||
    typeof metadata.main !== 'string'
  )
    return undefined;
  const main = path.resolve(logical, metadata.main);
  if (beneath(logical, main) === undefined)
    throw new AuditError('A relative package entry escapes its closed physical directory');
  return main;
}

function resolveRelative(file: string, specifier: string): string | undefined {
  try {
    return createRequire(file).resolve(specifier);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')
      return undefined;
    throw error;
  }
}

async function relativeDirectoryAlias(
  logical: string,
  context: PackageAliasContext,
): Promise<void> {
  try {
    if ((await stat(logical)).isDirectory()) await recordPackageAlias(logical, context);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function matchingRelativeAlias(
  alias: string,
  resolved: string,
  context: PackageAliasContext,
): Promise<boolean> {
  try {
    if ((await realpath(alias)) !== resolved) return false;
    await recordPackageAlias(alias, context);
    return true;
  } catch (error) {
    if (!absentRelativePath(error)) throw error;
    return false;
  }
}

/** Preserve logical relative links even when NFT recorded only canonical files. */
async function relativeAliases(
  file: string,
  specifier: string,
  context: PackageAliasContext,
): Promise<void> {
  if (!specifier.startsWith('.')) return;
  const logical = path.resolve(path.dirname(file), specifier);
  const resolved = resolveRelative(file, specifier);
  if (resolved === undefined) return;
  context.layout.nameOf(logical);
  const roots = [logical, path.join(logical, 'index')];
  const main = await relativeMain(logical, context);
  if (main !== undefined) roots.push(main, path.join(main, 'index'));
  await relativeDirectoryAlias(logical, context);
  for (const root of roots)
    for (const suffix of COMMONJS_SUFFIXES)
      if (await matchingRelativeAlias(`${root}${suffix}`, resolved, context)) return;
  throw new AuditError('A relative Node module lookup has no proved physical alias');
}

async function moduleAliases(
  sources: PhysicalSources,
  layout: PhysicalLayout,
  links: Map<string, string>,
): Promise<void> {
  const context = { sources, layout, links };
  for (const [file, name] of sources.originals) {
    const specifiers = new Set(originalNodeSpecifiers(file, sources.files.get(name)));
    for (const specifier of specifiers) {
      assertSpecifierTopology(file, specifier, layout);
      await relativeAliases(file, specifier, context);
      await packageImports(file, specifier, context);
      await packageAliases(file, specifier, context);
    }
  }
}

async function recordTraceAlias(
  logical: string,
  physical: string,
  layout: PhysicalLayout,
  links: Map<string, string>,
): Promise<void> {
  if (path.isAbsolute(logical) || logical.includes('\\')) return;
  const alias = path.resolve(layout.root, logical);
  try {
    const target = await realpath(alias);
    if (target !== path.resolve(alias) && target === (await realpath(physical)))
      links.set(layout.nameOf(alias), layout.nameOf(target));
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function traceAliases(
  input: BuildFunctionInput,
  layout: PhysicalLayout,
  links: Map<string, string>,
): Promise<void> {
  // Asset keys can retain a logical import alias that values canonicalize away.
  if (input.entryTraces !== undefined) {
    for (const trace of input.entryTraces) {
      for (const [logical, physical] of Object.entries(trace.assets))
        await recordTraceAlias(logical, physical, layout, links);
    }
  }
}

function emittedLinks(
  links: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, Uint8Array>,
): { path: string; target: string }[] {
  const ordered = [...links].toSorted(([a], [b]) => a.length - b.length || compareCodeUnits(a, b));
  const emitted: { path: string; target: string }[] = [];
  for (const [alias, target] of ordered) {
    if (files.has(alias) || emitted.some((link) => alias.startsWith(`${link.path}/`))) continue;
    if (alias === target || target.startsWith(`${alias}/`))
      throw new AuditError('Node artifact contains a cyclic alias');
    const physical = [...files.keys()];
    if (physical.every((file) => file !== target && !file.startsWith(`${target}/`)))
      throw new AuditError('Node artifact alias has no physical target');
    emitted.push({ path: alias, target });
  }
  return emitted;
}

/** Physical traces plus explicit internal aliases; no user module is evaluated or rebundled. */
export async function nodePhysicalFiles(
  input: BuildFunctionInput,
  native: readonly NativeLoad[],
): Promise<NodePhysicalFiles> {
  const layout = physicalLayout(input);
  for (const load of native)
    assertRelativeTopology(
      await realpath(load.importer),
      await realpath(load.binary),
      layout.nameOf,
    );
  const instrumentation = await projectInstrumentation(input);
  const sources = await physicalSources(inputFiles(input, instrumentation), layout);
  const links = new Map<string, string>();
  await moduleAliases(sources, layout, links);
  await traceAliases(input, layout, links);
  return {
    files: [...sources.files].map(([name, bytes]) => {
      return {
        name,
        bytes,
        ...(sources.executable.has(name) && { executable: true }),
      };
    }),
    links: emittedLinks(links, sources.files),
    sourcePaths: new Map([...sources.originals].map(([file, name]) => [name, file])),
    cwd: layout.cwd,
    instrumentation,
    nameOf: layout.nameOf,
  };
}
