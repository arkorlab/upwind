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

export interface NodePhysicalFiles {
  readonly files: NodeArchiveFile[];
  readonly links: readonly { readonly path: string; readonly target: string }[];
  readonly cwd: string;
  /** The original compiled project hook, distinct from the generated host composition. */
  readonly instrumentation: string | undefined;
  nameOf(file: string): string;
}

function strings(node: Node): string[] {
  const found: string[] = [];
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require'
  ) {
    const argument = node.arguments[0];
    if (argument?.type === 'Literal' && typeof argument.value === 'string')
      found.push(argument.value);
  }
  if (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration') &&
    node.source !== null &&
    node.source !== undefined
  ) {
    if (typeof node.source.value === 'string') found.push(node.source.value);
  }
  if (
    node.type === 'ImportExpression' &&
    node.source.type === 'Literal' &&
    typeof node.source.value === 'string'
  )
    found.push(node.source.value);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const part of value) {
        if (typeof part === 'object' && part !== null && 'type' in part)
          found.push(...strings(part as Node));
      }
    } else if (typeof value === 'object' && value !== null && 'type' in value)
      found.push(...strings(value as Node));
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
function assertRelativeTopology(
  importer: string,
  target: string,
  nameOf: (file: string) => string,
): void {
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

/** Physical traces plus explicit internal aliases; no user module is evaluated or rebundled. */
export async function nodePhysicalFiles(
  input: BuildFunctionInput,
  native: readonly NativeLoad[],
): Promise<NodePhysicalFiles> {
  const root = path.resolve(input.repoRoot ?? input.projectDir);
  const project = beneath(root, path.resolve(input.projectDir));
  if (project === undefined)
    throw new AuditError('Node project directory escapes its tracing root');
  const cwd = path.posix.join('project', project.split(path.sep).join('/'));
  function nameOf(file: string): string {
    const relative = beneath(root, path.resolve(file));
    if (relative !== undefined)
      return path.posix.join('project', relative.split(path.sep).join('/'));
    const built = beneath(input.patch.distDir, path.resolve(file));
    if (built !== undefined)
      return path.posix.join(cwd, '.upwind-build', built.split(path.sep).join('/'));
    throw new AuditError('Node artifact input escapes both its tracing root and build output');
  }
  for (const load of native) {
    assertRelativeTopology(await realpath(load.importer), await realpath(load.binary), nameOf);
  }
  let instrumentation: string | undefined;
  if (input.patch.instrumentation !== undefined) {
    try {
      instrumentation = await realpath(
        path.join(input.patch.distDir, 'server', 'instrumentation.js'),
      );
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  const sourceFiles = new Set([
    ...(instrumentation === undefined ? [] : [instrumentation]),
    ...input.entries.map((entry) => entry.filePath),
    ...(input.entryTraces ?? []).flatMap((trace) => Object.values(trace.assets)),
    ...input.files.map((file) => file.filePath),
    ...input.edgeEntries.flatMap((entry) => entry.files),
    ...input.manifests.flatMap((manifest) =>
      manifest.routeFile === undefined ? [] : [manifest.routeFile],
    ),
  ]);
  const files = new Map<string, Uint8Array>();
  const executable = new Set<string>();
  const originals = new Map<string, string>();
  for (const file of sourceFiles) {
    const canonical = await realpath(file);
    const name = nameOf(canonical);
    const bytes = await boundedFile(canonical);
    files.set(name, bytes);
    if (((await stat(canonical)).mode & 0o111) !== 0) executable.add(name);
    originals.set(canonical, name);
    // Node's package scope and exports metadata are part of the physical layout too.
    for (
      let dir = path.dirname(canonical);
      beneath(root, dir) !== undefined;
      dir = path.dirname(dir)
    ) {
      const manifest = path.join(dir, 'package.json');
      try {
        files.set(nameOf(manifest), await boundedFile(manifest));
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
      if (dir === root) break;
    }
  }
  const links = new Map<string, string>();
  for (const [file, name] of originals) {
    if (!/\.(?:c|m)?js$/u.test(file)) continue;
    const source = new TextDecoder().decode(files.get(name));
    let specifiers: string[];
    try {
      specifiers = strings(parseAst(source));
    } catch {
      // NFT also names client/source files as data. The retained server graph was already
      // parsed and audited; a data file is not evidence of another runtime import edge.
      continue;
    }
    for (const specifier of new Set(specifiers)) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        // Optional missing modules outside the closed trace retain their existing audit/fallback.
        // Known roots, including an extensionless relative import, must preserve their topology.
        if (
          beneath(root, target) !== undefined ||
          beneath(input.patch.distDir, target) !== undefined
        ) {
          assertRelativeTopology(file, target, nameOf);
        }
      }
      if (isBuiltin(specifier)) continue;
      if (path.isAbsolute(specifier) || specifier.startsWith('file:'))
        throw new AuditError('Absolute Node module imports cannot be relocated into an artifact');
      const pkg = packageName(specifier);
      if (pkg === undefined) continue;
      const require = createRequire(file);
      let resolved: string;
      try {
        resolved = require.resolve(specifier);
      } catch {
        continue;
      }
      for (const search of require.resolve.paths(pkg) ?? []) {
        const alias = path.join(search, pkg);
        try {
          const target = await realpath(alias);
          if (beneath(target, resolved) === undefined) continue;
          if (path.resolve(alias) !== target) links.set(nameOf(alias), nameOf(target));
          break;
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT')
            throw error;
        }
      }
    }
  }
  // Adapter API asset keys can retain a logical import alias that values canonicalize away.
  for (const trace of input.entryTraces ?? []) {
    for (const [logical, physical] of Object.entries(trace.assets)) {
      if (path.isAbsolute(logical) || logical.includes('\\')) continue;
      const alias = path.resolve(root, logical);
      try {
        const target = await realpath(alias);
        if (target !== path.resolve(alias) && target === (await realpath(physical))) {
          // A file alias is sufficient here; package aliases above preserve Node resolution.
          links.set(nameOf(alias), nameOf(target));
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
  }
  // Do not emit links already materialized by a physical trace, or children of a package alias.
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
  return {
    files: [...files].map(([name, bytes]) => ({
      name,
      bytes,
      ...(executable.has(name) && { executable: true }),
    })),
    links: emitted,
    cwd,
    instrumentation,
    nameOf,
  };
}
