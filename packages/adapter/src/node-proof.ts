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
import { dynamicLoadsOf } from './dynamic-loads.ts';
import type { BuildFunctionInput } from './function.ts';
import { nativeLoadsPlugin, type NativeLoad } from './native-loads.ts';
import {
  includingNodeLoaderSources,
  isNodeProofCompilerModule,
  nodeRawSourceInventory,
  renderedNodeSourceExports,
  retainedNodeProofSources,
  type NodeSourceExports,
} from './node-bundle-closure.ts';
import { dynamicNodeClosureRefusal } from './node-closure-proof.ts';
import {
  qualifyNodeJwtCompiler,
  nodeJwtCompilerMetadata,
  type NodeJwtCompilerProof,
} from './node-jwt-compiler-proof.ts';
import type { ManifestGraphEdge, NodeManifestNormalization } from './node-manifest-graph.ts';
import {
  prepareNodeManifestHandlerCompilerRoot,
  assertCurrentUsedNodeManifestHandlerCompilerRoot,
} from './node-manifest-handler-root.ts';
import {
  assertNodeManifestIdentity,
  captureNodeManifestIdentity,
  type NodeManifestIdentitySnapshot,
} from './node-manifest-identity-snapshot.ts';
import { proveNodeManifests, type NodeManifestProof } from './node-manifest-proof.ts';
import {
  qualifyNodeNextCacheWrites,
  nodeNextCacheWriteMetadata,
  type NodeNextCacheWriteProof,
} from './node-next-cache-write-proof.ts';
import {
  qualifyNodeNextRequireHook,
  nodeNextRequireHookInspection,
  nodeNextRequireHookMetadata,
  type NodeNextRequireHookProof,
} from './node-next-require-hook-proof.ts';
import {
  certifyNodeNextRewrites,
  approvedNodeCompilerModules,
  assertCertifiedNodeRuntimePatches,
  nodeNextRewriteMetadata,
  nodeNextRewriteNormalization,
  nodeNextBundledImports,
  type NodeNextRewriteProof,
} from './node-next-rewrite-proof.ts';
import { linkedOriginalNodeSource } from './node-original-graph-source.ts';
import { originalHostLoadersPlugin } from './node-original-host-loaders.ts';
import { prepareOriginalNodeModes, type OriginalNodeModeScope } from './node-original-load-mode.ts';
import { retainedFileIdentity } from './node-proof-diagnostics.ts';
import { nodeRawFunctionInputs } from './node-raw-function-inputs.ts';
import {
  qualifyNodeWsLoaders,
  nodeWsLoaderMetadata,
  type NodeWsLoaderProof,
} from './node-ws-loader-proof.ts';

export { assertNodeProofFiles } from './node-original-load-mode-archive.ts';
export { isNodeProofCompilerModule } from './node-bundle-closure.ts';
import type { AppliedPatch } from './patches/rolldown.ts';

const BYTES_PER_MEBIBYTE = 1_048_576;
const MAX_SOURCE_MEBIBYTES = 128;
const MAX_SOURCE_BYTES = MAX_SOURCE_MEBIBYTES * BYTES_PER_MEBIBYTE;

type NodeProofInput = Partial<
  Pick<BuildFunctionInput, 'manifests' | 'runtimeManifest' | 'repoRoot' | 'clientAssetPrefix'>
> &
  Pick<
    BuildFunctionInput,
    'kind' | 'name' | 'projectDir' | 'outDir' | 'entries' | 'entryTraces' | 'patch'
  >;
interface OriginalNodeSource {
  readonly file: string;
  readonly sha256: string;
}
interface OriginalNodeGraph {
  readonly sources: Map<string, OriginalNodeSource>;
  readonly importers: Map<string, readonly string[]>;
  readonly resolutions: Map<string, Map<string, Set<string>>>;
  readonly imports: Map<string, readonly ManifestGraphEdge[]>;
  readonly roots: Set<string>;
  readonly patches: AppliedPatch[];
  readonly externals: Set<string>;
  readonly exports: Map<string, NodeSourceExports>;
}

export interface NodeFunctionProof {
  readonly native: readonly NativeLoad[];
  readonly files: readonly OriginalNodeSource[];
  readonly dependencies: FunctionDependencies;
  /** Physical Node load-mode facts only; never framework, strictness, or rewrite authority. */
  readonly originalModes: OriginalNodeModeScope;
  readonly normalization?: NodeManifestNormalization | undefined;
  readonly nextRewrites?: NodeNextRewriteProof;
  readonly jwtCompiler?: NodeJwtCompilerProof | undefined;
  readonly wsLoaders?: NodeWsLoaderProof | undefined;
  readonly nextRequireHook?: NodeNextRequireHookProof | undefined;
}
const RAW_SOURCES = new WeakMap<
  NodeFunctionProof,
  {
    readonly sources: readonly OriginalNodeSource[];
    readonly originalModes: OriginalNodeModeScope;
    readonly snapshot: NodeManifestIdentitySnapshot;
  }
>();

/** Only the completed proof instance exposes mandatory raw execution pins. */
export function nodeProofRawSources(proof: NodeFunctionProof): readonly OriginalNodeSource[] {
  const own = RAW_SOURCES.get(proof);
  if (own?.originalModes !== proof.originalModes)
    throw new AuditError('Original Node raw source pins require the completed proof instance');
  assertNodeManifestIdentity(own.snapshot, [proof.files, proof.native]);
  return own.sources;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
      appEntrySource(input.entries, {
        external: true,
        runtimeDistDir: input.patch.distDir,
        nodeRequestMeta: true,
      }),
      ...(input.patch.instrumentation === undefined
        ? []
        : [
            `module.exports.instrumentation=()=>require(${jsLiteral(input.patch.instrumentation)});`,
          ]),
    ].join('\n'),
  );
  return realpath(entry);
}

async function originalNodeModule(
  id: string,
  input: NodeProofInput,
  graph: OriginalNodeGraph,
): Promise<{ code: string; moduleSideEffects: true } | null> {
  if (!path.isAbsolute(id)) return null;
  const file = await realpath(id);
  const bytes = await nodeProofSource(file);
  graph.sources.set(id, { file, sha256: digest(bytes) });
  return {
    code: linkedOriginalNodeSource(bytes.toString('utf8'), id, input.patch, graph),
    moduleSideEffects: true,
  };
}

function resolvedEdges(
  importedIds: readonly string[],
  dynamicallyImportedIds: readonly string[],
  resolutions: ReadonlyMap<string, ReadonlySet<string>> | undefined,
): ManifestGraphEdge[] {
  const edges: ManifestGraphEdge[] = [];
  if (resolutions === undefined) return edges;
  const imported = new Set(importedIds);
  for (const dependency of dynamicallyImportedIds) imported.add(dependency);
  for (const [specifier, targets] of resolutions) {
    for (const target of targets) {
      if (imported.has(target)) edges.push({ specifier, target });
    }
  }
  return edges;
}

function originalNodeGraphPlugin(input: NodeProofInput, graph: OriginalNodeGraph): Plugin {
  return {
    name: 'upwind-original-node-graph',
    async resolveId(specifier, importer, options) {
      // eslint-disable-next-line unicorn/no-this-outside-of-class -- Record the bundler's actual resolution, preserving its result and native-plugin handling.
      const resolved = await this.resolve(specifier, importer, { ...options, skipSelf: true });
      if (resolved !== null && importer !== undefined) {
        let imports = graph.resolutions.get(importer);
        if (imports === undefined) {
          imports = new Map();
          graph.resolutions.set(importer, imports);
        }
        const targets = imports.get(specifier) ?? new Set<string>();
        targets.add(resolved.id);
        imports.set(specifier, targets);
      }
      return resolved;
    },
    load: {
      filter: { id: /\.(?:[cm]?[jt]sx?|json)$/u },
      handler: (id) => originalNodeModule(id, input, graph),
    },
    generateBundle() {
      // eslint-disable-next-line unicorn/no-this-outside-of-class -- Rolldown supplies its final module graph to this hook.
      const ids = this.getModuleIds();
      for (const id of ids) {
        // eslint-disable-next-line unicorn/no-this-outside-of-class -- Importers must come from Rolldown's resolved graph, not source-name guesses.
        const module = this.getModuleInfo(id);
        if (module === null) continue;
        graph.exports.set(id, {
          format: module.inputFormat,
          declared: Object.freeze([...module.exports]),
          rendered: [],
        });
        graph.importers.set(id, [...module.importers, ...module.dynamicImporters]);
        if (module.isEntry) graph.roots.add(id);
        graph.imports.set(
          id,
          resolvedEdges(
            module.importedIds,
            module.dynamicallyImportedIds,
            graph.resolutions.get(id),
          ),
        );
      }
    },
  };
}

async function assertRetainedSourceBytes(
  chunk: OutputChunk,
  graph: OriginalNodeGraph,
): Promise<void> {
  for (const id of Object.keys(chunk.modules)) {
    if (isNodeProofCompilerModule(id)) continue;
    const original = graph.sources.get(id);
    if (original === undefined)
      throw new AuditError('Original Node graph includes a source without physical-file proof');
    const bytes = await nodeProofSource(original.file);
    if (digest(bytes) !== original.sha256)
      throw new AuditError('Original Node source changed before its host-loader proof');
  }
}

function assertRetainedClosures(
  projectDir: string,
  chunk: OutputChunk,
  manifests: NodeManifestProof,
  closure: {
    readonly modules: ReadonlySet<string>;
    readonly jwt: NodeJwtCompilerProof | undefined;
    readonly ws: NodeWsLoaderProof | undefined;
    readonly nextRequireHook: NodeNextRequireHookProof | undefined;
    readonly nextCacheWrite: NodeNextCacheWriteProof | undefined;
  },
): void {
  const modules = Object.entries(chunk.modules);
  for (const [file, module] of modules) {
    if (module.code === null || isNodeProofCompilerModule(file) || closure.modules.has(file))
      continue;
    const inspection =
      nodeNextRequireHookInspection(closure.nextRequireHook, file, module.code) ??
      manifests.inspectionCode(file, module.code);
    const refusal = dynamicNodeClosureRefusal(file, inspection, closure.jwt, {
      ws: closure.ws,
      nextRequireHook: closure.nextRequireHook,
      nextCacheWrite: closure.nextCacheWrite,
    });
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
  compilerModules: ReadonlySet<string>,
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
      // Exact, byte-sealed production runtimes have separately proven compiler operations.
      // Their actual target chunks still pass the ordinary retained-code audit.
      dynamicLoads: Object.entries(chunk.modules).flatMap(([file, module]) =>
        module.code === null || compilerModules.has(file) ? [] : dynamicLoadsOf(file, module.code),
      ),
    },
    { modules: [], size: { bytes: Buffer.byteLength(chunk.code), gzipBytes: 0 } },
  );
}

/** Prove the retained original Node graph independently from every Worker patch and stub. */
export async function proveNodeFunction(input: NodeProofInput): Promise<NodeFunctionProof> {
  if (input.patch.cacheHandlers !== undefined)
    throw new AuditError('Native Node proof does not support custom cache handler closures');
  const entryFile = await proofEntry(input);
  const native = nativeLoadsPlugin(input.entryTraces ?? [], { nodeTarget: true });
  const graph: OriginalNodeGraph = {
    sources: new Map(),
    importers: new Map(),
    resolutions: new Map(),
    imports: new Map(),
    roots: new Set(),
    patches: [],
    externals: new Set(),
    exports: new Map(),
  };
  const hostLoaders = originalHostLoadersPlugin(graph.sources);
  await using bundle = await rolldown({
    cwd: input.projectDir,
    input: entryFile,
    platform: 'node',
    treeshake: { annotations: false, commonjs: false },
    resolve: { conditionNames: ['node', 'default'] },
    plugins: [originalNodeGraphPlugin(input, graph), hostLoaders.plugin, native.plugin],
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
    minify: {
      compress: { treeshake: { annotations: false } },
      mangle: false,
      codegen: { removeWhitespace: true },
    },
    comments: { legal: false },
  });
  const chunk = output.find((item): item is OutputChunk => item.type === 'chunk');
  if (chunk === undefined) throw new AuditError('Original Node graph produced no proof chunk');
  await assertRetainedSourceBytes(chunk, graph);
  const compilerRootBinding = await prepareNodeManifestHandlerCompilerRoot(
    Object.freeze({ projectDir: input.projectDir, distDir: input.patch.distDir }),
    Object.keys(chunk.modules).flatMap((id) => {
      const source = graph.sources.get(id);
      return source === undefined ? [] : [source];
    }),
  );
  const manifestGraph = {
    sources: graph.sources,
    importers: graph.importers,
    imports: graph.imports,
    roots: graph.roots,
    rendered: new Map(
      Object.entries(chunk.modules).flatMap(([id, module]) =>
        module.code === null ? [] : [[id, module.code] as const],
      ),
    ),
    retained: new Set(Object.keys(chunk.modules)),
  };
  const originalModes = await prepareOriginalNodeModes(
    {
      rootDir: input.repoRoot ?? input.projectDir,
      projectDir: input.projectDir,
      distDir: input.patch.distDir,
    },
    manifestGraph,
    [...manifestGraph.retained].filter((id) => !isNodeProofCompilerModule(id)),
  );
  const manifests = await proveNodeManifests(
    {
      distDir: input.patch.distDir,
      rootDir: input.repoRoot ?? input.projectDir,
      clientAssetPrefix: input.clientAssetPrefix,
      manifests: input.manifests,
      entryTraces: input.entryTraces,
      entries: input.entries,
      runtimeManifest: input.runtimeManifest,
      instrumentation: input.patch.instrumentation,
      analysisEntry: entryFile,
      compilerRootBinding,
      originalModes,
    },
    manifestGraph,
  );
  const compilerModules = approvedNodeCompilerModules(chunk.modules, graph.sources, manifests);
  assertCertifiedNodeRuntimePatches(chunk.modules, graph.patches, compilerModules, (file) =>
    retainedFileIdentity(input.projectDir, file),
  );
  const nextRewrites = await certifyNodeNextRewrites(
    input,
    manifestGraph,
    graph.patches,
    manifests,
  );
  const rewriteMetadata = nodeNextRewriteMetadata(nextRewrites);
  const initializationInput = {
    graph: manifestGraph,
    originalModes,
    patches: graph.patches,
    rewrites: nextRewrites,
    rewriteInput: { projectDir: input.projectDir, patch: input.patch, entries: input.entries },
    context: {
      distDir: input.patch.distDir,
      instrumentation: input.patch.instrumentation,
      entries: input.entries,
    },
    manifests: {
      ...(manifests.routeRewriteApprovals !== undefined && {
        routeRewriteApprovals: manifests.routeRewriteApprovals,
      }),
      normalization: manifests.normalization,
    },
  };
  const jwtCompiler = await qualifyNodeJwtCompiler(initializationInput);
  const wsLoaders = await qualifyNodeWsLoaders(initializationInput);
  const nextRequireHook = await qualifyNodeNextRequireHook(initializationInput);
  const nextCacheWrite = await qualifyNodeNextCacheWrites(initializationInput);
  const jwtMetadata =
    jwtCompiler === undefined ? [] : (await nodeJwtCompilerMetadata(jwtCompiler)).files;
  const wsMetadata = wsLoaders === undefined ? [] : (await nodeWsLoaderMetadata(wsLoaders)).files;
  const hookMetadata =
    nextRequireHook === undefined ? [] : (await nodeNextRequireHookMetadata(nextRequireHook)).files;
  const cacheWriteMetadata =
    nextCacheWrite === undefined ? [] : await nodeNextCacheWriteMetadata(nextCacheWrite);
  const retainedHost = hostLoaders
    .retained(chunk)
    .find((site) => !compilerModules.has(site.importer));
  if (retainedHost !== undefined) {
    const identity = retainedFileIdentity(input.projectDir, retainedHost.file);
    throw new AuditError(
      `Original Node graph has an unproved original CommonJS host loader in ${identity}; refusing native publication`,
    );
  }
  assertRetainedClosures(input.projectDir, chunk, manifests, {
    modules: compilerModules,
    jwt: jwtCompiler,
    ws: wsLoaders,
    nextRequireHook,
    nextCacheWrite,
  });
  const retained = await native.retained(chunk);
  if (retained.length === 0)
    throw new AuditError('The original Node graph has no retained, owned native capability');
  const dependencies = proofDependencies(input, chunk, graph, compilerModules);
  auditNodeFunction(
    input.name ?? input.kind,
    { app: chunk.code },
    dependencies,
    outputNameOf(input.projectDir, input.patch.distDir),
  );
  const files = includingNodeLoaderSources(
    retainedNodeProofSources(chunk, graph, entryFile),
    retained,
    [
      ...manifests.files,
      ...rewriteMetadata,
      ...jwtMetadata,
      ...wsMetadata,
      ...hookMetadata,
      ...cacheWriteMetadata,
    ],
  );
  const normalization = nodeNextRewriteNormalization(nextRewrites, manifests.normalization);
  await assertCurrentUsedNodeManifestHandlerCompilerRoot(compilerRootBinding, files);
  const rawSources = nodeRawSourceInventory({
    graph: manifestGraph,
    exports: renderedNodeSourceExports(chunk, graph.exports),
    ...(await nodeRawFunctionInputs(input, nextRequireHook)),
    nativeFiles: new Set(retained.map((load) => load.binary)),
    bundledImports: nodeNextBundledImports(nextRewrites, input),
  });
  const proof: NodeFunctionProof = {
    native: retained,
    originalModes,
    files,
    dependencies,
    nextRewrites,
    ...(jwtCompiler !== undefined && { jwtCompiler }),
    ...(wsLoaders !== undefined && { wsLoaders }),
    ...(nextRequireHook !== undefined && { nextRequireHook }),
    ...(normalization !== undefined && { normalization }),
  };
  RAW_SOURCES.set(proof, {
    sources: rawSources,
    originalModes,
    snapshot: captureNodeManifestIdentity([files, retained]),
  });
  return proof;
}
