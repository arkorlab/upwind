import { AuditError } from './dependencies.ts';
import { certifyNodeManifestHoist, nodeManifestHoistMember } from './node-manifest-hoist.ts';
import {
  certifyNodeManifestRouteKind,
  nodeManifestRouteKindMember,
} from './node-manifest-route-kind.ts';
import type {
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';
import type { NodeManifestTurbopackProjection } from './node-manifest-turbopack.ts';

export interface NodeManifestTemplateHelperOwner {
  readonly identity: symbol;
}
export interface NodeManifestTemplateHelperImport {
  readonly kind: 'selected Pages helper import';
}
export interface NodeManifestTemplateHelperMember {
  readonly module: 'dist/server/route-kind.js' | 'dist/build/templates/helpers.js';
  readonly name: 'RouteKind' | 'hoist';
}
interface HelperInput {
  readonly owner: NodeManifestTemplateHelperOwner;
  readonly consumer: NodeManifestTurbopackGraphFactory;
  readonly target: NodeManifestTurbopackGraphFactory;
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly specifier: string;
}
interface StoredImport {
  readonly input: HelperInput;
  readonly owner: NodeManifestTemplateHelperOwner;
  readonly consumer: NodeManifestTurbopackGraphFactory;
  readonly consumerProjection: NodeManifestTurbopackProjection;
  readonly consumerOriginal: NodeManifestTurbopackProjection['original'];
  readonly target: NodeManifestTurbopackGraphFactory;
  readonly targetProjection: NodeManifestTurbopackProjection;
  readonly targetOriginal: NodeManifestTurbopackProjection['original'];
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly physicalSource: NodeManifestTurbopackGraphFile['source'];
  readonly fingerprint: string;
}
const IMPORTS = new WeakMap<NodeManifestTemplateHelperImport, StoredImport>();

function identity(input: HelperInput): string {
  return JSON.stringify({
    consumer: input.consumer,
    physical: input.physical,
    specifier: input.specifier,
    target: input.target,
  });
}

function actualEdge(input: HelperInput): boolean {
  const edges = input.consumer.imports.filter((edge) => edge.specifier === input.specifier);
  const logical = input.consumer.projection.imports.filter(
    (edge) => edge.specifier === input.specifier,
  );
  return (
    edges.length > 0 &&
    edges.every((edge) => edge.target === input.target.id) &&
    logical.length > 0 &&
    logical.every((edge) => edge.targetId === input.target.projection.moduleId) &&
    input.consumer.runtimeId === input.target.runtimeId &&
    input.target.projection.factory.ids.includes(input.target.projection.moduleId) &&
    input.target.physicalId === input.physical.id &&
    JSON.stringify(input.physical.source) === JSON.stringify(input.target.projection.original)
  );
}

/** A private actual-edge binding; the selected helper body is still checked at member use. */
export function certifyNodeManifestTemplateHelperImport(
  input: HelperInput,
): NodeManifestTemplateHelperImport | undefined {
  if (!actualEdge(input)) return undefined;
  const proof = Object.freeze<NodeManifestTemplateHelperImport>({
    kind: 'selected Pages helper import',
  });
  IMPORTS.set(proof, {
    input,
    owner: input.owner,
    consumer: input.consumer,
    consumerProjection: input.consumer.projection,
    consumerOriginal: input.consumer.projection.original,
    target: input.target,
    targetProjection: input.target.projection,
    targetOriginal: input.target.projection.original,
    physical: input.physical,
    physicalSource: input.physical.source,
    fingerprint: identity(input),
  });
  return proof;
}

function current(
  proof: NodeManifestTemplateHelperImport,
  owner: NodeManifestTemplateHelperOwner,
  projection: NodeManifestTurbopackProjection,
): StoredImport | undefined {
  const stored = IMPORTS.get(proof);
  if (
    stored?.owner !== owner ||
    stored.consumerProjection !== projection ||
    stored.input.owner !== stored.owner ||
    stored.input.consumer !== stored.consumer ||
    stored.input.target !== stored.target ||
    stored.input.physical !== stored.physical ||
    stored.consumer.projection !== stored.consumerProjection ||
    stored.consumer.projection.original !== stored.consumerOriginal ||
    stored.target.projection !== stored.targetProjection ||
    stored.target.projection.original !== stored.targetOriginal ||
    stored.physical.source !== stored.physicalSource ||
    stored.fingerprint !== identity(stored.input) ||
    !actualEdge(stored.input)
  )
    return undefined;
  return stored;
}

/** A present connection proof cannot fall back to forged physical descriptor metadata. */
export function currentNodeManifestTemplateHelperImport(
  proof: NodeManifestTemplateHelperImport,
  input: {
    readonly owner: NodeManifestTemplateHelperOwner;
    readonly projection: NodeManifestTurbopackProjection;
    readonly specifier: string;
    readonly file: string;
    readonly sha256: string;
  },
): boolean {
  const stored = current(proof, input.owner, input.projection);
  return (
    stored?.input.specifier === input.specifier &&
    stored.physical.file === input.file &&
    stored.physical.source.sha256 === input.sha256
  );
}

/** No physical Next path or compiler privilege is minted for the actual build chunk. */
export function nodeManifestTemplateHelperMember(
  proof: NodeManifestTemplateHelperImport,
  input: {
    readonly owner: NodeManifestTemplateHelperOwner;
    readonly projection: NodeManifestTurbopackProjection;
    readonly exportName: string;
    readonly specifier: string;
    readonly file: string;
    readonly sha256: string;
  },
): NodeManifestTemplateHelperMember | undefined {
  const stored = current(proof, input.owner, input.projection);
  if (stored === undefined || !currentNodeManifestTemplateHelperImport(proof, input))
    return undefined;
  const selected = { owner: stored.owner, factory: stored.target, exportName: input.exportName };
  const kind = certifyNodeManifestRouteKind(selected);
  if (kind !== undefined && nodeManifestRouteKindMember(kind, selected) === 'RouteKind')
    return { module: 'dist/server/route-kind.js', name: 'RouteKind' };
  try {
    const hoist = certifyNodeManifestHoist(selected);
    if (nodeManifestHoistMember(hoist, selected) === 'hoist')
      return { module: 'dist/build/templates/helpers.js', name: 'hoist' };
  } catch (error) {
    if (
      !(error instanceof AuditError) ||
      !error.message.startsWith('Unproved Next.js hoist helper ') ||
      !error.message.endsWith('; refusing native publication')
    )
      throw error;
  }
  return undefined;
}
