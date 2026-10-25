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

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const ROLLDOWN_RUNTIME_MODULE = '\0rolldown/runtime.js';
// These expose the original Node graph. No Worker-specific code or dependency is substituted.
const GRAPH_LINKS = [turbopackRuntimePatch, instrumentationPatch, cacheHandlersPatch];

type NodeProofInput = Pick<
  BuildFunctionInput,
  'kind' | 'name' | 'projectDir' | 'outDir' | 'entries' | 'entryTraces' | 'patch'
>;

export interface NodeFunctionProof {
  readonly native: readonly NativeLoad[];
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
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

/** Prove the retained original Node graph independently from every Worker patch and stub. */
export async function proveNodeFunction(input: NodeProofInput): Promise<NodeFunctionProof> {
  if (input.patch.cacheHandlers !== undefined)
    throw new AuditError('Native Node proof does not support custom cache handler closures');
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
  const entryFile = await realpath(entry);
  const native = nativeLoadsPlugin(input.entryTraces ?? [], { nodeTarget: true });
  const originals = new Map<string, { file: string; sha256: string }>();
  const patches: AppliedPatch[] = [];
  const externals = new Set<string>();
  const sources: Plugin = {
    name: 'upwind-original-node-graph',
    load: {
      filter: { id: /\.(?:[cm]?[jt]sx?|json)$/u },
      async handler(id) {
        if (!path.isAbsolute(id)) return null;
        const file = await realpath(id);
        const bytes = await nodeProofSource(file);
        originals.set(id, { file, sha256: digest(bytes) });
        let code = bytes.toString('utf8');
        for (const patch of GRAPH_LINKS) {
          if (!patch.target.test(id) || (patch.marker !== undefined && !patch.marker(code)))
            continue;
          const result = patch.apply(code, id, input.patch);
          patches.push({ patch: patch.name, file: id, result });
          code = result.contents;
        }
        return { code };
      },
    },
  };
  await using bundle = await rolldown({
    cwd: input.projectDir,
    input: entryFile,
    platform: 'node',
    resolve: { conditionNames: ['node', 'default'] },
    plugins: [sources, native.plugin],
    external(specifier) {
      if (!isBuiltin(specifier)) return false;
      externals.add(specifier);
      return true;
    },
    transform: {
      define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_RUNTIME': '"nodejs"' },
    },
    onLog(_level, log) {
      if (log.code === 'UNRESOLVED_IMPORT' && log.exporter !== undefined)
        externals.add(log.exporter);
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
  for (const [file, module] of Object.entries(chunk.modules)) {
    if (module.code === null || isNodeProofCompilerModule(file)) continue;
    const refusal = dynamicNodeClosureRefusal(file, module.code);
    if (refusal !== undefined)
      throw new AuditError(`Original Node graph has ${refusal}; refusing native publication`);
  }
  const retained = await native.retained(chunk);
  if (retained.length === 0)
    throw new AuditError('The original Node graph has no retained, owned native capability');
  const dependencies = functionDependencies(
    input.projectDir,
    input.patch.distDir,
    {
      inputs: Object.entries(chunk.modules).map(([file, module]) => bundled(file, module)),
      externals: [...externals],
      patches,
      stubs: [],
      wasmModules: [],
      dynamicLoads: dynamicLoadsInChunk(chunk),
    },
    { modules: [], size: { bytes: Buffer.byteLength(chunk.code), gzipBytes: 0 } },
  );
  auditNodeFunction(
    input.name ?? input.kind,
    { app: chunk.code },
    dependencies,
    outputNameOf(input.projectDir, input.patch.distDir),
  );
  const files = Object.keys(chunk.modules).flatMap((id) => {
    if (isNodeProofCompilerModule(id)) return [];
    const original = originals.get(id);
    if (original === undefined)
      throw new AuditError('Original Node graph includes a source without physical-file proof');
    if (original.file === entryFile) return [];
    return [original];
  });
  const sourceFiles = new Map(files.map((source) => [source.file, source]));
  for (const load of retained) {
    for (const source of load.loaderSources ?? []) {
      const previous = sourceFiles.get(source.file);
      if (previous !== undefined && previous.sha256 !== source.sha256)
        throw new AuditError('Reviewed native loader changed during original Node proof');
      sourceFiles.set(source.file, { file: source.file, sha256: source.sha256 });
    }
  }
  return { native: retained, files: [...sourceFiles.values()], dependencies };
}

/** Compare original bytes before the explicit shared-cache/instrumentation artifact rewrites. */
export function assertNodeProofFiles(
  proof: NodeFunctionProof,
  physical: { readonly files: readonly NodeArchiveFile[]; nameOf(file: string): string },
  bundledInstrumentation: ReadonlyMap<string, string>,
): void {
  const files = new Map(physical.files.map((file) => [file.name, file.bytes]));
  const loaderFiles = new Set(
    proof.native.flatMap((load) => (load.loaderSources ?? []).map((source) => source.file)),
  );
  for (const original of proof.files) {
    // A loader executes from the physical Node graph, even if a host hook bundled it too.
    const bundledHash = loaderFiles.has(original.file)
      ? undefined
      : bundledInstrumentation.get(original.file);
    if (bundledHash !== undefined) {
      if (bundledHash !== original.sha256)
        throw new AuditError('Original Node instrumentation changed after its source proof');
      continue;
    }
    const bytes = files.get(physical.nameOf(original.file));
    if (bytes === undefined || digest(bytes) !== original.sha256)
      throw new AuditError(
        'Original Node graph source is absent or changed in its physical artifact',
      );
  }
}
