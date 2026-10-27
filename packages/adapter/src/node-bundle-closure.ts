import { realpath } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { compareCodeUnits } from '@stayingupwind/core/util';
import type { OutputChunk } from 'rolldown';

import { AuditError } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';
import type { NativeLoad } from './native-loads.ts';
import type { ManifestGraphEdge, ManifestModuleGraph } from './node-manifest-graph.ts';

const ROLLDOWN_RUNTIME_MODULE = '\0rolldown/runtime.js';
const SHA256 = /^[a-f\d]{64}$/u;

export interface NodeProofSource {
  readonly file: string;
  readonly sha256: string;
}
export interface NodeBundledImport {
  readonly from: NodeProofSource;
  readonly to: NodeProofSource;
}
export interface NodeSourceExports {
  readonly format: 'es' | 'cjs' | 'unknown';
  readonly declared: readonly string[];
  readonly rendered: readonly string[];
}
interface RawSourceInput {
  readonly graph: {
    readonly sources: ReadonlyMap<string, NodeProofSource>;
    readonly retained: ReadonlySet<string>;
    readonly rendered: ReadonlyMap<string, string> | undefined;
    readonly imports: ReadonlyMap<string, readonly ManifestGraphEdge[]> | undefined;
  };
  readonly roots: readonly string[];
  readonly nativeFiles: ReadonlySet<string>;
  readonly exports: ReadonlyMap<string, NodeSourceExports>;
  readonly bundledImports?: readonly NodeBundledImport[];
  readonly runtimeImports?: readonly NodeBundledImport[] | undefined;
}

function runtimeDependencies(source: NodeProofSource, input: RawSourceInput): readonly string[] {
  return (input.runtimeImports ?? []).flatMap((edge) => {
    if (edge.from.file !== source.file) return [];
    if (edge.from.sha256 !== source.sha256) refuse('runtime caller source changed');
    const targets = [...input.graph.sources].filter(
      ([, target]) => target.file === edge.to.file && target.sha256 === edge.to.sha256,
    );
    if (targets.length !== 1) refuse('missing or ambiguous runtime dependency');
    return [targets[0]?.[0] ?? refuse('missing runtime dependency')];
  });
}

function refuse(reason: string): never {
  throw new AuditError(`Unproved original Node raw source closure: ${reason}`);
}

/** Rolldown's generated interop helper has no physical input. No other virtual id is exempt. */
export function isNodeProofCompilerModule(id: string): boolean {
  return id === ROLLDOWN_RUNTIME_MODULE;
}

function physicalSource(source: NodeProofSource | undefined): source is NodeProofSource {
  return (
    source !== undefined &&
    path.isAbsolute(source.file) &&
    path.resolve(source.file) === source.file &&
    SHA256.test(source.sha256)
  );
}

function bundledImport(
  from: NodeProofSource,
  to: NodeProofSource | undefined,
  boundaries: readonly NodeBundledImport[],
): boolean {
  if (to === undefined) return false;
  return boundaries.some((boundary) => {
    return (
      boundary.from.file === from.file &&
      boundary.from.sha256 === from.sha256 &&
      boundary.to.file === to.file &&
      boundary.to.sha256 === to.sha256
    );
  });
}

function rawModule(input: RawSourceInput, id: string) {
  const { graph } = input;
  const source = graph.sources.get(id);
  if (!physicalSource(source) || !graph.retained.has(id) || graph.rendered?.has(id) !== true)
    refuse('raw source lacks retained rendered physical proof');
  const imports = graph.imports?.get(id);
  if (imports === undefined) refuse('raw source has no resolved import inventory');
  const exports = input.exports.get(id);
  if (exports === undefined) refuse('raw source has no export inventory');
  if (exports.format === 'unknown' && (exports.declared.length > 0 || exports.rendered.length > 0))
    refuse('raw source export format is ambiguous');
  if (exports.format === 'es' && exports.declared.some((name) => !exports.rendered.includes(name)))
    refuse('raw source export was eliminated');
  return { source, imports };
}

/** Join actual compiler export inventories as DATA; this grants no source or loader role. */
export function renderedNodeSourceExports(
  chunk: Pick<OutputChunk, 'modules'>,
  original: ReadonlyMap<string, NodeSourceExports>,
): ReadonlyMap<string, NodeSourceExports> {
  return new Map(
    Object.entries(chunk.modules).flatMap(([id, module]) => {
      const info = original.get(id);
      return info === undefined
        ? []
        : [
            [
              id,
              Object.freeze({ ...info, rendered: Object.freeze([...module.renderedExports]) }),
            ] as const,
          ];
    }),
  );
}

/** DATA selection only. Completed proof ownership and source audits remain the caller's duty. */
export function nodeRawSourceInventory(input: RawSourceInput): readonly NodeProofSource[] {
  const { graph } = input;
  const pending = input.roots.map((file) => {
    const matches = [...graph.sources].filter(([, source]) => source.file === file);
    if (matches.length !== 1) return refuse('missing or ambiguous raw root');
    return matches[0]?.[0] ?? refuse('missing raw root');
  });
  const visited = new Set<string>();
  const sources = new Map<string, NodeProofSource>();
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (visited.has(id)) continue;
    visited.add(id);
    const { source, imports } = rawModule(input, id);
    const previous = sources.get(source.file);
    if (previous !== undefined && previous.sha256 !== source.sha256)
      refuse('conflicting raw source digests');
    sources.set(source.file, Object.freeze({ ...source }));
    pending.push(...runtimeDependencies(source, input));
    for (const edge of imports) {
      if (
        isBuiltin(edge.target) ||
        input.nativeFiles.has(edge.target) ||
        isNodeProofCompilerModule(edge.target)
      )
        continue;
      if (bundledImport(source, graph.sources.get(edge.target), input.bundledImports ?? []))
        continue;
      pending.push(edge.target);
    }
  }
  return Object.freeze(
    [...sources.values()].toSorted((left, right) => compareCodeUnits(left.file, right.file)),
  );
}

/** Immutable DATA projection only; the caller validates its private policy certificate first. */
export function nodeBundledImportInventory(
  records: Iterable<NodeProofSource & { readonly patch: string }>,
  hook: NodeProofSource | undefined,
  patch: string,
): readonly NodeBundledImport[] {
  if (hook === undefined) return Object.freeze([]);
  const to = Object.freeze({ file: hook.file, sha256: hook.sha256 });
  return Object.freeze(
    [...records].flatMap((record) => {
      if (record.patch !== patch) return [];
      const from = Object.freeze({ file: record.file, sha256: record.sha256 });
      return [Object.freeze({ from, to })];
    }),
  );
}

/** Existing hook-bundle source inventory; it grants no raw execution role. */
export function nodeHookSourceInventory(
  graph: ManifestModuleGraph,
  hook: NodeProofSource,
): ReadonlyMap<string, string> {
  const roots = [...graph.sources].filter(([, value]) => value.file === hook.file);
  if (roots.length !== 1 || roots[0]?.[1].sha256 !== hook.sha256)
    throw new AuditError(
      'Unproved Node Next.js rewrite selected hook source; refusing native publication',
    );
  const pending = roots.map(([id]) => id);
  const visited = new Set<string>();
  const sources = new Map<string, string>();
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (visited.has(id)) continue;
    visited.add(id);
    const original = graph.sources.get(id);
    if (original === undefined) continue;
    sources.set(original.file, original.sha256);
    const imports = graph.imports?.get(id);
    if (imports === undefined)
      throw new AuditError(
        'Unproved Node Next.js rewrite hook dependency inventory; refusing native publication',
      );
    for (const edge of imports) pending.push(edge.target);
  }
  return sources;
}

/** One shared physical project-hook identity, distinct from the generated host composition. */
export async function projectNodeInstrumentation(
  input: Pick<BuildFunctionInput, 'patch'>,
): Promise<string | undefined> {
  if (input.patch.instrumentation === undefined) return undefined;
  try {
    return await realpath(path.join(input.patch.distDir, 'server', 'instrumentation.js'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    return undefined;
  }
}

export function retainedNodeProofSources(
  chunk: Pick<OutputChunk, 'modules'>,
  graph: { readonly sources: ReadonlyMap<string, NodeProofSource> },
  entryFile: string,
): NodeProofSource[] {
  return Object.entries(chunk.modules).flatMap(([id, module]) => {
    if (module.code === null || isNodeProofCompilerModule(id)) return [];
    const original = graph.sources.get(id);
    if (original === undefined)
      throw new AuditError('Original Node graph includes a source without physical-file proof');
    if (original.file === entryFile) return [];
    return [original];
  });
}

export function includingNodeLoaderSources(
  sources: readonly NodeProofSource[],
  retained: readonly NativeLoad[],
  manifests: readonly NodeProofSource[],
): NodeProofSource[] {
  const files = new Map(sources.map((source) => [source.file, source]));
  for (const source of manifests) {
    const previous = files.get(source.file);
    if (previous !== undefined && previous.sha256 !== source.sha256)
      throw new AuditError('Reviewed Next.js manifest changed during original Node proof');
    files.set(source.file, source);
  }
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
