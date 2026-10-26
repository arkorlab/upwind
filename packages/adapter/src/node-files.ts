import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { compareCodeUnits } from '@stayingupwind/core/util';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';
import type { NativeLoad } from './native-loads.ts';
import type { NodeArchiveFile } from './node-archive.ts';
import { assertNodeRelativeTopology, nodeModuleAliases } from './node-module-aliases.ts';
import { nodeNativeAliases } from './node-native-aliases.ts';
import { nodePhysicalLayout, type NodePhysicalLayout } from './node-physical-layout.ts';

const MAX_FILE_BYTES = 134_217_728;
const EXECUTABLE_BITS = 0o111;
const PACKAGE_MANIFEST = 'package.json';

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

type PhysicalLayout = NodePhysicalLayout;
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

async function recordTraceAlias(
  logical: string,
  physical: string,
  layout: PhysicalLayout,
  links: Map<string, string>,
): Promise<void> {
  if (path.isAbsolute(logical) || logical.includes('\\')) return;
  const alias = path.resolve(layout.traceRoot, logical);
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
  metadataFiles: readonly { readonly file: string; readonly sha256: string }[] = [],
): Promise<NodePhysicalFiles> {
  const layout = await nodePhysicalLayout(input);
  for (const load of native)
    assertNodeRelativeTopology(
      await realpath(load.importer),
      await realpath(load.binary),
      layout.nameOf,
    );
  const instrumentation = await projectInstrumentation(input);
  const owned = inputFiles(input, instrumentation);
  for (const metadata of metadataFiles) owned.add(metadata.file);
  const sources = await physicalSources(owned, layout);
  const links = new Map<string, string>();
  await nodeModuleAliases(sources, layout, links);
  await traceAliases(input, layout, links);
  await nodeNativeAliases(native, sources, layout, links);
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
