import { AuditError } from './dependencies.ts';
import type { NodeManifestCoalescedCjsContext } from './node-manifest-coalesced-cjs.ts';
import {
  certifyNodeManifestCoalescedPages,
  certifyNodeManifestCoalescedCjsPages,
  type NodeManifestCoalescedImport,
} from './node-manifest-coalesced-pages.ts';
import type { NodeManifestIncomingFallback } from './node-manifest-consumer-incoming.ts';
import type { NodeManifestPagesDefinition } from './node-manifest-pages-definitions.ts';
import type { NodeManifestTemplateHelperOwner } from './node-manifest-template-helpers.ts';
import {
  nodeManifestCoalescedImports,
  nodeManifestTemplateImports,
} from './node-manifest-template-imports.ts';
import {
  nodeManifestTurbopackProducerKind,
  type NodeManifestTurbopackConsumerInput,
} from './node-manifest-turbopack-consumer-input.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackSealedEntry,
} from './node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackTemplateImport } from './node-manifest-turbopack-template-import.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from './node-manifest-turbopack-templates.ts';

/** This branch is only a sealed Pages consumer; it leaves the physical graph untouched. */
export async function assertCoalescedPagesConsumer(input: {
  readonly owner: NodeManifestTurbopackConsumerInput;
  readonly graphs: readonly NodeManifestTurbopackBootGraph[];
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly imports: readonly NodeManifestCoalescedImport[];
  readonly helperOwner?: NodeManifestTemplateHelperOwner | undefined;
  readonly cjsContext?: NodeManifestCoalescedCjsContext | undefined;
  readonly route: {
    readonly page: string;
    readonly pathname: string;
    readonly definition?: NodeManifestPagesDefinition | undefined;
  };
}): Promise<void> {
  const graph = input.graphs.find((candidate) => candidate.factories.includes(input.factory));
  if (graph === undefined) throw new AuditError('Coalesced Pages lacks its actual closed graph');
  const route = { ...input.route, kind: 'pages' as const };
  const profileInput = { ...input, graph, route };
  const cjs =
    input.cjsContext === undefined
      ? undefined
      : await certifyNodeManifestCoalescedCjsPages(profileInput, input.cjsContext);
  const profile = cjs ?? certifyNodeManifestCoalescedPages(profileInput);
  await assertNodeManifestTurbopackTemplateConsumer({
    projection: input.factory.projection,
    imports: input.imports.filter(
      (entry): entry is NodeManifestTurbopackTemplateImport => !('builtin' in entry),
    ),
    helperOwner: input.helperOwner,
    route,
    coalesced: { profile, owner: input.owner },
  });
}

/** Keep the existing route lookup/diagnostic independent from the private Pages basis. */
export function nodeManifestConsumerRoute(
  factory: NodeManifestTurbopackGraphFactory,
  routes: ReadonlyMap<string, NodeManifestTurbopackSealedEntry>,
  fallback: NodeManifestIncomingFallback,
): NodeManifestTurbopackSealedEntry {
  const route = routes.get(factory.id);
  if (route !== undefined) return route;
  const reason = fallback === undefined ? '' : `; reachability fallback: ${fallback}`;
  const registration = factory.projection.factory;
  throw new AuditError(
    `Unproved Next.js Turbopack manifest chain consumer without a sealed route${reason}; registration ${factory.projection.original.sha256}:${registration.start}-${registration.end}; refusing native publication`,
  );
}
export async function assertNodeManifestRoutedConsumer(input: {
  readonly owner: NodeManifestTurbopackConsumerInput;
  readonly graphs: readonly NodeManifestTurbopackBootGraph[];
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly imports: Parameters<typeof nodeManifestTemplateImports>[0];
  readonly helperOwner: NodeManifestTemplateHelperOwner;
  readonly cjsContext: NodeManifestCoalescedCjsContext;
  readonly route: NodeManifestTurbopackSealedEntry;
}): Promise<void> {
  const kind = nodeManifestTurbopackProducerKind(input.owner);
  if (kind === 'app-page')
    throw new AuditError('AppPage consumer requires its existing factory proof');
  const route = {
    page: input.route.page,
    pathname: input.route.pathname,
    definition: input.route.definition,
  };
  if (kind === 'pages' && input.factory.projection.mode === 'dependencies')
    await assertCoalescedPagesConsumer({
      ...input,
      imports: nodeManifestCoalescedImports(input.imports),
      route,
    });
  else
    await assertNodeManifestTurbopackTemplateConsumer({
      projection: input.factory.projection,
      imports: nodeManifestTemplateImports(input.imports),
      helperOwner: input.helperOwner,
      route: { ...route, kind },
    });
}
