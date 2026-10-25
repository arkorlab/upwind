import { isBuiltin } from 'node:module';

import { AuditError } from './dependencies.ts';
import {
  certifyNodeManifestAppPageFactory,
  type NodeManifestAppPageFactoryProof,
  type NodeManifestAppPageFactoryImport,
} from './node-manifest-app-page-factory.ts';
import {
  assertStandaloneNodeBoundConsumers,
  certifyNodeManifestBoundConsumer,
  stageNodeManifestBoundProof,
  type NodeManifestBoundBatch,
  type NodeManifestBoundStage,
  type NodeManifestBoundConsumerProof,
} from './node-manifest-bound-batch.ts';
import { assertCoalescedPagesConsumer } from './node-manifest-coalesced-consumer.ts';
import type { NodeManifestConsumerImport } from './node-manifest-consumers.ts';
import { APP_PAGE_CLASS, APP_PAGE_FACTORY } from './node-manifest-framework.ts';
import { nodeManifestPagesContextLeaf } from './node-manifest-pages-context-consumer.ts';
import { inspectNodeManifestReachability } from './node-manifest-reachability.ts';
import {
  proveNodeManifestRuntimeCallers,
  type NodeManifestRuntimeCallers,
  type NodeManifestRuntimeCallerProof,
} from './node-manifest-runtime-callers.ts';
import {
  prepareNodeManifestRuntimeGraphs,
  type NodeManifestRuntimeCohort,
  type NodeManifestRuntimeProfile,
} from './node-manifest-runtime-cohort.ts';
import { nodeManifestRuntimeLookupTables } from './node-manifest-runtime-tables.ts';
import {
  nodeManifestCoalescedImports,
  nodeManifestTemplateImports,
} from './node-manifest-template-imports.ts';
import {
  type NodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackGraphFactory,
  type NodeManifestTurbopackGraphFile,
  type NodeManifestTurbopackSealedEntry,
} from './node-manifest-turbopack-graph.ts';
import { forwarded, knownRuntimeCaller } from './node-manifest-turbopack-parents.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from './node-manifest-turbopack-templates.ts';
import { projectNodeManifestTurbopackFactory } from './node-manifest-turbopack.ts';

export interface NodeManifestTurbopackConsumerInput {
  readonly distDir: string;
  readonly rootDir: string;
  readonly assetPrefix?: string | undefined;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly entries: readonly NodeManifestTurbopackSealedEntry[];
  readonly runtimeCallers?: NodeManifestRuntimeCallers | undefined;
  readonly runtimeProfiles?: readonly NodeManifestRuntimeProfile[] | undefined;
  readonly boundBatch?: NodeManifestBoundBatch | undefined;
  readonly producer: {
    readonly id: string;
    readonly file: string;
    readonly sha256: string;
    readonly kind?:
      | 'app-page-factory'
      | 'app-page-class'
      | 'pages-class'
      | 'app-route-class'
      | 'pages-api-class';
  };
}
export interface NodeManifestTurbopackConsumerProof {
  readonly terminals: readonly (NodeManifestTurbopackSealedEntry & { readonly id: string })[];
  readonly files: readonly { readonly file: string; readonly sha256: string }[];
  readonly compilerSources: readonly { readonly file: string; readonly sha256: string }[];
  /** Provisional only: the outer graph must commit its SDK terminal walk and close the batch. */
  readonly boundStage?: NodeManifestBoundStage | undefined;
  /** The outer graph must still visit every terminal's actual importers through the SDK root. */
  readonly requiresSdkNormalization: true;
}
type Role = 'class' | 'factory' | 'route-exports';

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest chain ${reason}; refusing native publication`,
  );
}

function physicalBoots(
  graphs: readonly NodeManifestTurbopackEntryGraph[],
  proof: NodeManifestRuntimeCallerProof | undefined,
): ReadonlySet<string> {
  const boots = new Set(graphs.map((graph) => graph.physicalId));
  if (proof !== undefined) {
    for (const caller of proof.callers) boots.add(caller.id);
  }
  return boots;
}

class TurbopackConsumers {
  private readonly input: NodeManifestTurbopackConsumerInput;
  private readonly graphs: readonly NodeManifestTurbopackEntryGraph[];
  private readonly allGraphs: readonly NodeManifestTurbopackBootGraph[];
  private readonly runtimeCohort: NodeManifestRuntimeCohort | undefined;
  private readonly factories = new Map<string, NodeManifestTurbopackGraphFactory>();
  private readonly incoming = new Map<string, Set<string>>();
  private readonly terminals = new Map<
    string,
    NodeManifestTurbopackSealedEntry & { readonly id: string }
  >();
  private readonly complete = new Map<string, Role>();
  private readonly visiting = new Set<string>();
  private readonly routes = new Map<string, NodeManifestTurbopackSealedEntry>();
  private readonly runtimeConsumers = new Set<string>();
  private readonly boundConsumers = new Map<string, NodeManifestBoundConsumerProof>();
  private readonly strictFactories = new Map<string, NodeManifestTurbopackGraphFactory>();
  private readonly helperOwner = Object.freeze({ identity: Symbol('Pages template helper owner') });
  private readonly certifiedFactories = new Map<string, NodeManifestAppPageFactoryProof>();
  private readonly callerProof: NodeManifestRuntimeCallerProof | undefined;
  private reachabilityFallback: ReturnType<typeof inspectNodeManifestReachability>['fallback'];

  constructor(input: NodeManifestTurbopackConsumerInput) {
    this.input = input;
    const expectedKind = this.producerKind();
    for (const entry of input.entries) {
      const kind = entry.kind ?? 'app-page';
      if (kind !== expectedKind) refuse('sealed route and constructor kind mismatch');
    }
    if (new Set(input.entries.map((entry) => entry.file)).size !== input.entries.length)
      refuse('duplicate sealed entry');
    const prepared = prepareNodeManifestRuntimeGraphs({
      ...input,
      inventory: input.runtimeCallers,
      profiles: input.runtimeProfiles,
    });
    this.graphs = prepared.graphs;
    this.allGraphs = prepared.allGraphs;
    this.runtimeCohort = prepared.cohort;
    for (const graph of this.allGraphs)
      for (const factory of graph.factories) this.register(factory);
    for (const graph of this.graphs) {
      const terminal = this.unwrapped(graph.exportedId);
      const previous = this.routes.get(terminal);
      if (
        previous !== undefined &&
        (previous.page !== graph.entry.page || previous.pathname !== graph.entry.pathname)
      )
        refuse('ambiguous sealed factory route');
      this.routes.set(terminal, graph.entry);
    }
    this.callerProof =
      input.runtimeCallers === undefined
        ? undefined
        : proveNodeManifestRuntimeCallers({
            inventory: input.runtimeCallers,
            graphs: this.allGraphs,
            sources: input.sources,
            distDir: input.distDir,
          });
    this.assertPhysicalCallers();
    this.restrictProtectedIncoming();
  }

  private restrictProtectedIncoming(): void {
    const { reached, fallback } = inspectNodeManifestReachability({
      factories: [...this.factories.values()],
      graphs: this.graphs,
      callers: this.callerProof?.callers ?? [],
      physicalIds: new Set(this.input.sources.map((source) => source.id)),
      runtimeIds: new Set(this.allGraphs.map((graph) => graph.runtimeId)),
    });
    this.reachabilityFallback = fallback;
    if (reached === undefined) return;
    const reachable = new Set(reached);
    for (const [target, parents] of this.incoming) {
      const included = new Set<string>();
      for (const parent of parents) {
        if (reachable.has(parent)) included.add(parent);
      }
      this.incoming.set(target, included);
    }
  }

  private producerKind(): 'app-page' | 'pages' | 'app-route' | 'pages-api' {
    const kind = this.input.producer.kind ?? APP_PAGE_FACTORY;
    switch (kind) {
      case APP_PAGE_FACTORY:
      case APP_PAGE_CLASS: {
        return 'app-page';
      }
      case 'pages-class': {
        return 'pages';
      }
      case 'pages-api-class': {
        return 'pages-api';
      }
      case 'app-route-class': {
        return 'app-route';
      }
      default: {
        return refuse('unknown protected producer role');
      }
    }
  }

  private register(factory: NodeManifestTurbopackGraphFactory): void {
    const previous = this.factories.get(factory.id);
    if (
      previous !== undefined &&
      (previous.projection.source.sha256 !== factory.projection.source.sha256 ||
        JSON.stringify(previous.imports) !== JSON.stringify(factory.imports))
    )
      refuse('ambiguous factory dependency graph');
    this.factories.set(factory.id, factory);
    for (const edge of factory.imports) {
      const parents = this.incoming.get(edge.target) ?? new Set<string>();
      parents.add(factory.id);
      this.incoming.set(edge.target, parents);
    }
  }

  private unwrapped(id: string): string {
    const seen = new Set<string>();
    let current = id;
    while (this.factories.has(current)) {
      if (seen.has(current)) refuse('cyclic namespace forwarding');
      seen.add(current);
      const factory = this.factories.get(current);
      if (factory === undefined) return refuse('missing factory');
      const next = forwarded(factory);
      if (next === undefined) return current;
      current = next;
    }
    return current;
  }

  private assertPhysicalCallers(): void {
    const tables = nodeManifestRuntimeLookupTables(this.allGraphs);
    const runtimes = new Set(this.allGraphs.map((graph) => graph.runtimeId));
    const boots = physicalBoots(this.graphs, this.callerProof);
    for (const source of this.input.sources) {
      for (const edge of source.imports) {
        if (tables.has(edge.target) && !runtimes.has(source.id))
          refuse('unknown physical factory-table caller');
        if (
          runtimes.has(edge.target) &&
          !knownRuntimeCaller(source.id, edge, { boots, cohort: this.runtimeCohort })
        )
          refuse('unknown runtime API caller');
        if (edge.target === this.input.producer.id && !tables.has(source.id))
          refuse('uncertified physical producer caller');
      }
    }
  }

  private assertAdditionalCallerRoles(): void {
    if (this.callerProof === undefined) return;
    const protectedBoots = new Set(this.graphs.map((graph) => graph.physicalId));
    for (const caller of this.callerProof.callers) {
      if (protectedBoots.has(caller.id)) continue;
      if (
        caller.invoked.some((id) => this.complete.has(id) || this.complete.has(this.unwrapped(id)))
      )
        refuse('additional runtime caller consumes protected route authority');
    }
  }

  private descriptor(edge: {
    readonly specifier: string;
    readonly target: string;
  }): NodeManifestConsumerImport | undefined {
    const target = this.unwrapped(edge.target);
    const proof = this.certifiedFactories.get(target);
    if (proof !== undefined)
      return {
        specifier: edge.specifier,
        file: proof.file,
        sha256: proof.sha256,
        kind: APP_PAGE_FACTORY,
        exportName: 'createAppPageEntrypoint',
        certifiedFactory: proof,
      };
    if (target !== this.input.producer.id || this.input.producer.kind === APP_PAGE_CLASS)
      return undefined;
    return {
      specifier: edge.specifier,
      file: this.input.producer.file,
      sha256: this.input.producer.sha256,
      kind: APP_PAGE_FACTORY,
      exportName: 'createAppPageEntrypoint',
    };
  }

  private appPageConsumer(
    factory: NodeManifestTurbopackGraphFactory,
    route: NodeManifestTurbopackSealedEntry,
  ): void {
    const imports = factory.imports
      .map((edge) => this.descriptor(edge))
      .filter((entry) => entry !== undefined);
    const proof = certifyNodeManifestBoundConsumer({
      factory,
      context: this.input,
      cohort: this.runtimeCohort,
      imports,
      route,
    });
    this.runtimeConsumers.add(factory.id);
    this.boundConsumers.set(factory.id, proof);
  }

  private importInput(
    factory: NodeManifestTurbopackGraphFactory,
  ): Parameters<typeof nodeManifestTemplateImports>[0] {
    return {
      factory,
      sources: this.input.sources,
      target: (id) => this.importTarget(id),
      helper:
        this.producerKind() === 'pages'
          ? { owner: this.helperOwner, factories: this.factories }
          : undefined,
    };
  }

  private async consumer(factory: NodeManifestTurbopackGraphFactory): Promise<void> {
    const route = this.routes.get(factory.id);
    if (route === undefined) {
      const reason =
        this.reachabilityFallback === undefined
          ? ''
          : `; reachability fallback: ${this.reachabilityFallback}`;
      const registration = factory.projection.factory;
      refuse(
        `consumer without a sealed route${reason}; registration ${factory.projection.original.sha256}:${registration.start}-${registration.end}`,
      );
    }
    const kind = this.producerKind();
    if (kind === 'app-page') this.appPageConsumer(factory, route);
    else if (kind === 'pages' && factory.projection.mode === 'dependencies')
      await assertCoalescedPagesConsumer({
        owner: this.input,
        graphs: this.allGraphs,
        factory,
        imports: nodeManifestCoalescedImports(this.importInput(factory)),
        helperOwner: this.helperOwner,
        route: { page: route.page, pathname: route.pathname, definition: route.definition },
      });
    else
      await assertNodeManifestTurbopackTemplateConsumer({
        projection: factory.projection,
        imports: nodeManifestTemplateImports(this.importInput(factory)),
        helperOwner: this.helperOwner,
        route: { kind, page: route.page, pathname: route.pathname, definition: route.definition },
      });
  }

  private importTarget(id: string): string {
    const target = this.unwrapped(id);
    return this.factories.get(target)?.physicalId ?? target;
  }

  private async fixedFactory(factory: NodeManifestTurbopackGraphFactory): Promise<void> {
    const physical = this.input.sources.find((source) => source.id === factory.physicalId);
    if (physical === undefined) return refuse('missing fixed factory source');
    const imports: NodeManifestAppPageFactoryImport[] = factory.imports
      .filter((edge) => isBuiltin(edge.target))
      .map((edge) => ({ specifier: edge.specifier, builtin: edge.target }));
    const physicalImports = nodeManifestTemplateImports(
      this.importInput({
        ...factory,
        imports: factory.imports.filter((edge) => !isBuiltin(edge.target)),
      }),
    );
    const proof = await certifyNodeManifestAppPageFactory({
      file: physical.file,
      projection: factory.projection,
      imports: [...physicalImports, ...imports],
    });
    this.certifiedFactories.set(factory.id, proof);
  }

  private strictFactory(
    factory: NodeManifestTurbopackGraphFactory,
  ): NodeManifestTurbopackGraphFactory {
    const previous = this.strictFactories.get(factory.id);
    if (previous !== undefined) return previous;
    const id = factory.projection.moduleId;
    const projection = projectNodeManifestTurbopackFactory(factory.projection.original, id);
    if (
      JSON.stringify(projection.imports) !== JSON.stringify(factory.projection.imports) ||
      JSON.stringify(projection.boundRuntimeInputs) !==
        JSON.stringify(factory.projection.boundRuntimeInputs)
    )
      refuse('protected factory dependency projection disagreement');
    const strict = { ...factory, projection };
    this.strictFactories.set(factory.id, strict);
    return strict;
  }

  private captureTerminals(id: string, role: Role): boolean {
    let found = false;
    for (const graph of this.graphs) {
      if (graph.exportedId !== id) continue;
      if (role !== 'route-exports') refuse('producer namespace reaches SDK route terminal');
      this.terminals.set(graph.physicalId, { ...graph.entry, id: graph.physicalId });
      found = true;
    }
    return found;
  }

  private async visitParent(
    factory: NodeManifestTurbopackGraphFactory,
    id: string,
    role: Role,
  ): Promise<void> {
    if (
      role === 'factory' &&
      !this.routes.has(factory.id) &&
      nodeManifestPagesContextLeaf(factory, id, this.unwrapped(id), this.input)
    )
      return;
    if (forwarded(factory) === id) await this.visit(factory.id, role);
    else if (role === 'class') {
      await this.fixedFactory(factory);
      await this.visit(factory.id, 'factory');
    } else {
      if (role !== 'factory') refuse('route class/handler used outside normalization');
      await this.consumer(factory);
      await this.visit(factory.id, 'route-exports');
    }
  }

  private async visit(id: string, role: Role): Promise<void> {
    const complete = this.complete.get(id);
    if (complete !== undefined) {
      if (complete !== role) refuse('conflicting protected export role');
      return;
    }
    if (this.visiting.has(id)) refuse('cyclic protected factory chain');
    this.visiting.add(id);
    const terminal = this.captureTerminals(id, role);
    const parents = this.incoming.get(id) ?? new Set<string>();
    if (!terminal && parents.size === 0) refuse('unclosed protected factory chain');
    for (const parent of parents) {
      const incoming = this.factories.get(parent);
      if (incoming === undefined) refuse('unknown protected consumer');
      const route = this.routes.get(incoming.id);
      const coalesced =
        role === 'factory' &&
        this.producerKind() === 'pages' &&
        route?.kind === 'pages' &&
        incoming.projection.cacheInitializers.length === 1;
      const factory = coalesced ? incoming : this.strictFactory(incoming);
      await this.visitParent(factory, id, role);
    }
    this.visiting.delete(id);
    this.complete.set(id, role);
  }

  private proofFiles(): NodeManifestTurbopackConsumerProof['files'] {
    const files = new Map<string, { readonly file: string; readonly sha256: string }>();
    for (const graph of this.allGraphs) {
      const ids = new Set([
        graph.physicalId,
        graph.runtimeId,
        ...graph.factories.map((factory) => factory.physicalId),
      ]);
      for (const source of this.input.sources) {
        if (ids.has(source.id))
          files.set(source.file, { file: source.file, sha256: source.source.sha256 });
      }
    }
    if (this.callerProof !== undefined) {
      for (const caller of this.callerProof.callers)
        files.set(caller.file, { file: caller.file, sha256: caller.sha256 });
    }
    return [...files.values()];
  }

  async prove(): Promise<NodeManifestTurbopackConsumerProof> {
    const producer = this.input.sources.find((source) => source.id === this.input.producer.id);
    if (
      producer?.file !== this.input.producer.file ||
      producer.source.sha256 !== this.input.producer.sha256
    )
      refuse('producer source binding');
    await this.visit(
      this.input.producer.id,
      this.input.producer.kind === APP_PAGE_CLASS ? 'class' : 'factory',
    );
    this.assertAdditionalCallerRoles();
    assertStandaloneNodeBoundConsumers(this.input, this.factories.values(), this.runtimeConsumers);
    if (this.terminals.size === 0) refuse('missing protected SDK route terminal');
    const boundStage =
      this.input.boundBatch === undefined
        ? undefined
        : stageNodeManifestBoundProof({
            batch: this.input.boundBatch,
            consumer: this.input,
            cohort: this.runtimeCohort,
            factories: [...this.factories.values()],
            certified: [...this.boundConsumers.values()],
          });
    return {
      terminals: [...this.terminals.values()],
      files: this.proofFiles(),
      compilerSources: [
        ...new Map(
          this.allGraphs.map((graph) => {
            return [
              graph.runtime.file,
              { file: graph.runtime.file, sha256: graph.runtime.source.sha256 },
            ];
          }),
        ).values(),
      ],
      ...(boundStage !== undefined && { boundStage }),
      requiresSdkNormalization: true,
    };
  }
}

/** Only the outer, exact generated SDK-root check can close the returned route terminals. */
export async function proveNodeManifestTurbopackConsumers(
  input: NodeManifestTurbopackConsumerInput,
): Promise<NodeManifestTurbopackConsumerProof> {
  return await new TurbopackConsumers(input).prove();
}
