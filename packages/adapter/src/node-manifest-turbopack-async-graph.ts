import path from 'node:path';

import { AuditError } from './dependencies.ts';
import type { NodeManifestTurbopackGraphFile } from './node-manifest-turbopack-graph.ts';
import {
  turbopackModuleSpecifier,
  type NodeManifestTurbopackModuleId,
  type NodeManifestTurbopackProjection,
} from './node-manifest-turbopack.ts';

interface AsyncFactory {
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly projection: NodeManifestTurbopackProjection;
}
interface AsyncGraphInput {
  readonly distDir: string;
  readonly tables: readonly NodeManifestTurbopackGraphFile[];
  readonly factories: ReadonlyMap<NodeManifestTurbopackModuleId, AsyncFactory>;
}

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack async graph ${reason}; refusing native publication`,
  );
}
function importRetained(factory: AsyncFactory, targetId: NodeManifestTurbopackModuleId): void {
  const retained = factory.projection.imports.some((edge) => {
    return (
      edge.kind === 'import' &&
      edge.targetId === targetId &&
      edge.specifier === turbopackModuleSpecifier(targetId)
    );
  });
  if (!retained) refuse('missing certified logical dependency');
}

function assertCalls(factory: AsyncFactory, factories: AsyncGraphInput['factories']): void {
  for (const loaderId of factory.projection.asyncLoads) {
    const loader = factories.get(loaderId);
    if (loader?.projection.asyncLoader === undefined) refuse('unregistered or uncertified loader');
    importRetained(factory, loaderId);
  }
}

function assertLoader(
  factory: AsyncFactory,
  input: AsyncGraphInput,
  tables: ReadonlyMap<string, NodeManifestTurbopackGraphFile>,
): void {
  const loader = factory.projection.asyncLoader;
  if (loader === undefined) return;
  if (!input.factories.has(loader.targetId)) refuse('unregistered loader target');
  importRetained(factory, loader.targetId);
  for (const chunk of loader.chunks) {
    const file = path.resolve(input.distDir, chunk);
    // The projection already requires a canonical literal ChunkData path. This comparison
    // binds it to a real, hash-checked table in this runtime's complete resolved lookup.
    if (path.relative(input.distDir, file).split(path.sep).join('/') !== chunk || !tables.has(file))
      refuse('unclosed literal chunk table');
  }
}

/** All certificates are checked, including factories that are not reached from a boot seed. */
export function assertTurbopackAsyncGraph(input: AsyncGraphInput): void {
  const tables = new Map(input.tables.map((table) => [table.file, table]));
  if (tables.size !== input.tables.length) refuse('ambiguous runtime table');
  for (const [id, factory] of input.factories) {
    if (factory.projection.moduleId !== id) refuse('selected module identity');
    assertCalls(factory, input.factories);
    assertLoader(factory, input, tables);
  }
}
