import { AuditError } from './dependencies.ts';
import {
  assertNodeManifestPassSingle,
  nodeManifestPassForwarded,
  nodeManifestPassTouchesProtected,
  type NodeManifestRegistrationPass,
} from './node-manifest-registration-pass.ts';
import type { NodeManifestRuntimeCallerProof } from './node-manifest-runtime-callers.ts';
import type {
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackEntryGraph,
  NodeManifestTurbopackSealedEntry,
} from './node-manifest-turbopack-graph.ts';
import { projectNodeManifestTurbopackFactory } from './node-manifest-turbopack.ts';

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest chain ${reason}; refusing native publication`,
  );
}
export function captureNodeManifestConsumerTerminals(input: {
  readonly graphs: readonly NodeManifestTurbopackEntryGraph[];
  readonly terminals: Map<string, NodeManifestTurbopackSealedEntry & { readonly id: string }>;
  readonly id: string;
  readonly role: 'class' | 'factory' | 'route-exports';
}): boolean {
  let found = false;
  for (const graph of input.graphs) {
    if (graph.exportedId !== input.id) continue;
    if (input.role !== 'route-exports') refuse('producer namespace reaches SDK route terminal');
    input.terminals.set(graph.physicalId, { ...graph.entry, id: graph.physicalId });
    found = true;
  }
  return found;
}
export function assertAdditionalNodeManifestConsumerRoles(input: {
  readonly pass: NodeManifestRegistrationPass;
  readonly graphs: readonly NodeManifestTurbopackEntryGraph[];
  readonly proof: NodeManifestRuntimeCallerProof | undefined;
  readonly complete: ReadonlyMap<string, unknown>;
}): void {
  if (input.proof === undefined) return;
  const protectedBoots = new Set(input.graphs.map((graph) => graph.physicalId));
  for (const caller of input.proof.callers) {
    if (protectedBoots.has(caller.id)) continue;
    if (
      caller.invoked.some((id) => nodeManifestPassTouchesProtected(input.pass, id, input.complete))
    )
      refuse('additional runtime caller consumes protected route authority');
  }
}
/** The unchanged ordinary single-registration forwarding guard. */
export function nodeManifestUnwrappedConsumerFactory(
  id: string,
  pass: NodeManifestRegistrationPass,
  factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>,
): string {
  const seen = new Set<string>();
  let current = id;
  assertNodeManifestPassSingle(pass, current);
  while (factories.has(current)) {
    if (seen.has(current)) refuse('cyclic namespace forwarding');
    seen.add(current);
    const factory = factories.get(current);
    if (factory === undefined) return refuse('missing factory');
    const next = nodeManifestPassForwarded(pass, factory.id);
    if (next === undefined) return current;
    current = next;
    assertNodeManifestPassSingle(pass, current);
  }
  return current;
}
/** Strict reprojection still checks every original dependency before protected use. */
export function nodeManifestStrictConsumerFactory(
  factory: NodeManifestTurbopackGraphFactory,
  pass: NodeManifestRegistrationPass,
  cache: Map<string, NodeManifestTurbopackGraphFactory>,
): NodeManifestTurbopackGraphFactory {
  assertNodeManifestPassSingle(pass, factory.id);
  const previous = cache.get(factory.id);
  if (previous !== undefined) return previous;
  const projection = projectNodeManifestTurbopackFactory(
    factory.projection.original,
    factory.projection.moduleId,
  );
  if (
    JSON.stringify(projection.imports) !== JSON.stringify(factory.projection.imports) ||
    JSON.stringify(projection.boundRuntimeInputs) !==
      JSON.stringify(factory.projection.boundRuntimeInputs)
  )
    refuse('protected factory dependency projection disagreement');
  const strict = { ...factory, projection };
  cache.set(factory.id, strict);
  return strict;
}
