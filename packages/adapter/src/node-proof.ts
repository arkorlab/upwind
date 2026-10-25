import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { rolldown, type OutputChunk, type Plugin } from 'rolldown';

import { appEntrySource } from './app-entry.ts';
import { jsLiteral } from './codegen.ts';
import {
  AuditError,
  auditNodeFunction,
  bundled,
  functionDependencies,
  outputNameOf,
  type FunctionDependencies,
} from './dependencies.ts';
import { dynamicLoadsInChunk } from './dynamic-loads.ts';
import type { BuildFunctionInput } from './function.ts';
import { nativeLoadsPlugin, type NativeLoad } from './native-loads.ts';
import type { NodeArchiveFile } from './node-archive.ts';
import { dynamicNodeClosureRefusal } from './node-closure-proof.ts';
import { cacheHandlersPatch } from './patches/cache-handlers.ts';
import { instrumentationPatch } from './patches/instrumentation.ts';
import type { AppliedPatch } from './patches/rolldown.ts';
import { turbopackRuntimePatch } from './patches/turbopack-runtime.ts';

const BYTES_PER_MEBIBYTE = 1_048_576;
const MAX_SOURCE_MEBIBYTES = 128;
const MAX_SOURCE_BYTES = MAX_SOURCE_MEBIBYTES * BYTES_PER_MEBIBYTE;
const MAX_DIAGNOSTIC_FILE_CHARACTERS = 240;
const ROLLDOWN_RUNTIME_MODULE = '\0rolldown/runtime.js';
// These expose the original Node graph. No Worker-specific code or dependency is substituted.
const GRAPH_LINKS = [turbopackRuntimePatch, instrumentationPatch, cacheHandlersPatch];

type NodeProofInput = Pick<
  BuildFunctionInput,
  'kind' | 'name' | 'projectDir' | 'outDir' | 'entries' | 'entryTraces' | 'patch'
>;
interface OriginalNodeSource {
  readonly file: string;
  readonly sha256: string;
}
interface OriginalNodeGraph {
  readonly sources: Map<string, OriginalNodeSource>;
  readonly patches: AppliedPatch[];
  readonly externals: Set<string>;
}
interface CopiedNodeSources {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly nameOf: (this: void, file: string) => string;
}

export interface NodeFunctionProof {
  readonly native: readonly NativeLoad[];
  readonly files: readonly OriginalNodeSource[];
  readonly dependencies: FunctionDependencies;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Rolldown's generated interop helper has no physical input. No other virtual id is exempt. */
export function isNodeProofCompilerModule(id: string): boolean {
  return id === ROLLDOWN_RUNTIME_MODULE;
}

/** The bytes audited and bundled must be a bounded, regular physical source. */
export async function nodeProofSource(file: string): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES)
    throw new AuditError('Original Node proof requires bounded regular source files');
  const bytes = await readFile(file);
  if (bytes.byteLength !== info.size)
    throw new AuditError('Original Node proof source changed while being read');
  return bytes;
}

async function proofEntry(input: NodeProofInput): Promise<string> {
  const work = path.join(input.outDir, 'work', `node-proof-${input.name ?? input.kind}`);
  await mkdir(work, { recursive: true });
  const entry = path.join(work, 'entry.cjs');
  await writeFile(
    entry,
    [
      appEntrySource(input.entries, { external: false, runtimeDistDir: input.patch.distDir }),
      ...(input.patch.instrumentation === undefined
        ? []
        : [
            `module.exports.instrumentation=()=>require(${jsLiteral(input.patch.instrumentation)});`,
          ]),
    ].join('\n'),
  );
  return realpath(entry);
}

function linkedSource(
  code: string,
  id: string,
  input: NodeProofInput,
  graph: OriginalNodeGraph,
): string {
  let contents = code;
  for (const patch of GRAPH_LINKS) {
    if (!patch.target.test(id) || (patch.marker !== undefined && !patch.marker(contents))) continue;
    const result = patch.apply(contents, id, input.patch);
    graph.patches.push({ patch: patch.name, file: id, result });
    contents = result.contents;
  }
  return contents;
}

async function originalNodeModule(
  id: string,
  input: NodeProofInput,
  graph: OriginalNodeGraph,
): Promise<{ code: string } | null> {
  if (!path.isAbsolute(id)) return null;
  const file = await realpath(id);
  const bytes = await nodeProofSource(file);
  graph.sources.set(id, { file, sha256: digest(bytes) });
  return { code: linkedSource(bytes.toString('utf8'), id, input, graph) };
}

function originalNodeGraphPlugin(input: NodeProofInput, graph: OriginalNodeGraph): Plugin {
  return {
    name: 'upwind-original-node-graph',
    load: {
      filter: { id: /\.(?:[cm]?[jt]sx?|json)$/u },
      handler: (id) => originalNodeModule(id, input, graph),
    },
  };
}

function retainedFileIdentity(projectDir: string, file: string): string {
  if (!path.isAbsolute(file)) return JSON.stringify('[non-physical module]');
  const relative = path.relative(projectDir, file).split(path.sep).join('/');
  const bounded =
    relative.length > MAX_DIAGNOSTIC_FILE_CHARACTERS
      ? `${relative.slice(0, MAX_DIAGNOSTIC_FILE_CHARACTERS)}…`
      : relative;
  return JSON.stringify(bounded);
}

function assertRetainedClosures(projectDir: string, chunk: OutputChunk): void {
  const modules = Object.entries(chunk.modules);
  for (const [file, module] of modules) {
    if (module.code === null || isNodeProofCompilerModule(file)) continue;
    const refusal = dynamicNodeClosureRefusal(file, module.code);
    if (refusal !== undefined) {
      const identity = retainedFileIdentity(projectDir, file);
      throw new AuditError(
        `Original Node graph has ${refusal} in ${identity}; refusing native publication`,
      );
    }
  }
}

function proofDependencies(
  input: NodeProofInput,
  chunk: OutputChunk,
  graph: OriginalNodeGraph,
): FunctionDependencies {
  return functionDependencies(
    input.projectDir,
    input.patch.distDir,
    {
      inputs: Object.entries(chunk.modules).map(([file, module]) => bundled(file, module)),
      externals: [...graph.externals],
      patches: graph.patches,
      stubs: [],
      wasmModules: [],
      dynamicLoads: dynamicLoadsInChunk(chunk),
    },
    { modules: [], size: { bytes: Buffer.byteLength(chunk.code), gzipBytes: 0 } },
  );
}

function retainedSources(
  chunk: OutputChunk,
  graph: OriginalNodeGraph,
  entryFile: string,
): OriginalNodeSource[] {
  return Object.keys(chunk.modules).flatMap((id) => {
    if (isNodeProofCompilerModule(id)) return [];
    const original = graph.sources.get(id);
    if (original === undefined)
      throw new AuditError('Original Node graph includes a source without physical-file proof');
    if (original.file === entryFile) return [];
    return [original];
  });
}

function includingLoaderSources(
  sources: readonly OriginalNodeSource[],
  retained: readonly NativeLoad[],
): OriginalNodeSource[] {
  const files = new Map(sources.map((source) => [source.file, source]));
  for (const load of retained) {
    const loaders = load.loaderSources ?? [];
    for (const source of loaders) {
      const previous = files.get(source.file);
      if (previous !== undefined && previous.sha256 !== source.sha256)
        throw new AuditError('Reviewed native loader changed during original Node proof');
      files.set(source.file, { file: source.file, sha256: source.sha256 });
    }
  }
  return [...files.values()];
}

/** Prove the retained original Node graph independently from every Worker patch and stub. */
export async function proveNodeFunction(input: NodeProofInput): Promise<NodeFunctionProof> {
  if (input.patch.cacheHandlers !== undefined)
    throw new AuditError('Native Node proof does not support custom cache handler closures');
  const entryFile = await proofEntry(input);
  const native = nativeLoadsPlugin(input.entryTraces ?? [], { nodeTarget: true });
  const graph: OriginalNodeGraph = { sources: new Map(), patches: [], externals: new Set() };
  await using bundle = await rolldown({
    cwd: input.projectDir,
    input: entryFile,
    platform: 'node',
    resolve: { conditionNames: ['node', 'default'] },
    plugins: [originalNodeGraphPlugin(input, graph), native.plugin],
    external(specifier) {
      if (!isBuiltin(specifier)) return false;
      graph.externals.add(specifier);
      return true;
    },
    transform: {
      define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_RUNTIME': '"nodejs"' },
    },
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT' && log.exporter !== undefined)
        graph.externals.add(log.exporter);
    },
  });
  const { output } = await bundle.generate({
    format: 'cjs',
    codeSplitting: false,
    minify: { compress: true, mangle: false, codegen: { removeWhitespace: true } },
    comments: { legal: false },
  });
  const chunk = output.find((item): item is OutputChunk => item.type === 'chunk');
  if (chunk === undefined) throw new AuditError('Original Node graph produced no proof chunk');
  assertRetainedClosures(input.projectDir, chunk);
  const retained = await native.retained(chunk);
  if (retained.length === 0)
    throw new AuditError('The original Node graph has no retained, owned native capability');
  const dependencies = proofDependencies(input, chunk, graph);
  auditNodeFunction(
    input.name ?? input.kind,
    { app: chunk.code },
    dependencies,
    outputNameOf(input.projectDir, input.patch.distDir),
  );
  const files = includingLoaderSources(retainedSources(chunk, graph, entryFile), retained);
  return { native: retained, files, dependencies };
}

function assertCopiedSource(
  original: OriginalNodeSource,
  copied: CopiedNodeSources,
  bundledHash: string | undefined,
): void {
  if (bundledHash !== undefined) {
    if (bundledHash !== original.sha256)
      throw new AuditError('Original Node instrumentation changed after its source proof');
    return;
  }
  const bytes = copied.files.get(copied.nameOf(original.file));
  if (bytes === undefined || digest(bytes) !== original.sha256)
    throw new AuditError(
      'Original Node graph source is absent or changed in its physical artifact',
    );
}

/** Compare original bytes before the explicit shared-cache/instrumentation artifact rewrites. */
export function assertNodeProofFiles(
  proof: NodeFunctionProof,
  physical: {
    readonly files: readonly NodeArchiveFile[];
    nameOf(this: void, file: string): string;
  },
  bundledInstrumentation: ReadonlyMap<string, string>,
): void {
  const files = new Map(physical.files.map((file) => [file.name, file.bytes]));
  const copied: CopiedNodeSources = { files, nameOf: physical.nameOf };
  const loaderFiles = new Set(
    proof.native.flatMap((load) => {
      return (load.loaderSources ?? []).map((source) => source.file);
    }),
  );
  for (const original of proof.files) {
    // A loader executes from the physical Node graph, even if a host hook bundled it too.
    const bundledHash = loaderFiles.has(original.file)
      ? undefined
      : bundledInstrumentation.get(original.file);
    assertCopiedSource(original, copied, bundledHash);
  }
}
