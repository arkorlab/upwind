import { createHash } from 'node:crypto';

import { AuditError } from './dependencies.ts';
import { assertNodeManifestBoundStageCommitted } from './node-manifest-bound-batch.ts';
import { manifestConstructorImport } from './node-manifest-framework.ts';
import { nodeManifestPagesConjunctionIncoming } from './node-manifest-pages-conjunction-incoming.ts';
import {
  certifyNodeManifestPagesRoleConjunction,
  nodeManifestPagesRoleConjunction,
  type NodeManifestPagesRoleCandidate,
  type NodeManifestPagesRoleConjunction,
  type NodeManifestPagesRoleConjunctionInput,
} from './node-manifest-pages-role-conjunction.ts';
import {
  assertNodeManifestPassBinding,
  nodeManifestPassMembers,
  type NodeManifestRegistrationPass,
} from './node-manifest-registration-pass.ts';
import {
  assertNodeManifestRegistrationRows,
  type NodeManifestRegistrationViews,
} from './node-manifest-registration-views.ts';
import {
  assertNodeManifestSdkTerminal,
  type NodeManifestSdkTerminalProof,
  type NodeManifestSdkTerminalScope,
} from './node-manifest-sdk-terminal.ts';
import type { NodeManifestTemplateHelperOwner } from './node-manifest-template-helpers.ts';
import type {
  NodeManifestTurbopackConsumerInput,
  NodeManifestTurbopackConsumerProof,
} from './node-manifest-turbopack-consumer-input.ts';
import { assertNodeManifestTurbopackConsumerOwner } from './node-manifest-turbopack-consumers.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
} from './node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackProjection } from './node-manifest-turbopack.ts';

const PORT: unique symbol = Symbol('pending all-member Pages constructor port');
const STAGE: unique symbol = Symbol('pending Pages conjunction SDK stage');
export interface NodeManifestPagesConjunctionPort {
  readonly [PORT]: true;
}
export interface NodeManifestPagesConjunctionStage {
  readonly [STAGE]: true;
}
export interface NodeManifestPagesConjunctionImport {
  readonly kind: 'pages-constructor-conjunction';
  readonly specifier: string;
  readonly conjunction: NodeManifestPagesConjunctionPort;
}
export interface NodeManifestPagesConjunctionGroup {
  readonly registrationId: string;
  readonly members: readonly string[];
}
interface Group {
  readonly handle: NodeManifestPagesConjunctionGroup;
  readonly input: NodeManifestPagesRoleConjunctionInput;
  readonly proof: NodeManifestPagesRoleConjunction;
  readonly candidate: NodeManifestPagesRoleCandidate;
  readonly scope: NodeManifestRegistrationPass;
  parents: readonly string[] | undefined;
  incoming: ReadonlyMap<string, ReadonlySet<string>> | undefined;
  expectedParents: readonly string[] | undefined;
}
interface Port {
  readonly walk: NodeManifestPagesConjunctionWalk;
  readonly group: Group;
  readonly imported: NodeManifestPagesConjunctionImport;
  readonly consumer: NodeManifestTurbopackGraphFactory;
  readonly projection: NodeManifestTurbopackProjection;
  readonly original: NodeManifestTurbopackProjection['original'];
  readonly fingerprint: string;
}
interface Stage {
  readonly proof: NodeManifestTurbopackConsumerProof;
  readonly walk: NodeManifestPagesConjunctionWalk;
  readonly snapshot: string;
  readonly terminals: NodeManifestTurbopackConsumerProof['terminals'];
  readonly files: ReadonlyMap<string, string>;
  readonly context: Pick<NodeManifestTurbopackConsumerInput, 'rootDir' | 'distDir'>;
  readonly batch: NodeManifestTurbopackConsumerInput['boundBatch'];
  readonly boundStage: NodeManifestTurbopackConsumerProof['boundStage'];
  pending: boolean;
}
const PORTS = new WeakMap<NodeManifestPagesConjunctionPort, Port>();
const STAGES = new WeakMap<NodeManifestPagesConjunctionStage, Stage>();
const PROOFS = new WeakMap<
  NodeManifestTurbopackConsumerProof,
  NodeManifestPagesConjunctionStage | undefined
>();

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const member of left) if (!right.has(member)) return false;
  return true;
}

function refuse(reason: string): never {
  throw new AuditError(`Unproved Pages conjunction ${reason}; refusing native publication`);
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function portIdentity(consumer: NodeManifestTurbopackGraphFactory): string {
  return digest([consumer.projection, consumer.imports, consumer.runtimeId, consumer.physicalId]);
}
function stageIdentity(proof: NodeManifestTurbopackConsumerProof): string {
  return digest([
    proof.terminals,
    proof.files,
    proof.compilerSources,
    proof.requiresSdkNormalization,
  ]);
}
function actualPort(port: Port): boolean {
  const { group, consumer, projection, imported } = port;
  const edges = consumer.imports.filter((edge) => edge.specifier === imported.specifier);
  const logical = projection.imports.filter((edge) => edge.specifier === imported.specifier);
  const targets = new Set([group.candidate.registrationId, ...group.handle.members]);
  return (
    consumer.projection === projection &&
    consumer.projection.original === port.original &&
    portIdentity(consumer) === port.fingerprint &&
    consumer.runtimeId === group.candidate.runtimeId &&
    edges.length > 0 &&
    edges.every((edge) => targets.has(edge.target)) &&
    logical.length > 0 &&
    logical.every((edge) => edge.targetId === group.candidate.moduleId)
  );
}

/** Pending constructor port only. Every physical alternative stays represented; no file is invented. */
export function nodeManifestPagesConjunctionIdentity(
  imported: NodeManifestPagesConjunctionImport,
  context: {
    readonly owner?: NodeManifestTemplateHelperOwner | undefined;
    readonly projection?: NodeManifestTurbopackProjection | undefined;
  },
): { readonly root: string; readonly module: string } {
  const port = PORTS.get(imported.conjunction);
  if (
    port?.imported !== imported ||
    port.walk.owner !== context.owner ||
    port.projection !== context.projection ||
    !actualPort(port)
  )
    return refuse('foreign or stale constructor port');
  port.walk.assertPass(port.group.scope);
  const identities = new Map<string, { readonly root: string; readonly module: string }>();
  for (const member of port.group.candidate.members) {
    const identity = manifestConstructorImport(
      member.target.sourceFile,
      member.target.sourceSha256,
    );
    if (identity?.kind !== 'pages') return refuse('non-Pages constructor target');
    identities.set(JSON.stringify([identity.root, identity.module]), identity);
  }
  if (identities.size !== 1) return refuse('different constructor alternatives');
  return identities.values().next().value ?? refuse('missing constructor alternatives');
}

function pendingStage(proof: NodeManifestTurbopackConsumerProof): Stage | undefined {
  if (!PROOFS.has(proof)) return refuse('uncertified consumer proof');
  const handle = PROOFS.get(proof);
  if (handle !== proof.pagesConjunctionStage)
    return refuse('changed pending SDK stage association');
  if (handle === undefined) return undefined;
  const state = STAGES.get(handle);
  if (state?.proof !== proof || !state.pending || state.snapshot !== stageIdentity(proof))
    refuse('foreign, changed or reused SDK stage');
  return state;
}

/** Sole final admission remains the enclosing graph's completed route rewrite approval. */
export async function commitNodeManifestPagesConjunctionStage(
  proof: NodeManifestTurbopackConsumerProof,
  certificates: readonly NodeManifestSdkTerminalProof[],
): Promise<void> {
  const state = pendingStage(proof);
  if (state === undefined) return;
  const batch = state.walk.input.boundBatch;
  if (batch !== state.batch || proof.boundStage !== state.boundStage)
    refuse('changed bound SDK stage');
  if (batch === undefined || proof.boundStage === undefined) refuse('missing bound SDK stage');
  assertNodeManifestBoundStageCommitted(batch, proof.boundStage);
  const scope = state.walk.sdkScope;
  if (scope === undefined || certificates.length !== state.terminals.length)
    refuse('missing complete SDK terminal certificates');
  for (const [index, terminal] of state.terminals.entries()) {
    const certificate = certificates[index];
    const sha256 = state.files.get(terminal.file);
    if (certificate === undefined || sha256 === undefined)
      refuse('missing original SDK terminal source');
    await assertNodeManifestSdkTerminal(certificate, {
      scope,
      consumer: state.context,
      terminal,
      sha256,
    });
  }
  state.walk.assertFresh();
  if (
    !state.pending ||
    state.snapshot !== stageIdentity(proof) ||
    state.boundStage !== proof.boundStage ||
    state.batch !== state.walk.input.boundBatch
  )
    refuse('changed SDK stage after source validation');
  assertNodeManifestBoundStageCommitted(batch, proof.boundStage);
  state.pending = false;
}

/** Internal scoped ledger: classification is provisional until ALL actual parents and SDK roots close. */
export class NodeManifestPagesConjunctionWalk {
  private readonly rowPointers: readonly NodeManifestTurbopackGraphFactory[];
  private readonly consumerOwner: Readonly<{ identity: symbol }>;
  private derivedIncoming: ReadonlyMap<string, readonly string[]> | undefined;
  private readonly groups = new Map<string, Group>();
  private readonly ports = new Set<Port>();
  private readonly fingerprint: string;
  private readonly producer: NodeManifestPagesRoleConjunctionInput['producer'] | undefined;
  private readonly sources: NodeManifestTurbopackConsumerInput['sources'];

  private readonly graphs: readonly NodeManifestTurbopackBootGraph[];
  private readonly registrations: NodeManifestRegistrationViews;
  private readonly factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;

  readonly input: NodeManifestTurbopackConsumerInput;
  readonly owner: NodeManifestTemplateHelperOwner;
  readonly sdkScope: NodeManifestSdkTerminalScope | undefined;

  constructor(context: {
    readonly consumerOwner: Readonly<{ identity: symbol }>;
    readonly input: NodeManifestTurbopackConsumerInput;
    readonly owner: NodeManifestTemplateHelperOwner;
    readonly graphs: readonly NodeManifestTurbopackBootGraph[];
    readonly registrations: NodeManifestRegistrationViews;
    readonly factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;
  }) {
    assertNodeManifestTurbopackConsumerOwner(context.consumerOwner);
    this.consumerOwner = context.consumerOwner;
    this.input = context.input;
    this.owner = context.owner;
    this.sdkScope = context.input.sdkTerminalScope;
    this.graphs = context.graphs;
    this.registrations = context.registrations;
    this.factories = context.factories;
    this.rowPointers = Object.freeze([...context.factories.values()]);
    const input = context.input;
    this.producer = input.sources.find((source) => source.id === input.producer.id);
    this.sources = input.sources;
    this.fingerprint = this.identity();
  }

  private identity(): string {
    return digest([this.input, this.graphs]);
  }

  private existingGroup(id: string): Group | undefined {
    for (const group of this.groups.values())
      if (group.handle.registrationId === id || group.handle.members.includes(id)) return group;
    return undefined;
  }

  private group(id: string, scope: NodeManifestRegistrationPass): Group | undefined {
    this.assertPass(scope);
    const members = nodeManifestPassMembers(scope, id);
    if (members === undefined || members.length < 2) return undefined;
    if (this.derivedIncoming === undefined) {
      if (this.fingerprint !== this.identity()) return refuse('changed original topology');
      this.derivedIncoming = nodeManifestPagesConjunctionIncoming({
        input: this.input,
        graphs: this.graphs,
        registrations: this.registrations,
        factories: this.factories,
        scope,
      });
    }
    const found = this.existingGroup(id);
    if (found !== undefined) {
      if (found.scope !== scope) return refuse('different active walk');
      return found;
    }
    if (this.input.producer.kind !== 'pages-class' || this.producer === undefined)
      return refuse('grouped constructor kind');
    const rows = members.map((member) => this.factories.get(member));
    const row = rows[0];
    const graph = this.graphs.find((candidate) => candidate.runtimeId === row?.runtimeId);
    if (row === undefined || graph?.registrationIndex === undefined)
      return refuse('missing runtime index');
    const input: NodeManifestPagesRoleConjunctionInput = Object.freeze({
      owner: this.owner,
      index: graph.registrationIndex,
      sources: this.sources,
      moduleId: row.projection.moduleId,
      producer: this.producer,
    });
    const proof = certifyNodeManifestPagesRoleConjunction(input);
    const candidate =
      proof === undefined ? undefined : nodeManifestPagesRoleConjunction(proof, input);
    if (
      candidate === undefined ||
      proof === undefined ||
      JSON.stringify(candidate.members.map((member) => member.id)) !== JSON.stringify(members)
    )
      return refuse('unproved all-member Pages forwarding');
    const handle = Object.freeze({
      registrationId: candidate.registrationId,
      members: Object.freeze([...members]),
    });
    const group: Group = {
      handle,
      input,
      proof,
      candidate,
      scope,
      parents: undefined,
      incoming: undefined,
      expectedParents: undefined,
    };
    this.groups.set(handle.registrationId, group);
    return group;
  }

  private assertGroupFresh(group: Group): void {
    if (
      group.parents === undefined ||
      group.incoming === undefined ||
      group.expectedParents === undefined ||
      JSON.stringify(group.parents) !== JSON.stringify(group.expectedParents) ||
      nodeManifestPagesRoleConjunction(group.proof, group.input) !== group.candidate
    )
      return refuse('unclosed or stale physical conjunction');
    const current = new Set<string>();
    for (const id of [group.handle.registrationId, ...group.handle.members]) {
      const parents = group.incoming.get(id);
      if (parents !== undefined) for (const parent of parents) current.add(parent);
    }
    if (JSON.stringify([...current]) !== JSON.stringify(group.expectedParents))
      refuse('changed group callers');
  }

  private owned(handle: NodeManifestPagesConjunctionGroup): Group {
    const group = this.groups.get(handle.registrationId);
    return group?.handle === handle ? group : refuse('foreign group handle');
  }

  assertPass(scope: NodeManifestRegistrationPass): void {
    assertNodeManifestTurbopackConsumerOwner(this.consumerOwner);
    assertNodeManifestPassBinding(scope, this.registrations);
  }

  parent(
    factory: NodeManifestTurbopackGraphFactory,
    target: string,
    role: string,
    scope: NodeManifestRegistrationPass,
  ): NodeManifestPagesConjunctionGroup | undefined {
    if (
      role !== 'factory' ||
      target !== this.input.producer.id ||
      this.input.producer.kind !== 'pages-class'
    )
      return undefined;
    const group = this.group(factory.id, scope);
    if (group === undefined) return undefined;
    if (!group.handle.members.includes(factory.id)) return refuse('foreign physical group member');
    return group.handle;
  }

  incoming(
    handle: NodeManifestPagesConjunctionGroup,
    incoming: ReadonlyMap<string, ReadonlySet<string>>,
  ): readonly string[] {
    if (this.derivedIncoming === undefined) return refuse('missing original topology');
    const group = this.owned(handle);
    const expected = new Set<string>();
    const supplied = new Set<string>();
    for (const id of [handle.registrationId, ...handle.members]) {
      const actual = this.derivedIncoming.get(id);
      if (actual !== undefined) for (const parent of actual) expected.add(parent);
      const observed = incoming.get(id);
      if (observed !== undefined) for (const parent of observed) supplied.add(parent);
    }
    if (!sameMembers(expected, supplied)) return refuse('incomplete original incoming edges');
    const parents = Object.freeze([...expected]);
    group.incoming = incoming;
    group.expectedParents = parents;
    return parents;
  }

  complete(handle: NodeManifestPagesConjunctionGroup, parents: readonly string[]): void {
    const group = this.owned(handle);
    if (parents.length === 0 || parents !== group.expectedParents)
      return refuse('unclosed group parents');
    group.parents = Object.freeze([...parents]);
  }

  has(id: string): boolean {
    return this.existingGroup(id) !== undefined;
  }

  imported(
    consumer: NodeManifestTurbopackGraphFactory,
    edge: { readonly specifier: string; readonly target: string },
    scope: NodeManifestRegistrationPass,
  ): NodeManifestPagesConjunctionImport | undefined {
    const group = this.group(edge.target, scope);
    if (group === undefined) return undefined;
    const portHandle = Object.freeze<NodeManifestPagesConjunctionPort>({ [PORT]: true });
    const imported = Object.freeze<NodeManifestPagesConjunctionImport>({
      kind: 'pages-constructor-conjunction',
      specifier: edge.specifier,
      conjunction: portHandle,
    });
    const port: Port = {
      walk: this,
      group,
      imported,
      consumer,
      projection: consumer.projection,
      original: consumer.projection.original,
      fingerprint: portIdentity(consumer),
    };
    if (!actualPort(port)) return refuse('constructor import edge');
    PORTS.set(portHandle, port);
    this.ports.add(port);
    return imported;
  }

  assertFresh(): void {
    assertNodeManifestTurbopackConsumerOwner(this.consumerOwner);
    if (
      this.sources !== this.input.sources ||
      this.sdkScope !== this.input.sdkTerminalScope ||
      this.fingerprint !== this.identity()
    )
      return refuse('changed owner or graph scope');
    const rows = [...this.factories.values()];
    if (
      rows.length !== this.rowPointers.length ||
      rows.some((row, index) => this.rowPointers[index] !== row)
    )
      refuse('changed physical row inventory');
    assertNodeManifestRegistrationRows(this.registrations, rows);
    for (const group of this.groups.values()) this.assertGroupFresh(group);
    for (const port of this.ports)
      if (!actualPort(port)) return refuse('stale parent constructor port');
  }

  stage(proof: NodeManifestTurbopackConsumerProof): NodeManifestTurbopackConsumerProof {
    assertNodeManifestTurbopackConsumerOwner(this.consumerOwner);
    if (this.groups.size === 0) {
      PROOFS.set(proof, undefined);
      return proof;
    }
    this.assertFresh();
    const stage = Object.freeze<NodeManifestPagesConjunctionStage>({ [STAGE]: true });
    const result = { ...proof, pagesConjunctionStage: stage };
    PROOFS.set(result, stage);
    STAGES.set(stage, {
      proof: result,
      walk: this,
      snapshot: stageIdentity(result),
      terminals: Object.freeze(
        proof.terminals.map((terminal) => Object.freeze(structuredClone(terminal))),
      ),
      files: new Map(proof.files.map((source) => [source.file, source.sha256])),
      context: Object.freeze({ rootDir: this.input.rootDir, distDir: this.input.distDir }),
      batch: this.input.boundBatch,
      boundStage: proof.boundStage,
      pending: true,
    });
    return result;
  }
}
