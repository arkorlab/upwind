import { parseAst } from 'rolldown/parseAst';

import { isNode, type Node } from './lexical-scope.ts';
import { visitTree } from './node-manifest-consumer-ast.ts';
import {
  nodeManifestPagesForwarderSource,
  type NodeManifestPagesForwarderSource,
} from './node-manifest-pages-forwarder-source.ts';
import {
  nodeManifestRegistrationView,
  type NodeManifestRegistrationIndex,
} from './node-manifest-registration-registry.ts';
import type {
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackModuleId,
} from './node-manifest-turbopack.ts';

const CONJUNCTION: unique symbol = Symbol('pending Pages forwarding conjunction');
export interface NodeManifestPagesRoleConjunction {
  readonly [CONJUNCTION]: true;
}
export interface NodeManifestPagesRoleConjunctionInput {
  readonly owner: { readonly identity: symbol };
  readonly index: NodeManifestRegistrationIndex;
  readonly sources: readonly NodeManifestTurbopackGraphFile[];
  readonly moduleId: NodeManifestTurbopackModuleId;
  /** The actual current source object, not a supplied filename/hash approval. */
  readonly producer: NodeManifestTurbopackGraphFile;
}
interface Member {
  readonly id: string;
  readonly physicalId: string;
  readonly file: string;
  readonly sha256: string;
  readonly moduleId: NodeManifestTurbopackModuleId;
  readonly factory: {
    readonly ids: readonly NodeManifestTurbopackModuleId[];
    readonly start: number;
    readonly end: number;
  };
  readonly strictProjectionSha256: string;
  readonly target: NodeManifestPagesForwarderSource;
}
export interface NodeManifestPagesRoleCandidate {
  readonly kind: 'pending Pages producer conjunction';
  /** Phase two must close every parent through the SDK root and all bound obligations. */
  readonly requiresSdkBoundClosure: true;
  readonly runtimeId: string;
  readonly registrationId: string;
  readonly moduleId: NodeManifestTurbopackModuleId;
  readonly members: readonly Member[];
}
interface Stored {
  readonly input: NodeManifestPagesRoleConjunctionInput;
  readonly owner: NodeManifestPagesRoleConjunctionInput['owner'];
  readonly ownerIdentity: symbol;
  readonly index: NodeManifestRegistrationIndex;
  readonly sources: NodeManifestPagesRoleConjunctionInput['sources'];
  readonly producer: NodeManifestTurbopackGraphFile;
  readonly producerSource: NodeManifestTurbopackGraphFile['source'];
  readonly moduleId: NodeManifestTurbopackModuleId;
  readonly result: NodeManifestPagesRoleCandidate;
}
const CONJUNCTIONS = new WeakMap<NodeManifestPagesRoleConjunction, Stored>();

function originalFactory(row: NodeManifestTurbopackGraphFactory): Node | undefined {
  const parsed: unknown = parseAst(row.projection.original.code);
  if (!isNode(parsed)) return undefined;
  const range = row.projection.factory;
  return visitTree(parsed).find(({ node }) => node.start === range.start && node.end === range.end)
    ?.node;
}
function actualEdge(
  row: NodeManifestTurbopackGraphFactory,
  physical: NodeManifestTurbopackGraphFile,
  target: NodeManifestPagesForwarderSource,
): boolean {
  const edges = physical.imports.filter((edge) => edge.specifier === target.externalSpecifier);
  const edge = row.imports[0];
  return (
    row.imports.length === 1 &&
    edge?.specifier === target.externalSpecifier &&
    edge.target === target.sourceId &&
    edges.length === 1 &&
    edges[0]?.target === target.sourceId
  );
}
function checkedMember(
  row: NodeManifestTurbopackGraphFactory,
  input: NodeManifestPagesRoleConjunctionInput,
): Member | undefined {
  const physical = input.sources.find((source) => source.id === row.physicalId);
  const factory = originalFactory(row);
  if (
    physical === undefined ||
    factory === undefined ||
    row.projection.moduleId !== input.moduleId ||
    JSON.stringify(physical.source) !== JSON.stringify(row.projection.original)
  )
    return undefined;
  const target = nodeManifestPagesForwarderSource(factory, row.projection, input.producer);
  if (target === undefined || !actualEdge(row, physical, target)) return undefined;
  const strict = projectNodeManifestTurbopackFactory(row.projection.original, input.moduleId);
  if (
    JSON.stringify(strict.imports) !== JSON.stringify(row.projection.imports) ||
    strict.boundRuntimeInputs.length > 0
  )
    return undefined;
  return Object.freeze<Member>({
    id: row.id,
    physicalId: row.physicalId,
    file: physical.file,
    sha256: physical.source.sha256,
    moduleId: input.moduleId,
    factory: Object.freeze({ ...strict.factory, ids: Object.freeze([...strict.factory.ids]) }),
    strictProjectionSha256: strict.source.sha256,
    target,
  });
}
function inspect(
  input: NodeManifestPagesRoleConjunctionInput,
): NodeManifestPagesRoleCandidate | undefined {
  const view = nodeManifestRegistrationView(input.index, input.sources);
  if (input.sources.find((source) => source.id === input.producer.id) !== input.producer)
    return undefined;
  const registration = view.registrations.find((entry) => entry.moduleId === input.moduleId);
  if (registration === undefined || registration.members.length < 2) return undefined;
  const members: Member[] = [];
  const physical = new Set<string>();
  let expected: string | undefined;
  for (const id of registration.members) {
    const row = view.rows.find((candidate) => candidate.id === id);
    const member = row === undefined ? undefined : checkedMember(row, input);
    if (
      member === undefined ||
      row?.runtimeId !== view.runtimeId ||
      physical.has(member.physicalId)
    )
      return undefined;
    const identity = JSON.stringify(member.target);
    if (expected !== undefined && expected !== identity) return undefined;
    expected = identity;
    physical.add(member.physicalId);
    members.push(member);
  }
  return Object.freeze<NodeManifestPagesRoleCandidate>({
    kind: 'pending Pages producer conjunction',
    requiresSdkBoundClosure: true,
    runtimeId: view.runtimeId,
    registrationId: registration.id,
    moduleId: input.moduleId,
    members: Object.freeze(members),
  });
}

/** Source-bound pending DATA only. No descriptor, class, compiler, VM or normalization authority. */
export function certifyNodeManifestPagesRoleConjunction(
  input: NodeManifestPagesRoleConjunctionInput,
): NodeManifestPagesRoleConjunction | undefined {
  const result = inspect(input);
  if (result === undefined) return undefined;
  const proof = Object.freeze<NodeManifestPagesRoleConjunction>({ [CONJUNCTION]: true });
  CONJUNCTIONS.set(proof, {
    input,
    owner: input.owner,
    ownerIdentity: input.owner.identity,
    index: input.index,
    sources: input.sources,
    producer: input.producer,
    producerSource: input.producer.source,
    moduleId: input.moduleId,
    result,
  });
  return proof;
}

/** Copies and changed owner/source/index identities cannot borrow a pending conjunction. */
export function nodeManifestPagesRoleConjunction(
  proof: NodeManifestPagesRoleConjunction,
  input: NodeManifestPagesRoleConjunctionInput,
): NodeManifestPagesRoleCandidate | undefined {
  const stored = CONJUNCTIONS.get(proof);
  if (
    stored?.input !== input ||
    stored.owner !== input.owner ||
    stored.ownerIdentity !== input.owner.identity ||
    stored.index !== input.index ||
    stored.sources !== input.sources ||
    stored.producer !== input.producer ||
    stored.producerSource !== input.producer.source ||
    stored.moduleId !== input.moduleId
  )
    return undefined;
  const current = inspect(input);
  return JSON.stringify(current) === JSON.stringify(stored.result) ? stored.result : undefined;
}
