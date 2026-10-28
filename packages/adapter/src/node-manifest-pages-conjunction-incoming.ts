import { AuditError } from './dependencies.ts';
import { inspectNodeManifestReachability } from './node-manifest-reachability.ts';
import {
  assertNodeManifestPassRows,
  type NodeManifestRegistrationPass,
} from './node-manifest-registration-pass.ts';
import type { NodeManifestRegistrationViews } from './node-manifest-registration-views.ts';
import { proveNodeManifestRuntimeCallers } from './node-manifest-runtime-callers.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumer-input.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
} from './node-manifest-turbopack-graph.ts';

function refuse(reason: string): never {
  throw new AuditError(`Unproved Pages conjunction ${reason}; refusing native publication`);
}

/** Derive complete original incoming edges from the real pass-bound rows, never a supplied map. */
export function nodeManifestPagesConjunctionIncoming(context: {
  readonly input: NodeManifestTurbopackConsumerInput;
  readonly graphs: readonly NodeManifestTurbopackBootGraph[];
  readonly registrations: NodeManifestRegistrationViews;
  readonly factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;
  readonly scope: NodeManifestRegistrationPass;
}): ReadonlyMap<string, readonly string[]> {
  const factories = [...context.factories.values()];
  assertNodeManifestPassRows(context.scope, factories);
  for (const [id, factory] of context.factories)
    if (id !== factory.id) refuse('factory lookup identity');
  const graphs = context.graphs.filter((graph) => {
    return context.input.entries.some((entry) => {
      return context.input.sources.some(
        (source) => source.id === graph.physicalId && source.file === entry.file,
      );
    });
  });
  if (graphs.length !== context.input.entries.length)
    return refuse('incomplete original route boots');
  const callers =
    context.input.runtimeCallers === undefined
      ? undefined
      : proveNodeManifestRuntimeCallers({
          inventory: context.input.runtimeCallers,
          graphs: context.graphs,
          registrations: context.registrations,
          pass: context.scope,
          sources: context.input.sources,
          distDir: context.input.distDir,
        });
  const reachable = inspectNodeManifestReachability({
    factories,
    graphs,
    callers: callers?.callers ?? [],
    physicalIds: new Set(context.input.sources.map((source) => source.id)),
    runtimeIds: new Set(context.graphs.map((graph) => graph.runtimeId)),
    registrations: context.registrations,
    pass: context.scope,
  }).reached;
  const included = reachable === undefined ? undefined : new Set(reachable);
  const incoming = new Map<string, Set<string>>();
  for (const factory of factories) {
    if (included !== undefined && !included.has(factory.id)) continue;
    for (const edge of factory.imports) {
      const parents = incoming.get(edge.target) ?? new Set<string>();
      parents.add(factory.id);
      incoming.set(edge.target, parents);
    }
  }
  return new Map([...incoming].map(([id, parents]) => [id, Object.freeze([...parents])]));
}
