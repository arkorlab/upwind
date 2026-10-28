import { AuditError } from './dependencies.ts';
import { directExternalNamespace } from './node-manifest-external-forwarder.ts';
import {
  nodeManifestRuntimeCohortLookup,
  type NodeManifestRuntimeCohort,
} from './node-manifest-runtime-cohort.ts';
import type {
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';

export function forwarded(factory: NodeManifestTurbopackGraphFactory): string | undefined {
  const own = factory.projection.exports;
  const specifier =
    own.kind === 'namespace' ? own.specifier : directExternalNamespace(factory.projection);
  if (specifier === undefined) return undefined;
  const edges = factory.imports.filter((edge) => edge.specifier === specifier);
  if (edges.length !== 1)
    throw new AuditError(
      'Unproved Next.js Turbopack manifest chain ambiguous namespace forwarder; refusing native publication',
    );
  return edges[0]?.target;
}

/** The runtime's own table-closure edge is not an external runtime API consumer. */
export function knownRuntimeCaller(
  source: string,
  edge: NodeManifestTurbopackGraphFile['imports'][number],
  context: {
    readonly boots: ReadonlySet<string>;
    readonly cohort: NodeManifestRuntimeCohort | undefined;
  },
): boolean {
  return (
    source === edge.target ||
    context.boots.has(source) ||
    (context.cohort !== undefined && nodeManifestRuntimeCohortLookup(context.cohort, source, edge))
  );
}
