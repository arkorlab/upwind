import { realpath, stat } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import { NodeAliasCompatibility } from './node-alias-compatibility.ts';
import {
  nodeAliasLookupError,
  nodeAliasOutsideTrace,
  OUTSIDE_CLOSED_TRACE,
} from './node-alias-diagnostics.ts';
import {
  previewCertifiedNodeNextPolicy,
  type NodeNextRewriteInput,
  type NodeNextRewriteProof,
} from './node-next-rewrite-proof.ts';
import {
  nodePackageCandidate,
  nodePackageHasExports,
  nodePackageImportsDirectory,
} from './node-package-lookup.ts';
import { nodePackageScope } from './node-package-scope.ts';
import {
  nodePackageMain,
  nodePackageName,
  preserveNodePackageSubpaths,
} from './node-package-subpaths.ts';
import type { NodePhysicalLayout as PhysicalLayout } from './node-physical-layout.ts';
import {
  originalNodeSpecifierInventory,
  type NodeSpecifierInventory,
  type NodeSourceSpecifier,
} from './node-source-specifiers.ts';

const PACKAGE_MANIFEST = 'package.json';
const COMMONJS_SUFFIXES = ['', '.js', '.json', '.node'] as const;
interface NodeModuleAliasSources {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly originals: ReadonlyMap<string, string>;
  /** Diagnostic provenance only; never changes alias admission or lookup order. */
  readonly required?: ReadonlySet<string>;
}
interface NodeAliasCachePolicy {
  readonly proof: NodeNextRewriteProof | undefined;
  readonly input: NodeNextRewriteInput;
}
type NodeModuleAliasOptions =
  | (() => Promise<void>)
  | {
      readonly collectRequiredAliases?: () => Promise<void>;
      readonly policy?: NodeAliasCachePolicy;
    };
type NameOf = PhysicalLayout['nameOf'];
// Only these existing resolver refusals mean an alternative supplied no closed layout evidence.
// Unknown AuditErrors, I/O failures and programming errors still propagate.
const UNPROVED_HINTS: ReadonlySet<string> = new Set([
  'Absolute Node module imports cannot be relocated into an artifact',
  'An absolute Node package entry cannot be relocated into an artifact',
  'A Node package alias requires a regular physical target',
  'A relative Node module lookup has no proved physical alias',
  'A relative package entry escapes its closed physical directory',
  'A relative package entry has no closed metadata',
  'Invalid Node package import scope metadata',
  'Native Function relocation changes a relative module or native binary lookup; refusing publication',
  'Node artifact input escapes both its tracing root and build output',
  'Node package export metadata is absent from its physical artifact',
  'Node package export requires an exact regular target',
  'Node package import external alias has no closed physical target',
  'Node package import has an unproved builtin target',
  'Node package import has an unproved external target',
  'Node package import has no closed package scope',
  'Node package import requires a literal target; conditions and chains are unsupported',
  'Node package import requires an exact regular target file',
  'Node package import requires a proved exact mapping; patterns are unsupported',
  'Node package import scope metadata is not closed',
  'Node package import target escapes its package scope',
  'Node package subpath has unproved export or physical topology',
  OUTSIDE_CLOSED_TRACE,
]);

function unprovedHint(error: unknown): boolean {
  return (
    (error instanceof AuditError && UNPROVED_HINTS.has(error.message)) ||
    (error instanceof Error &&
      'code' in error &&
      ['ENOENT', 'ENOTDIR', 'MODULE_NOT_FOUND'].includes(String(error.code)))
  );
}
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** A moved distDir must not make an unchanged relative lookup name a different location. */
export function assertNodeRelativeTopology(importer: string, target: string, nameOf: NameOf): void {
  const relative = path.relative(path.dirname(importer), target).split(path.sep).join('/');
  const owner = path.posix.dirname(nameOf(importer));
  const lookedUp = path.posix.normalize(path.posix.join(owner, relative));
  if (lookedUp !== nameOf(target)) {
    throw new AuditError(
      'Native Function relocation changes a relative module or native binary lookup; refusing publication',
    );
  }
}

function assertSpecifierTopology(file: string, specifier: string, layout: PhysicalLayout): void {
  if (!specifier.startsWith('.')) return;
  const target = path.resolve(path.dirname(file), specifier);
  // Optional missing modules outside the closed trace retain their existing audit/fallback.
  // Known roots, including an extensionless relative import, must preserve their topology.
  if (
    beneath(layout.root, target) !== undefined ||
    (layout.distDir !== undefined && beneath(layout.distDir, target) !== undefined)
  )
    assertNodeRelativeTopology(file, target, layout.nameOf);
}

interface PackageAliasContext {
  readonly layout: PhysicalLayout;
  readonly sources: NodeModuleAliasSources;
  readonly links: Map<string, string>;
  readonly kind: NodeSourceSpecifier['kind'];
  readonly lookup?: 'imports-target';
}
type ModuleAliasContext = Omit<PackageAliasContext, 'kind' | 'lookup'>;

function ownsDirectory(sources: NodeModuleAliasSources, target: string): boolean {
  for (const file of sources.originals.keys()) if (beneath(target, file) !== undefined) return true;
  return false;
}

async function assertPackageTarget(target: string, context: PackageAliasContext): Promise<void> {
  const info = await stat(target);
  const name = context.layout.nameOf(target);
  if (info.isFile()) {
    if (!context.sources.originals.has(target)) throw nodeAliasOutsideTrace(target);
    return;
  }
  if (!info.isDirectory())
    throw new AuditError('A Node package alias requires a regular physical target');
  if (!ownsDirectory(context.sources, target)) throw nodeAliasOutsideTrace(target);
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

async function assertPackageLocation(alias: string, context: PackageAliasContext): Promise<void> {
  try {
    context.layout.nameOf(await realpath(alias));
  } catch (error) {
    if (!absentRelativePath(error)) throw error;
  }
}

/** Package exports precede the CommonJS file candidates, which precede directory/main. */
async function bareFileAlias(
  alias: string,
  specifier: string,
  pkg: string,
  context: PackageAliasContext,
): Promise<boolean> {
  // A package root file cannot satisfy a subpath, and exports may be import-only.
  if (specifier !== pkg || (await nodePackageHasExports(alias))) return false;
  for (const suffix of COMMONJS_SUFFIXES) {
    const logical = `${alias}${suffix}`;
    try {
      if (!(await stat(logical)).isFile()) continue;
      return await recordPackageAlias(logical, context);
    } catch (error) {
      if (!absentRelativePath(error)) throw error;
    }
  }
  return false;
}
async function mappedPackageAlias(
  file: string,
  specifier: string,
  pkg: string,
  context: PackageAliasContext,
): Promise<boolean> {
  const alias = await nodePackageImportsDirectory(file, pkg);
  if (alias === undefined || !(await recordPackageAlias(alias, context))) return false;
  await packageSubpathAliases(await realpath(alias), specifier, pkg, context);
  return true;
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
  const scope = await nodePackageScope(file, context);
  if (
    scope?.metadata['name'] === pkg &&
    scope.metadata['exports'] !== undefined &&
    scope.metadata['exports'] !== null
  ) {
    await packageSubpathAliases(path.dirname(scope.file), specifier, pkg, context);
    return true;
  }
  const require = createRequire(file);
  // Search paths are independent of exports conditions. Import-only packages may forbid both
  // require(pkg) and require(pkg/package.json), but still need their original physical alias.
  const searches = require.resolve.paths(pkg) ?? [];
  for (const search of searches) {
    const alias = path.join(search, pkg);
    if (context.kind === 'require' && (await bareFileAlias(alias, specifier, pkg, context)))
      return true;
    if (context.kind === 'require') await assertPackageLocation(alias, context);
    if (!(await nodePackageCandidate(file, alias, { specifier, kind: context.kind }, pkg)))
      continue;
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
  const file = path.join(directory, PACKAGE_MANIFEST);
  await preserveNodePackageSubpaths({
    directory,
    specifier,
    packageName: pkg,
    metadata: context.sources.files.get(context.layout.nameOf(file)),
    relativeAlias: (target) => {
      return specifier === pkg || context.lookup === undefined
        ? relativeAliases(file, target, context)
        : relativePackageImport(file, target, context);
    },
    exactAlias: (target) => relativePackageImport(file, target, context),
  });
}

function packageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  const scope = await nodePackageScope(importer, context);
  if (scope === undefined) throw new AuditError('Node package import has no closed package scope');
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
  if (
    !(await mappedPackageAlias(scope.file, target, pkg, { ...context, lookup: 'imports-target' }))
  )
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
  return nodePackageMain(logical, metadata.main);
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

async function relativeFileAlias(
  logical: string,
  resolved: string,
  context: PackageAliasContext,
  exact = true,
): Promise<boolean> {
  const suffixes = exact ? COMMONJS_SUFFIXES : COMMONJS_SUFFIXES.slice(1);
  for (const suffix of suffixes)
    if (await matchingRelativeAlias(`${logical}${suffix}`, resolved, context)) return true;
  return false;
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
  const directoryOnly = specifier.endsWith('/') || ['.', '..'].includes(path.basename(specifier));
  // Node checks exact/extension files before consulting a same-name directory's package.json.
  if (!directoryOnly && (await relativeFileAlias(logical, resolved, context))) return;
  const main = await relativeMain(logical, context);
  await relativeDirectoryAlias(logical, context);
  if (
    main !== undefined &&
    ((await relativeFileAlias(main, resolved, context)) ||
      (await relativeFileAlias(path.join(main, 'index'), resolved, context, false)))
  )
    return;
  if (await relativeFileAlias(path.join(logical, 'index'), resolved, context, false)) return;
  throw new AuditError('A relative Node module lookup has no proved physical alias');
}

async function moduleAlias(
  file: string,
  load: NodeSourceSpecifier,
  input: ModuleAliasContext,
): Promise<void> {
  const { specifier, kind } = load;
  const context = { ...input, kind };
  assertSpecifierTopology(file, specifier, context.layout);
  await relativeAliases(file, specifier, context);
  await packageImports(file, specifier, context);
  await packageAliases(file, specifier, context);
}

async function alternativeAlias(
  file: string,
  load: NodeSourceSpecifier,
  context: ModuleAliasContext,
  hierarchy: NodeAliasCompatibility,
): Promise<void> {
  const staged = new Map<string, string>();
  try {
    await moduleAlias(file, load, { ...context, links: staged });
  } catch (error) {
    if (!unprovedHint(error)) throw error;
    return;
  }
  // Preserve both exact links and every parent/child mapping, including staged siblings.
  const pending = new NodeAliasCompatibility();
  for (const [alias, target] of staged) {
    if (!hierarchy.accepts(alias, target) || !pending.accepts(alias, target)) return;
    pending.add(alias, target);
  }
  for (const [alias, target] of staged) {
    context.links.set(alias, target);
    hierarchy.add(alias, target);
  }
}

function uniqueLoads(loads: readonly NodeSourceSpecifier[]): Map<string, NodeSourceSpecifier> {
  return new Map(loads.map((load) => [`${load.kind}:${load.specifier}`, load]));
}

function aliasInventory(
  file: string,
  bytes: Uint8Array | undefined,
  policy: NodeAliasCachePolicy | undefined,
): NodeSpecifierInventory {
  if (policy?.proof === undefined) return originalNodeSpecifierInventory(file, bytes);
  const preview = previewCertifiedNodeNextPolicy(policy.proof, policy.input, {
    file,
    code: new TextDecoder().decode(bytes),
  });
  const analysis = preview === undefined ? bytes : new TextEncoder().encode(preview);
  return originalNodeSpecifierInventory(file, analysis);
}

export async function nodeModuleAliases(
  sources: NodeModuleAliasSources,
  layout: PhysicalLayout,
  links: Map<string, string>,
  options?: NodeModuleAliasOptions,
): Promise<void> {
  const collectRequiredAliases =
    typeof options === 'function' ? options : options?.collectRequiredAliases;
  const policy = typeof options === 'function' ? undefined : options?.policy;
  const context = { sources, layout, links };
  const inventories: { file: string; inventory: NodeSpecifierInventory }[] = [];
  for (const [file, name] of sources.originals) {
    const inventory = aliasInventory(file, sources.files.get(name), policy);
    inventories.push({ file, inventory });
  }
  // Complete every strict lookup first; no later layout hint can overwrite a required link.
  for (const { file, inventory } of inventories) {
    for (const load of uniqueLoads(inventory.required).values()) {
      try {
        await moduleAlias(file, load, context);
      } catch (error) {
        throw nodeAliasLookupError(error, layout.root, file, {
          ...load,
          requiredInput: sources.required?.has(file),
        });
      }
    }
  }
  // Trace and native lookup evidence is required too; its failures are never optional hints.
  await collectRequiredAliases?.();
  const hierarchy = new NodeAliasCompatibility(links);
  for (const { file, inventory } of inventories) {
    const required = uniqueLoads(inventory.required);
    for (const [key, load] of uniqueLoads(inventory.alternatives))
      if (!required.has(key)) await alternativeAlias(file, load, context, hierarchy);
  }
}
