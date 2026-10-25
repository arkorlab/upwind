import { isBuiltin } from 'node:module';

import { compareCodeUnits } from '@stayingupwind/core/util';

import type { NodeManifestRuntimeCallerProof } from './node-manifest-runtime-callers.ts';
import type {
  NodeManifestTurbopackEntryGraph,
  NodeManifestTurbopackGraphFactory,
} from './node-manifest-turbopack-graph.ts';

interface ReachabilityInput {
  readonly factories: readonly NodeManifestTurbopackGraphFactory[];
  readonly graphs: readonly Pick<NodeManifestTurbopackEntryGraph, 'exportedId' | 'evaluations'>[];
  readonly callers: NodeManifestRuntimeCallerProof['callers'];
  readonly physicalIds: ReadonlySet<string>;
  readonly runtimeIds: ReadonlySet<string>;
}

type ReachabilityFallback =
  | 'duplicate-factory'
  | 'no-seeds'
  | 'unregistered-seed'
  | 'reachable-bound-runtime'
  | 'open-runtime-import'
  | 'unresolved-import';

export type NodeManifestReachabilityResult =
  | { readonly reached: readonly string[]; readonly fallback: undefined }
  | { readonly reached: undefined; readonly fallback: ReachabilityFallback };

function allFactories(fallback: ReachabilityFallback): NodeManifestReachabilityResult {
  return Object.freeze({ reached: undefined, fallback });
}

function closedFactories(reached: readonly string[]): NodeManifestReachabilityResult {
  return Object.freeze({ reached: Object.freeze(reached), fallback: undefined });
}

function ownerOf(factory: NodeManifestTurbopackGraphFactory): string {
  return JSON.stringify([
    factory.runtimeId,
    factory.physicalId,
    factory.projection.original.sha256,
    factory.projection.factory.start,
    factory.projection.factory.end,
  ]);
}

function factoryOwners(factories: ReachabilityInput['factories']): ReadonlyMap<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const factory of factories) {
    const key = ownerOf(factory);
    const aliases = owners.get(key) ?? [];
    aliases.push(factory.id);
    owners.set(key, aliases);
  }
  return owners;
}

function dependencyTargets(
  factory: NodeManifestTurbopackGraphFactory,
  known: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>,
  input: ReachabilityInput,
): NodeManifestReachabilityResult {
  if (factory.projection.boundRuntimeInputs.length > 0)
    return allFactories('reachable-bound-runtime');
  const targets: string[] = [];
  for (const edge of factory.imports) {
    if (known.has(edge.target)) targets.push(edge.target);
    else if (input.runtimeIds.has(edge.target)) return allFactories('open-runtime-import');
    else if (!input.physicalIds.has(edge.target) && !isBuiltin(edge.target))
      return allFactories('unresolved-import');
  }
  return closedFactories(targets);
}

/** A fallback keeps every incoming edge; its finite label carries no source identity. */
export function inspectNodeManifestReachability(
  input: ReachabilityInput,
): NodeManifestReachabilityResult {
  const factories = new Map(input.factories.map((factory) => [factory.id, factory]));
  if (factories.size !== input.factories.length) return allFactories('duplicate-factory');
  const pending = [
    ...input.graphs.flatMap((graph) => [graph.exportedId, ...graph.evaluations]),
    ...input.callers.flatMap((caller) => caller.invoked),
  ];
  if (pending.length === 0) return allFactories('no-seeds');
  const owners = factoryOwners(input.factories);
  const reached = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || reached.has(id)) continue;
    const factory = factories.get(id);
    if (factory === undefined) return allFactories('unregistered-seed');
    const targets = dependencyTargets(factory, factories, input);
    if (targets.reached === undefined) return targets;
    reached.add(id);
    // One callback may register several IDs: executing one retains the whole original body.
    pending.push(...(owners.get(ownerOf(factory)) ?? []), ...targets.reached);
  }
  return closedFactories([...reached].toSorted(compareCodeUnits));
}

/** Undefined keeps all protected incoming edges. This never exempts a factory from ordinary audit. */
export function reachableNodeManifestFactories(
  input: ReachabilityInput,
): readonly string[] | undefined {
  return inspectNodeManifestReachability(input).reached;
}
