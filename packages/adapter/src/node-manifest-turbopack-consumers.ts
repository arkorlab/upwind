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
  type NodeManifestBoundConsumerProof,
} from './node-manifest-bound-batch.ts';
import { assertCoalescedPagesConsumer } from './node-manifest-coalesced-consumer.ts';
import {
  registerNodeManifestConsumerFactory,
  assertNodeManifestPhysicalCallers,
  restrictNodeManifestProtectedIncoming,
  type NodeManifestIncomingFallback,
} from './node-manifest-consumer-incoming.ts';
import type { NodeManifestConsumerImport } from './node-manifest-consumers.ts';
import { APP_PAGE_CLASS, APP_PAGE_FACTORY } from './node-manifest-framework.ts';
import { NodeManifestPagesConjunctionWalk } from './node-manifest-pages-conjunction-walk.ts';
import { nodeManifestPagesContextLeaf } from './node-manifest-pages-context-consumer.ts';
import {
  assertNodeManifestPassSingle,
  nodeManifestPassForwarded,
  nodeManifestPassTouchesProtected,
  withNodeManifestRegistrationPass,
  withNodeManifestRegistrationPassAsync,
  type NodeManifestRegistrationPass,
} from './node-manifest-registration-pass.ts';
import {
  createNodeManifestRegistrationViews,
  type NodeManifestRegistrationViews,
} from './node-manifest-registration-views.ts';
import {
  proveNodeManifestRuntimeCallers,
  type NodeManifestRuntimeCallerProof,
} from './node-manifest-runtime-callers.ts';
import {
  prepareNodeManifestRuntimeGraphs,
  type NodeManifestRuntimeCohort,
} from './node-manifest-runtime-cohort.ts';
import {
  nodeManifestCoalescedImports,
  nodeManifestTemplateImports,
} from './node-manifest-template-imports.ts';
import {
  nodeManifestTurbopackProducerKind,
  nodeManifestTurbopackProofFiles,
  type NodeManifestTurbopackConsumerInput,
  type NodeManifestTurbopackConsumerProof,
} from './node-manifest-turbopack-consumer-input.ts';
import {
  type NodeManifestTurbopackBootGraph,
  type NodeManifestTurbopackEntryGraph,
  type NodeManifestTurbopackGraphFactory,
  type NodeManifestTurbopackSealedEntry,
} from './node-manifest-turbopack-graph.ts';
import { assertNodeManifestTurbopackTemplateConsumer } from './node-manifest-turbopack-templates.ts';
import { projectNodeManifestTurbopackFactory } from './node-manifest-turbopack.ts';

export type {
  NodeManifestTurbopackConsumerInput,
  NodeManifestTurbopackConsumerProof,
} from './node-manifest-turbopack-consumer-input.ts';
type Role = 'class' | 'factory' | 'route-exports';

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest chain ${reason}; refusing native publication`,
  );
}

const CONSUMER_OWNERS = new WeakSet<Readonly<{ identity: symbol }>>();
/** An assertion only: the sole mint site is the private consumer constructor below. */
export function assertNodeManifestTurbopackConsumerOwner(
  owner: Readonly<{ identity: symbol }>,
): void {
  if (!CONSUMER_OWNERS.has(owner)) refuse('uncertified private consumer owner');
}

class TurbopackConsumers {
  private readonly input: NodeManifestTurbopackConsumerInput;
  private readonly graphs: readonly NodeManifestTurbopackEntryGraph[];
  private readonly allGraphs: readonly NodeManifestTurbopackBootGraph[];
  private readonly runtimeCohort: NodeManifestRuntimeCohort | undefined;
  private readonly registrations: NodeManifestRegistrationViews;
  private readonly proofFiles: Pick<
    NodeManifestTurbopackConsumerProof,
    'files' | 'compilerSources'
  >;
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
  private readonly conjunctionOwner = Object.freeze({
    identity: Symbol('private protected manifest consumer'),
  });
  private readonly pagesConjunction: NodeManifestPagesConjunctionWalk;
  private readonly helperOwner = Object.freeze({ identity: Symbol('Pages template helper owner') });
  private readonly certifiedFactories = new Map<string, NodeManifestAppPageFactoryProof>();
  private callerProof: NodeManifestRuntimeCallerProof | undefined;
  private pass: NodeManifestRegistrationPass | undefined;
  private reachabilityFallback: NodeManifestIncomingFallback;

  constructor(input: NodeManifestTurbopackConsumerInput) {
    this.input = input;
    CONSUMER_OWNERS.add(this.conjunctionOwner);
    const expectedKind = nodeManifestTurbopackProducerKind(this.input);
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
    this.registrations = createNodeManifestRegistrationViews(this.allGraphs, input.sources);
    for (const graph of this.allGraphs)
      for (const factory of graph.factories)
        registerNodeManifestConsumerFactory(factory, this.factories, this.incoming);
    this.pagesConjunction = new NodeManifestPagesConjunctionWalk({
      consumerOwner: this.conjunctionOwner,
      input,
      owner: this.helperOwner,
      graphs: this.allGraphs,
      registrations: this.registrations,
      factories: this.factories,
    });
    this.proofFiles = withNodeManifestRegistrationPass(this.registrations, (pass) => {
      this.pass = pass;
      try {
        this.initialize();
        return nodeManifestTurbopackProofFiles(this.allGraphs, input.sources, this.callerProof);
      } finally {
        this.pass = undefined;
      }
    });
  }

  private initialize(): void {
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
      this.input.runtimeCallers === undefined
        ? undefined
        : proveNodeManifestRuntimeCallers({
            inventory: this.input.runtimeCallers,
            graphs: this.allGraphs,
            registrations: this.registrations,
            pass: this.currentPass(),
            sources: this.input.sources,
            distDir: this.input.distDir,
          });
    const topology = {
      input: this.input,
      graphs: this.graphs,
      allGraphs: this.allGraphs,
      callerProof: this.callerProof,
      cohort: this.runtimeCohort,
    };
    assertNodeManifestPhysicalCallers(topology);
    this.reachabilityFallback = restrictNodeManifestProtectedIncoming({
      ...topology,
      factories: this.factories,
      incoming: this.incoming,
      registrations: this.registrations,
      pass: this.currentPass(),
    });
  }

  private unwrapped(id: string): string {
    const seen = new Set<string>();
    let current = id;
    assertNodeManifestPassSingle(this.currentPass(), current);
    while (this.factories.has(current)) {
      if (seen.has(current)) refuse('cyclic namespace forwarding');
      seen.add(current);
      const factory = this.factories.get(current);
      if (factory === undefined) return refuse('missing factory');
      const next = nodeManifestPassForwarded(this.currentPass(), factory.id);
      if (next === undefined) return current;
      current = next;
      assertNodeManifestPassSingle(this.currentPass(), current);
    }
    return current;
  }

  private assertAdditionalCallerRoles(): void {
    if (this.callerProof === undefined) return;
    const protectedBoots = new Set(this.graphs.map((graph) => graph.physicalId));
    for (const caller of this.callerProof.callers) {
      if (protectedBoots.has(caller.id)) continue;
      if (
        caller.invoked.some((id) =>
          nodeManifestPassTouchesProtected(this.currentPass(), id, this.complete),
        )
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
    assertNodeManifestPassSingle(this.currentPass(), factory.id);
    return {
      factory,
      sources: this.input.sources,
      target: (id, edge) =>
        this.pagesConjunction.imported(factory, edge, this.currentPass()) ?? this.importTarget(id),
      helper:
        nodeManifestTurbopackProducerKind(this.input) === 'pages'
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
    const kind = nodeManifestTurbopackProducerKind(this.input);
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
    ).map((entry) => {
      if ('conjunction' in entry) return refuse('Pages group used as AppPage factory');
      return entry;
    });
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
    assertNodeManifestPassSingle(this.currentPass(), factory.id);
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
    assertNodeManifestPassSingle(this.currentPass(), factory.id);
    if (
      role === 'factory' &&
      !this.routes.has(factory.id) &&
      !this.pagesConjunction.has(id) &&
      nodeManifestPagesContextLeaf(factory, id, this.unwrapped(id), this.input)
    )
      return;
    if (nodeManifestPassForwarded(this.currentPass(), factory.id) === id)
      await this.visit(factory.id, role);
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
    assertNodeManifestPassSingle(this.currentPass(), id);
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
        nodeManifestTurbopackProducerKind(this.input) === 'pages' &&
        route?.kind === 'pages' &&
        incoming.projection.cacheInitializers.length === 1;
      if (await this.visitPagesGroup(incoming, id, role)) continue;
      const factory = coalesced ? incoming : this.strictFactory(incoming);
      await this.visitParent(factory, id, role);
    }
    this.visiting.delete(id);
    this.complete.set(id, role);
  }

  private async visitPagesGroup(
    factory: NodeManifestTurbopackGraphFactory,
    id: string,
    role: Role,
  ): Promise<boolean> {
    const group = this.pagesConjunction.parent(factory, id, role, this.currentPass());
    if (group === undefined) return false;
    const done = this.complete.get(group.registrationId);
    if (done !== undefined) {
      if (done !== role) refuse('conflicting protected group role');
      return true;
    }
    if (this.visiting.has(group.registrationId)) refuse('cyclic protected group chain');
    this.visiting.add(group.registrationId);
    const parents = this.pagesConjunction.incoming(group, this.incoming);
    for (const parent of parents) {
      const incoming = this.factories.get(parent);
      if (incoming === undefined) refuse('unknown protected group consumer');
      const route = this.routes.get(parent);
      const coalesced =
        route?.kind === 'pages' && incoming.projection.cacheInitializers.length === 1;
      await this.visitParent(
        coalesced ? incoming : this.strictFactory(incoming),
        group.registrationId,
        role,
      );
    }
    this.pagesConjunction.complete(group, parents);
    this.visiting.delete(group.registrationId);
    for (const member of [group.registrationId, ...group.members]) this.complete.set(member, role);
    return true;
  }

  private currentPass(): NodeManifestRegistrationPass {
    return this.pass ?? refuse('inactive registration walk');
  }

  private async proveWithinPass(): Promise<NodeManifestTurbopackConsumerProof> {
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
    return this.pagesConjunction.stage({
      terminals: [...this.terminals.values()],
      ...this.proofFiles,
      ...(boundStage !== undefined && { boundStage }),
      requiresSdkNormalization: true,
    });
  }
  async prove(): Promise<NodeManifestTurbopackConsumerProof> {
    return await withNodeManifestRegistrationPassAsync(this.registrations, async (pass) => {
      this.pass = pass;
      try {
        return await this.proveWithinPass();
      } finally {
        this.pass = undefined;
      }
    });
  }
}

/** Only the outer, exact generated SDK-root check can close the returned route terminals. */
export async function proveNodeManifestTurbopackConsumers(
  input: NodeManifestTurbopackConsumerInput,
): Promise<NodeManifestTurbopackConsumerProof> {
  return await new TurbopackConsumers(input).prove();
}
