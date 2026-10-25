import path from 'node:path';

import { AuditError } from './dependencies.ts';
import {
  nodeManifestRuntimeCohortBoots,
  type NodeManifestRuntimeCohort,
} from './node-manifest-runtime-cohort.ts';
import type {
  NodeManifestTurbopackGraphFile,
  NodeManifestTurbopackBootGraph,
} from './node-manifest-turbopack-graph.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
} from './node-manifest-turbopack.ts';

interface RuntimeTablesInput {
  readonly distDir: string;
  readonly runtime: NodeManifestTurbopackGraphFile;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  /** Complete actual lookup inventory, already separated from sealed runtime identities. */
  readonly tables: readonly NodeManifestTurbopackGraphFile[];
  readonly runtimeIds: ReadonlySet<string>;
  readonly cohort?: NodeManifestRuntimeCohort | undefined;
}
function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js runtime installation ${reason}; refusing native publication`,
  );
}
function tableFor(
  chunk: string,
  input: RuntimeTablesInput,
  tables: ReadonlyMap<string, NodeManifestTurbopackGraphFile>,
): NodeManifestTurbopackGraphFile {
  const file = path.resolve(input.distDir, chunk);
  if (path.relative(input.distDir, file).split(path.sep).join('/') !== chunk)
    refuse('noncanonical chunk path');
  const source = input.sources.find((candidate) => candidate.file === file);
  if (source !== undefined && input.runtimeIds.has(source.id)) refuse('runtime used as a table');
  const table = tables.get(file);
  if (table === undefined) return refuse('unclosed literal chunk path');
  if (input.runtime.imports.every((edge) => edge.target !== table.id))
    refuse('missing actual runtime lookup');
  return table;
}

function deferredPaths(table: NodeManifestTurbopackGraphFile): {
  readonly open: boolean;
  readonly chunks: readonly string[];
} {
  const chunks: string[] = [];
  for (const factory of nodeManifestTurbopackFactories(table.source)) {
    for (const id of factory.ids) {
      const projection = projectNodeManifestTurbopackFactory(table.source, id, 'dependencies');
      if (projection.boundRuntimeInputs.some((binding) => binding.kind === 'loadChunk'))
        return { open: true, chunks: [] };
      chunks.push(...(projection.asyncLoader?.chunks ?? []));
    }
  }
  return { open: false, chunks };
}

/** Lookup availability is distinct from installation into a particular runtime's ModuleId Map. */
export function nodeManifestRuntimeTables(
  input: RuntimeTablesInput,
): readonly NodeManifestTurbopackGraphFile[] {
  if (input.cohort === undefined) return input.tables;
  const boots = nodeManifestRuntimeCohortBoots(input.cohort, input.sources).filter(
    (boot) => boot.runtimeId === input.runtime.id,
  );
  if (boots.length === 0) refuse('missing owned boot seeds');
  if (input.sources.find((source) => source.id === input.runtime.id) !== input.runtime)
    refuse('runtime source binding');
  for (const table of input.tables)
    if (input.sources.find((source) => source.id === table.id) !== table)
      refuse('table source binding');
  const tables = new Map(input.tables.map((table) => [table.file, table]));
  if (tables.size !== input.tables.length) refuse('ambiguous physical table');
  const pending = boots.flatMap((boot) => boot.chunks);
  const installed = new Map<string, NodeManifestTurbopackGraphFile>();
  while (pending.length > 0) {
    const chunk = pending.pop();
    if (chunk === undefined) continue;
    const table = tableFor(chunk, input, tables);
    if (installed.has(table.id)) continue;
    installed.set(table.id, table);
    const deferred = deferredPaths(table);
    // A bound callback is still open chunk-loading authority until its consumer closes.
    // Keep the previous conservative inventory for this runtime.
    if (deferred.open) return input.tables;
    pending.push(...deferred.chunks);
  }
  return Object.freeze([...installed.values()]);
}

/** Lookup-only targets still participate in the full physical caller inventory. */
export function nodeManifestRuntimeLookupTables(
  graphs: readonly NodeManifestTurbopackBootGraph[],
): ReadonlySet<string> {
  return new Set(
    graphs.flatMap(
      (graph) => graph.lookupTables ?? graph.factories.map((factory) => factory.physicalId),
    ),
  );
}
