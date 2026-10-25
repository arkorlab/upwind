import { readFile, realpath, stat } from 'node:fs/promises';
import { createRequire, isBuiltin } from 'node:module';
import path from 'node:path';

import type { Node } from '@oxc-project/types';
import { compareCodeUnits } from '@stayingupwind/core/util';
import { parseAst } from 'rolldown/parseAst';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';
import type { NativeLoad } from './native-loads.ts';
import type { NodeArchiveFile } from './node-archive.ts';

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const EXECUTABLE_BITS = 0o111;

export interface NodePhysicalFiles {
  readonly files: NodeArchiveFile[];
  readonly links: readonly { readonly path: string; readonly target: string }[];
  readonly cwd: string;
  /** The original compiled project hook, distinct from the generated host composition. */
  readonly instrumentation: string | undefined;
  nameOf(this: void, file: string): string;
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

function staticString(node: Node | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function specifierIn(node: Node): string | undefined {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require'
  )
    return staticString(node.arguments[0]);
  if (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration') &&
    node.source !== null &&
    node.source !== undefined
  )
    return staticString(node.source);
  return node.type === 'ImportExpression' ? staticString(node.source) : undefined;
}

function astChildren(node: Node): Node[] {
  const children: Node[] = [];
  for (const value of Object.values(node)) {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of values) {
      if (typeof child === 'object' && child !== null && 'type' in child)
        children.push(child as Node);
    }
  }
  return children;
}

function strings(node: Node): string[] {
  const found: string[] = [];
  const pending = [node];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const specifier = specifierIn(current);
    if (specifier !== undefined) found.push(specifier);
    // Match the original source-order walk, without a recursive stack for large compiled files.
    const children = astChildren(current).reverse();
    for (const child of children) pending.push(child);
  }
  return found;
}

function packageName(specifier: string): string | undefined {
  if (
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.includes(':') ||
    specifier.startsWith('#')
  )
    return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
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
  const lookedUp = path.posix.normalize(
    path.posix.join(path.posix.dirname(nameOf(importer)), relative),
  );
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
  return new Set([
    ...(instrumentation === undefined ? [] : [instrumentation]),
    ...input.entries.map((entry) => entry.filePath),
    ...(input.entryTraces ?? []).flatMap((trace) => Object.values(trace.assets)),
    ...input.files.map((file) => file.filePath),
    ...input.edgeEntries.flatMap((entry) => entry.files),
    ...input.manifests.flatMap((manifest) => {
      return manifest.routeFile === undefined ? [] : [manifest.routeFile];
    }),
  ]);
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
    const manifest = path.join(dir, 'package.json');
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

function sourceSpecifiers(file: string, bytes: Uint8Array | undefined): string[] {
  if (!/\.[cm]?js$/u.test(file)) return [];
  try {
    return strings(parseAst(new TextDecoder().decode(bytes)));
  } catch {
    // NFT also names client/source files as data. The retained server graph was already parsed
    // and audited; a data file is not evidence of another runtime import edge.
    return [];
  }
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
  const owned = [...context.sources.originals.keys()].some(
    (file) => beneath(target, file) !== undefined,
  );
  if (!owned)
    throw new AuditError('The first existing Node package target is outside its closed trace');
  const metadata = path.join(target, 'package.json');
  try {
    await stat(metadata);
    if (!context.sources.files.has(path.posix.join(name, 'package.json')))
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
): Promise<void> {
  if (isBuiltin(specifier)) return;
  if (path.isAbsolute(specifier) || specifier.startsWith('file:'))
    throw new AuditError('Absolute Node module imports cannot be relocated into an artifact');
  const pkg = packageName(specifier);
  if (pkg === undefined) return;
  const require = createRequire(file);
  // Search paths are independent of exports conditions. Import-only packages may forbid both
  // require(pkg) and require(pkg/package.json), but still need their original physical alias.
  const searches = require.resolve.paths(pkg) ?? [];
  for (const search of searches) {
    if (await recordPackageAlias(path.join(search, pkg), context)) break;
  }
}

async function moduleAliases(
  sources: PhysicalSources,
  layout: PhysicalLayout,
  links: Map<string, string>,
): Promise<void> {
  const context = { sources, layout, links };
  for (const [file, name] of sources.originals) {
    const specifiers = new Set(sourceSpecifiers(file, sources.files.get(name)));
    for (const specifier of specifiers) {
      assertSpecifierTopology(file, specifier, layout);
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
  for (const trace of input.entryTraces ?? []) {
    for (const [logical, physical] of Object.entries(trace.assets))
      await recordTraceAlias(logical, physical, layout, links);
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
    if (![...files.keys()].some((file) => file === target || file.startsWith(`${target}/`)))
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
      return { name, bytes, ...(sources.executable.has(name) && { executable: true }) };
    }),
    links: emittedLinks(links, sources.files),
    cwd: layout.cwd,
    instrumentation,
    nameOf: layout.nameOf,
  };
}
