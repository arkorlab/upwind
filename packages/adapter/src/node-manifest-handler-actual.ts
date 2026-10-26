import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { beneath } from './build-paths.ts';
import type {
  NodeManifestHandlerGraphData,
  NodeManifestHandlerImportData,
  NodeManifestHandlerRowData,
} from './node-manifest-handler-graph.ts';
import {
  nodeManifestPassMembers,
  type NodeManifestRegistrationPass,
} from './node-manifest-registration-pass.ts';
import type {
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';
import type {
  NodeManifestTurbopackModuleId,
  NodeManifestTurbopackImport,
} from './node-manifest-turbopack.ts';
import { nodeManifestWholeFactoryData } from './node-manifest-whole-factory-data.ts';

interface ActualInput {
  readonly pass: NodeManifestRegistrationPass;
  readonly rows: readonly NodeManifestTurbopackGraphFactory[];
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly root: NodeManifestTurbopackGraphFactory;
  readonly nextRoot: string;
}
export interface NodeManifestHandlerActualData {
  readonly graph: NodeManifestHandlerGraphData;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
}
const MAX_ROWS = 256;

/** DATA only. Ownership, source freshness, catalog choice and role minting stay in the context. */
export function nodeManifestHandlerActualData(
  input: ActualInput,
): NodeManifestHandlerActualData | undefined {
  const rows = new Map(input.rows.map((row) => [row.id, row]));
  const sources = new Map(input.sources.map((source) => [source.id, source]));
  const pending = [input.root];
  const visited = new Set<NodeManifestTurbopackGraphFactory>();
  const physical = new Map<string, NodeManifestTurbopackGraphFile>();
  const actual: NodeManifestHandlerRowData[] = [];
  const rootRuntime = input.root.runtimeId;
  if (rootRuntime === undefined || rows.get(input.root.id) !== input.root) return undefined;
  const runtime = rootRuntime;

  function registration(id: string): NodeManifestTurbopackGraphFactory | undefined {
    const members = nodeManifestPassMembers(input.pass, id);
    if (members === undefined || members.length !== 1) return undefined;
    const row = rows.get(members[0] ?? '');
    return row?.runtimeId === runtime ? row : undefined;
  }
  function selected(
    id: NodeManifestTurbopackModuleId,
  ): NodeManifestTurbopackGraphFactory | undefined {
    const matching = input.rows.filter(
      (row) => row.runtimeId === runtime && row.projection.moduleId === id,
    );
    const only = matching[0];
    return only !== undefined && matching.length === 1 && registration(only.id) === only
      ? only
      : undefined;
  }
  function resolved(row: NodeManifestTurbopackGraphFactory, specifier: string): string | undefined {
    const edges = row.imports.filter((edge) => edge.specifier === specifier);
    const first = edges[0];
    return first !== undefined && edges.every((edge) => edge.target === first.target)
      ? first.target
      : undefined;
  }
  function dependency(
    row: NodeManifestTurbopackGraphFactory,
    entry: NodeManifestTurbopackImport,
  ): NodeManifestHandlerImportData | undefined {
    const target = resolved(row, entry.specifier);
    if (target === undefined) return undefined;
    if (entry.kind !== 'external') {
      const child = registration(target);
      if (child === undefined || child.projection.moduleId !== entry.targetId) return undefined;
      pending.push(child);
      return { ...entry, target: { kind: 'module', runtime, moduleId: child.projection.moduleId } };
    }
    if (isBuiltin(target)) return { ...entry, target: { kind: 'builtin', id: target } };
    const source = sources.get(target);
    if (source === undefined) return undefined;
    const relative = beneath(input.nextRoot, source.file)?.split(path.sep).join('/');
    if (relative === undefined || relative.length === 0) return undefined;
    physical.set(source.id, source);
    return {
      ...entry,
      target: {
        kind: 'next-source',
        root: input.nextRoot,
        relative,
        file: source.file,
        sha256: source.source.sha256,
      },
    };
  }
  function imported(
    row: NodeManifestTurbopackGraphFactory,
  ): readonly NodeManifestHandlerImportData[] | undefined {
    const result: NodeManifestHandlerImportData[] = [];
    for (const entry of row.projection.imports) {
      const resolvedEntry = dependency(row, entry);
      if (resolvedEntry === undefined) return undefined;
      result.push(resolvedEntry);
    }
    // The complete original ledger and actual resolver must cover precisely the same requests.
    if (
      row.imports.some((edge) =>
        row.projection.imports.every((entry) => entry.specifier !== edge.specifier),
      )
    )
      return undefined;
    return result;
  }

  function materialized(
    row: NodeManifestTurbopackGraphFactory,
  ): NodeManifestHandlerRowData | undefined {
    const original = sources.get(row.physicalId);
    if (original === undefined || original.source !== row.projection.original) return undefined;
    if (createHash('sha256').update(original.source.code).digest('hex') !== original.source.sha256)
      return undefined;
    physical.set(original.id, original);
    for (const id of row.projection.factory.ids) {
      const sibling = selected(id);
      if (
        sibling === undefined ||
        sibling.physicalId !== row.physicalId ||
        sibling.projection.factory.start !== row.projection.factory.start ||
        sibling.projection.factory.end !== row.projection.factory.end
      )
        return undefined;
      pending.push(sibling);
    }
    const imports = imported(row);
    if (imports === undefined) return undefined;
    const projection = row.projection;
    return {
      physicalId: row.physicalId,
      runtime,
      moduleId: projection.moduleId,
      whole: nodeManifestWholeFactoryData(projection),
      imports,
      operations: {
        cacheInitializers: projection.cacheInitializers,
        asyncLoads: projection.asyncLoads,
        ...(projection.asyncLoader !== undefined && { asyncLoader: projection.asyncLoader }),
        boundRuntimeInputs: projection.boundRuntimeInputs,
      },
    };
  }
  if (registration(input.root.id) !== input.root) return undefined;
  while (pending.length > 0) {
    const row = pending.pop();
    if (row === undefined || visited.has(row)) continue;
    if (visited.size >= MAX_ROWS) return undefined;
    visited.add(row);
    const value = materialized(row);
    if (value === undefined) return undefined;
    actual.push(value);
  }
  return {
    graph: {
      root: { runtime, moduleId: input.root.projection.moduleId },
      nextRoot: input.nextRoot,
      rows: actual,
    },
    sources: [...physical.values()],
  };
}
