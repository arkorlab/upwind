import { AuditError } from './dependencies.ts';
import { inspectNodeManifestReachability } from './node-manifest-reachability.ts';
import type { NodeManifestRegistrationPass } from './node-manifest-registration-pass.ts';
import {
  nodeManifestConsumerBoots,
  type NodeManifestRegistrationViews,
} from './node-manifest-registration-views.ts';
import type { NodeManifestRuntimeCallerProof } from './node-manifest-runtime-callers.ts';
import type { NodeManifestRuntimeCohort } from './node-manifest-runtime-cohort.ts';
import { nodeManifestRuntimeLookupTables } from './node-manifest-runtime-tables.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumer-input.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackEntryGraph,
  NodeManifestTurbopackGraphFactory,
} from './node-manifest-turbopack-graph.ts';
import { knownRuntimeCaller } from './node-manifest-turbopack-parents.ts';

export type NodeManifestIncomingFallback = ReturnType<
  typeof inspectNodeManifestReachability
>['fallback'];
function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest chain ${reason}; refusing native publication`,
  );
}
export function registerNodeManifestConsumerFactory(
  factory: NodeManifestTurbopackGraphFactory,
  factories: Map<string, NodeManifestTurbopackGraphFactory>,
  incoming: Map<string, Set<string>>,
): void {
  const previous = factories.get(factory.id);
  if (
    previous !== undefined &&
    (previous.projection.source.sha256 !== factory.projection.source.sha256 ||
      JSON.stringify(previous.imports) !== JSON.stringify(factory.imports))
  )
    refuse('ambiguous factory dependency graph');
  factories.set(factory.id, factory);
  for (const edge of factory.imports) {
    const parents = incoming.get(edge.target) ?? new Set<string>();
    parents.add(factory.id);
    incoming.set(edge.target, parents);
  }
}
interface PhysicalInput {
  readonly input: NodeManifestTurbopackConsumerInput;
  readonly graphs: readonly NodeManifestTurbopackEntryGraph[];
  readonly allGraphs: readonly NodeManifestTurbopackBootGraph[];
  readonly callerProof: NodeManifestRuntimeCallerProof | undefined;
  readonly cohort: NodeManifestRuntimeCohort | undefined;
}
export function assertNodeManifestPhysicalCallers(context: PhysicalInput): void {
  const { input, graphs, allGraphs, callerProof, cohort } = context;
  const tables = nodeManifestRuntimeLookupTables(allGraphs);
  const runtimes = new Set(allGraphs.map((graph) => graph.runtimeId));
  const boots = nodeManifestConsumerBoots(graphs, callerProof);
  for (const source of input.sources) {
    for (const edge of source.imports) {
      if (tables.has(edge.target) && !runtimes.has(source.id))
        refuse('unknown physical factory-table caller');
      if (runtimes.has(edge.target) && !knownRuntimeCaller(source.id, edge, { boots, cohort }))
        refuse('unknown runtime API caller');
      if (edge.target === input.producer.id && !tables.has(source.id))
        refuse('uncertified physical producer caller');
    }
  }
}
export function restrictNodeManifestProtectedIncoming(
  context: PhysicalInput & {
    readonly factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;
    readonly incoming: Map<string, Set<string>>;
    readonly registrations: NodeManifestRegistrationViews;
    readonly pass: NodeManifestRegistrationPass;
  },
): NodeManifestIncomingFallback {
  const { reached, fallback } = inspectNodeManifestReachability({
    factories: [...context.factories.values()],
    graphs: context.graphs,
    callers: context.callerProof?.callers ?? [],
    physicalIds: new Set(context.input.sources.map((source) => source.id)),
    runtimeIds: new Set(context.allGraphs.map((graph) => graph.runtimeId)),
    registrations: context.registrations,
    pass: context.pass,
  });
  if (reached === undefined) return fallback;
  const reachable = new Set(reached);
  for (const [target, parents] of context.incoming) {
    const included = new Set<string>();
    for (const parent of parents) if (reachable.has(parent)) included.add(parent);
    context.incoming.set(target, included);
  }
  return fallback;
}
