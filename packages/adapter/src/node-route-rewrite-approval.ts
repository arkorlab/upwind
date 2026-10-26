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
export interface NodeRouteRewriteApprovalBinding {
  readonly approval: NodeRouteRewriteApproval;
  readonly normalization: NodeManifestNormalization;
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
  readonly dependencies: readonly NodeRouteRewriteApprovalBinding[];
}
const APPROVALS = new WeakMap<NodeRouteRewriteApproval, StoredApproval>();
const MAX_APPROVALS = 4096;

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

interface Completion {
  readonly graph: ManifestModuleGraph;
  readonly context: Context;
  readonly normalization: NodeManifestNormalization;
  readonly routes: readonly ManifestRouteSource[];
}
function mint(
  input: Completion,
  dependencies: readonly NodeRouteRewriteApprovalBinding[],
): NodeRouteRewriteApproval {
  const proof = Object.freeze<NodeRouteRewriteApproval>({ [APPROVAL]: true });
  APPROVALS.set(proof, {
    graph: input.graph,
    graphSha256: graphDigest(input.graph),
    context: contextSnapshot(input.context),
    normalization: input.normalization,
    normalizationSnapshot: JSON.stringify(input.normalization),
    routes: Object.freeze(input.routes.map((route) => Object.freeze({ ...route }))),
    dependencies: Object.freeze(dependencies.map((binding) => Object.freeze({ ...binding }))),
  });
  return proof;
}

/** Internal finalization: called only after the complete recursive consumer/bound proof. */
export function completedNodeRouteRewriteApproval(input: Completion): NodeRouteRewriteApproval {
  return mint(input, []);
}

interface CheckInput {
  readonly graph: ManifestModuleGraph;
  readonly context: Context;
  readonly normalization: NodeManifestNormalization | undefined;
}
function current(proof: NodeRouteRewriteApproval, input: CheckInput): StoredApproval {
  const stored = APPROVALS.get(proof);
  if (
    stored?.graph !== input.graph ||
    stored.graphSha256 !== graphDigest(input.graph) ||
    stored.context !== contextSnapshot(input.context) ||
    stored.normalization !== input.normalization ||
    stored.normalizationSnapshot !== JSON.stringify(input.normalization)
  )
    refuse();
  return stored;
}

function checkedDependencies(
  proof: NodeRouteRewriteApproval,
  input: CheckInput,
  checked: Set<NodeRouteRewriteApproval>,
): void {
  const active = new Set<NodeRouteRewriteApproval>();
  const pending = [{ approval: proof, normalization: input.normalization, exit: false }];
  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    if (frame.exit) {
      active.delete(frame.approval);
      checked.add(frame.approval);
      continue;
    }
    // Even a visited token must retain this exact associated normalization object.
    const original = current(frame.approval, { ...input, normalization: frame.normalization });
    if (checked.has(frame.approval)) continue;
    if (active.has(frame.approval) || active.size + checked.size >= MAX_APPROVALS) refuse();
    active.add(frame.approval);
    pending.push({ ...frame, exit: true });
    for (const binding of original.dependencies) pending.push({ ...binding, exit: false });
  }
}

/** A copied token, retargeted graph or changed source/edge inventory is never an approval. */
export function checkedNodeRouteRewriteSources(
  input: CheckInput & {
    readonly approvals?: readonly NodeRouteRewriteApproval[] | undefined;
  },
): readonly ManifestRouteSource[] {
  const routes: ManifestRouteSource[] = [];
  if (input.approvals === undefined) return Object.freeze(routes);
  const checked = new Set<NodeRouteRewriteApproval>();
  for (const proof of input.approvals) {
    const stored = current(proof, input);
    checkedDependencies(proof, input, checked);
    routes.push(...stored.routes);
  }
  return Object.freeze(routes);
}

function sameScope(left: NodeManifestNormalization, right: NodeManifestNormalization): boolean {
  return (
    left.distDir === right.distDir &&
    left.canonicalDistDir === right.canonicalDistDir &&
    left.runtimeRootDir === right.runtimeRootDir &&
    left.entries.length === right.entries.length &&
    left.entries.every((entry, index) => {
      const other = right.entries[index];
      if (other === undefined) return false;
      return (
        entry.id === other.id &&
        entry.filePath === other.filePath &&
        entry.canonicalFilePath === other.canonicalFilePath
      );
    })
  );
}

function mergeMetadata(
  target: Map<string, { readonly file: string; readonly sha256: string }>,
  sources: NodeManifestNormalization['metadataFiles'],
): void {
  if (sources === undefined) return;
  for (const source of sources) {
    const previous = target.get(source.file);
    if (previous !== undefined && previous.sha256 !== source.sha256) refuse();
    target.set(source.file, Object.freeze({ ...source }));
  }
}

/** Combine only completed original proofs; matching normalization data never grants an approval. */
export function combineNodeRouteRewriteApprovals(input: {
  readonly bindings: readonly NodeRouteRewriteApprovalBinding[];
  readonly graph: ManifestModuleGraph;
  readonly context: Context;
}): {
  readonly approvals: readonly NodeRouteRewriteApproval[];
  readonly normalization: NodeManifestNormalization | undefined;
} {
  const bindings = Object.freeze(
    input.bindings.map((binding) =>
      Object.freeze({ approval: binding.approval, normalization: binding.normalization }),
    ),
  );
  const first = bindings[0];
  if (first === undefined) return { approvals: Object.freeze([]), normalization: undefined };
  const allRoutes = bindings.flatMap((binding) => {
    return checkedNodeRouteRewriteSources({
      graph: input.graph,
      context: input.context,
      approvals: [binding.approval],
      normalization: binding.normalization,
    });
  });
  if (bindings.length === 1)
    return { approvals: Object.freeze([first.approval]), normalization: first.normalization };
  const metadata = new Map<string, { readonly file: string; readonly sha256: string }>();
  const routes = new Map<string, ManifestRouteSource>();
  for (const binding of bindings) {
    if (!sameScope(first.normalization, binding.normalization)) refuse();
    mergeMetadata(metadata, binding.normalization.metadataFiles);
  }
  for (const route of allRoutes) {
    const previous = routes.get(route.file);
    if (
      previous !== undefined &&
      (previous.root !== route.root ||
        previous.relative !== route.relative ||
        previous.sha256 !== route.sha256)
    )
      refuse();
    routes.set(route.file, route);
  }
  const normalization = Object.freeze({
    ...first.normalization,
    entries: Object.freeze(first.normalization.entries.map((entry) => Object.freeze({ ...entry }))),
    ...(bindings.some((binding) => binding.normalization.metadataFiles !== undefined) && {
      metadataFiles: Object.freeze([...metadata.values()]),
    }),
  });
  const approval = mint(
    { graph: input.graph, context: input.context, normalization, routes: [...routes.values()] },
    bindings,
  );
  return { approvals: Object.freeze([approval]), normalization };
}
