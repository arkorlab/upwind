import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import {
  inspectNodeManifestTurbopackEntry,
  type NodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';

interface OwnedEntry {
  readonly id: string;
  readonly canonicalFilePath: string;
}
interface RuntimeCaller {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly role: 'input-entry' | 'pages-app' | 'pages-document';
  readonly ownerIds: readonly string[];
}
export interface NodeManifestRuntimeCallers {
  readonly callers: readonly RuntimeCaller[];
  readonly retained: readonly string[];
}
export interface NodeManifestRuntimeCallerProof {
  readonly callers: readonly {
    readonly id: string;
    readonly file: string;
    readonly sha256: string;
    readonly invoked: readonly string[];
  }[];
  readonly retained: readonly string[];
}
const CERTIFIED = new WeakSet<NodeManifestRuntimeCallers>();
const SHARED_ROLES = [
  ['_app.js', 'pages-app'],
  ['_document.js', 'pages-document'],
] as const;

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js runtime caller ${reason}; refusing native publication`);
}

function sourceByFile(
  sources: readonly NodeManifestTurbopackGraphFile[],
  file: string,
): NodeManifestTurbopackGraphFile | undefined {
  const matching = sources.filter((source) => source.file === file);
  if (matching.length > 1) refuse('ambiguous physical source');
  return matching[0];
}

async function traceOwns(
  trace: NativeAddonEntryTrace,
  file: string,
  root: string,
): Promise<boolean> {
  for (const [logical, value] of Object.entries(trace.assets)) {
    if (!path.isAbsolute(value)) continue;
    let canonical: string;
    try {
      canonical = await realpath(value);
    } catch {
      continue;
    }
    if (canonical !== file) continue;
    // Next29bbe mapBasePath uses path.relative(repoRoot, source), including ../ for external distDir.
    // Additional-root virtual destinations cannot prove this relation without their root metadata.
    if (
      logical.startsWith('next_additional_roots/') ||
      path.isAbsolute(logical) ||
      logical.length === 0 ||
      logical.includes('\\') ||
      path.normalize(logical) !== logical
    )
      refuse('unsupported shared trace key');
    let resolved: string;
    try {
      resolved = await realpath(path.resolve(root, logical));
    } catch {
      return refuse('shared trace logical identity');
    }
    if (resolved !== file) refuse('shared trace logical identity');
    return true;
  }
  return false;
}

interface RuntimeCallerInput {
  readonly rootDir: string;
  readonly distDir: string;
  readonly entries: readonly OwnedEntry[];
  /** Already sealed against the runtime manifest by the outer consumer graph. */
  readonly routes: readonly {
    readonly kind: string;
    readonly pathname: string;
    readonly file: string;
  }[];
  readonly entryTraces: readonly NativeAddonEntryTrace[];
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly retained: ReadonlySet<string>;
}

function pagesOwners(
  input: RuntimeCallerInput,
  entries: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const owners = new Set<string>();
  for (const page of input.routes) {
    if (page.kind !== 'pages') continue;
    if (entries.get(page.pathname) !== page.file) refuse('unsealed Pages owner');
    const source = sourceByFile(input.sources, page.file);
    if (source !== undefined && input.retained.has(source.id)) owners.add(page.pathname);
  }
  return owners;
}

async function sharedOwners(
  input: RuntimeCallerInput,
  pages: ReadonlySet<string>,
  file: string,
): Promise<readonly string[]> {
  const owners = new Set<string>();
  for (const trace of input.entryTraces) {
    if (pages.has(trace.id) && (await traceOwns(trace, file, input.rootDir))) owners.add(trace.id);
  }
  return Object.freeze([...owners]);
}

/** Ownership is separate from constructor roles. Neither a trace-only filename nor an importer grants it. */
export async function certifyNodeManifestRuntimeCallers(
  input: RuntimeCallerInput,
): Promise<NodeManifestRuntimeCallers> {
  if (!path.isAbsolute(input.rootDir) || !path.isAbsolute(input.distDir)) refuse('unsealed roots');
  const callers = new Map<string, RuntimeCaller>();
  const entries = new Map(input.entries.map((entry) => [entry.id, entry.canonicalFilePath]));
  if (entries.size !== input.entries.length) refuse('duplicate owned entry');
  for (const entry of input.entries) {
    const source = sourceByFile(input.sources, entry.canonicalFilePath);
    if (source === undefined || !input.retained.has(source.id)) continue;
    callers.set(source.id, {
      id: source.id,
      file: source.file,
      sha256: source.source.sha256,
      role: 'input-entry',
      ownerIds: Object.freeze([entry.id]),
    });
  }
  const pages = pagesOwners(input, entries);
  for (const [name, role] of SHARED_ROLES) {
    const file = path.join(input.distDir, 'server/pages', name);
    const source = sourceByFile(input.sources, file);
    if (source === undefined || callers.has(source.id) || !input.retained.has(source.id)) continue;
    if ((await realpath(file)) !== file) refuse('shared boot canonical identity');
    const ownerIds = await sharedOwners(input, pages, file);
    if (ownerIds.length > 0)
      callers.set(source.id, {
        id: source.id,
        file,
        sha256: source.source.sha256,
        role,
        ownerIds,
      });
  }
  const result = Object.freeze({
    callers: Object.freeze([...callers.values()].map((caller) => Object.freeze(caller))),
    retained: Object.freeze([...input.retained]),
  });
  CERTIFIED.add(result);
  return result;
}

function callerProof(input: {
  readonly caller: RuntimeCaller;
  readonly source: NodeManifestTurbopackGraphFile;
  readonly graph: NodeManifestTurbopackEntryGraph;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly distDir: string;
}): NodeManifestRuntimeCallerProof['callers'][number] {
  const { caller, source, graph, sources, distDir } = input;
  const boot = inspectNodeManifestTurbopackEntry(source.source);
  if (path.resolve(distDir, boot.publicPath) !== caller.file) refuse('boot public path');
  const edges = source.imports.filter((edge) => edge.specifier === boot.runtimeSpecifier);
  if (edges.length !== 1 || edges[0]?.target !== graph.runtimeId) refuse('boot runtime binding');
  const chunks = new Set<string>();
  for (const chunk of boot.chunks) {
    const target = sourceByFile(sources, path.resolve(distDir, chunk));
    if (
      target === undefined ||
      target.id === graph.runtimeId ||
      graph.runtime.imports.every((edge) => edge.target !== target.id)
    )
      refuse('unclosed boot chunk');
    chunks.add(target.id);
  }
  const modules = new Map(graph.factories.map((factory) => [factory.projection.moduleId, factory]));
  const invoked = new Set<string>();
  for (const id of [...boot.evaluations, boot.exportedId]) {
    const factory = modules.get(id);
    if (factory === undefined || !chunks.has(factory.physicalId))
      refuse('unregistered boot evaluation');
    invoked.add(factory.id);
  }
  return Object.freeze({
    id: caller.id,
    file: caller.file,
    sha256: caller.sha256,
    invoked: Object.freeze([...invoked]),
  });
}

/** Every admitted caller must use the same already reviewed runtime and its complete factory table. */
export function proveNodeManifestRuntimeCallers(input: {
  readonly inventory: NodeManifestRuntimeCallers;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly graphs: readonly NodeManifestTurbopackEntryGraph[];
  readonly distDir: string;
}): NodeManifestRuntimeCallerProof {
  if (!CERTIFIED.has(input.inventory)) refuse('uncertified caller inventory');
  const graphs = new Map(input.graphs.map((graph) => [graph.runtimeId, graph]));
  const callers: NodeManifestRuntimeCallerProof['callers'][number][] = [];
  for (const caller of input.inventory.callers) {
    const source = input.sources.find((candidate) => candidate.id === caller.id);
    if (
      source === undefined ||
      source.file !== caller.file ||
      source.source.sha256 !== caller.sha256
    )
      refuse('caller source binding');
    const runtimeIds = new Set(
      source.imports.filter((edge) => graphs.has(edge.target)).map((edge) => edge.target),
    );
    if (runtimeIds.size === 0) continue;
    if (runtimeIds.size !== 1) refuse('ambiguous boot runtime');
    const runtimeId = runtimeIds.values().next().value;
    const graph = runtimeId === undefined ? undefined : graphs.get(runtimeId);
    if (graph === undefined) refuse('unknown boot runtime');
    callers.push(
      callerProof({ caller, source, graph, sources: input.sources, distDir: input.distDir }),
    );
  }
  return Object.freeze({ callers: Object.freeze(callers), retained: input.inventory.retained });
}
