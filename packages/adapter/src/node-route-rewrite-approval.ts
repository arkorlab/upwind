import { createHash } from 'node:crypto';
import path from 'node:path';

import { AuditError } from './dependencies.ts';
import type { EntryModule } from './function.ts';
import type { ManifestModuleGraph, ManifestRouteSource } from './node-manifest-graph.ts';
import type { NodeManifestNormalization } from './node-manifest-normalization.ts';

const APPROVAL: unique symbol = Symbol('completed Node route rewrite approval');
export interface NodeRouteRewriteApproval {
  readonly [APPROVAL]: true;
}
interface Context {
  readonly distDir: string;
  readonly instrumentation?: string | undefined;
  readonly entries?: readonly EntryModule[] | undefined;
}
interface StoredApproval {
  readonly graph: ManifestModuleGraph;
  readonly graphSha256: string;
  readonly context: string;
  readonly normalization: NodeManifestNormalization;
  readonly normalizationSnapshot: string;
  readonly routes: readonly ManifestRouteSource[];
}
const APPROVALS = new WeakMap<NodeRouteRewriteApproval, StoredApproval>();

function refuse(): never {
  throw new AuditError(
    'Node Next.js rewrite has a stale completed route graph or context; refusing native publication',
  );
}
function codeDigest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}
function graphDigest(graph: ManifestModuleGraph): string {
  const rendered = [...(graph.rendered ?? [])].map(([id, code]) => [id, codeDigest(code)]);
  return createHash('sha256')
    .update(
      JSON.stringify([
        [...graph.sources],
        [...graph.importers],
        [...(graph.imports ?? [])],
        [...(graph.roots ?? [])],
        [...graph.retained],
        rendered,
      ]),
    )
    .digest('hex');
}
function contextSnapshot(context: Context): string {
  return JSON.stringify([
    path.resolve(context.distDir),
    context.instrumentation,
    context.entries?.map((entry) => [entry.id, entry.filePath]),
  ]);
}

/** Internal finalization: called only after the complete recursive consumer/bound proof. */
export function completedNodeRouteRewriteApproval(input: {
  readonly graph: ManifestModuleGraph;
  readonly context: Context;
  readonly normalization: NodeManifestNormalization;
  readonly routes: readonly ManifestRouteSource[];
}): NodeRouteRewriteApproval {
  const proof = Object.freeze<NodeRouteRewriteApproval>({ [APPROVAL]: true });
  APPROVALS.set(proof, {
    graph: input.graph,
    graphSha256: graphDigest(input.graph),
    context: contextSnapshot(input.context),
    normalization: input.normalization,
    normalizationSnapshot: JSON.stringify(input.normalization),
    routes: Object.freeze(input.routes.map((route) => Object.freeze({ ...route }))),
  });
  return proof;
}

/** A copied token, retargeted graph or changed source/edge inventory is never an approval. */
export function checkedNodeRouteRewriteSources(input: {
  readonly approvals?: readonly NodeRouteRewriteApproval[] | undefined;
  readonly graph: ManifestModuleGraph;
  readonly context: Context;
  readonly normalization: NodeManifestNormalization | undefined;
}): readonly ManifestRouteSource[] {
  const routes: ManifestRouteSource[] = [];
  if (input.approvals === undefined) return Object.freeze(routes);
  for (const proof of input.approvals) {
    const stored = APPROVALS.get(proof);
    if (
      stored?.graph !== input.graph ||
      stored.graphSha256 !== graphDigest(input.graph) ||
      stored.context !== contextSnapshot(input.context) ||
      stored.normalization !== input.normalization ||
      stored.normalizationSnapshot !== JSON.stringify(input.normalization)
    )
      refuse();
    routes.push(...stored.routes);
  }
  return Object.freeze(routes);
}
