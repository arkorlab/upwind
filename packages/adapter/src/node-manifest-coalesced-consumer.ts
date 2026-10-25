import { AuditError } from './dependencies.ts';
import {
  certifyNodeManifestCoalescedPages,
  type NodeManifestCoalescedImport,
} from './node-manifest-coalesced-pages.ts';
import type { NodeManifestPagesDefinition } from './node-manifest-pages-definitions.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumers.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
} from './node-manifest-turbopack-graph.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from './node-manifest-turbopack-templates.ts';

/** This branch is only a sealed Pages consumer; it leaves the physical graph untouched. */
export async function assertCoalescedPagesConsumer(input: {
  readonly owner: NodeManifestTurbopackConsumerInput;
  readonly graphs: readonly NodeManifestTurbopackBootGraph[];
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly imports: readonly NodeManifestCoalescedImport[];
  readonly route: {
    readonly page: string;
    readonly pathname: string;
    readonly definition?: NodeManifestPagesDefinition | undefined;
  };
}): Promise<void> {
  const graph = input.graphs.find((candidate) => candidate.factories.includes(input.factory));
  if (graph === undefined) throw new AuditError('Coalesced Pages lacks its actual closed graph');
  const route = { ...input.route, kind: 'pages' as const };
  const profile = certifyNodeManifestCoalescedPages({ ...input, graph, route });
  await assertNodeManifestTurbopackTemplateConsumer({
    projection: input.factory.projection,
    imports: input.imports.filter((entry) => 'file' in entry),
    route,
    coalesced: { profile, owner: input.owner },
  });
}
