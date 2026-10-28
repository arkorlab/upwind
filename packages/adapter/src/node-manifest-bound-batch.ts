import { createHash } from 'node:crypto';

import { AuditError } from './dependencies.ts';
import { assertNodeManifestConsumer } from './node-manifest-consumers.ts';
import { APP_PAGE_CLASS, APP_PAGE_FACTORY } from './node-manifest-framework.ts';
import {
  nodeManifestRuntimeCohortSources,
  type NodeManifestRuntimeCohort,
} from './node-manifest-runtime-cohort.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumers.ts';
import type { NodeManifestTurbopackGraphFactory } from './node-manifest-turbopack-graph.ts';
import { projectNodeManifestTurbopackFactory } from './node-manifest-turbopack.ts';

const BATCH: unique symbol = Symbol('Node manifest bound proof batch');
const STAGE: unique symbol = Symbol('Node manifest bound proof stage');
const CONSUMER: unique symbol = Symbol('Node manifest bound consumer proof');
export interface NodeManifestBoundBatch {
  readonly [BATCH]: true;
}
export interface NodeManifestBoundStage {
  readonly [STAGE]: true;
}
export interface NodeManifestBoundConsumerProof {
  readonly [CONSUMER]: true;
}
interface BatchState {
  closed: boolean;
  scope: string | undefined;
  readonly obligations: Set<string>;
  readonly approved: Set<string>;
  readonly pending: Set<NodeManifestBoundStage>;
  readonly committed: Set<NodeManifestBoundStage>;
}
interface StageState {
  readonly batch: NodeManifestBoundBatch;
  readonly discharges: readonly string[];
}
const BATCHES = new WeakMap<NodeManifestBoundBatch, BatchState>();
const STAGES = new WeakMap<NodeManifestBoundStage, StageState>();
const CONSUMERS = new WeakMap<
  NodeManifestBoundConsumerProof,
  {
    readonly key: string;
    readonly scope: string | undefined;
    readonly batch: NodeManifestBoundBatch | undefined;
  }
>();

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js bound runtime batch ${reason}; refusing native publication`,
  );
}
function active(batch: NodeManifestBoundBatch): BatchState {
  const state = BATCHES.get(batch);
  if (state === undefined) return refuse('uncertified collector');
  if (state.closed) refuse('finalized collector');
  return state;
}
function digest(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== 'string') refuse('opaque proof identity');
  return createHash('sha256').update(serialized).digest('hex');
}
function sourceIdentity(
  source: NodeManifestTurbopackConsumerInput['sources'][number],
): readonly unknown[] {
  return [source.id, source.file, source.source.sha256, source.imports];
}
function boundScope(
  input: NodeManifestTurbopackConsumerInput,
  cohort: NodeManifestRuntimeCohort | undefined,
): string {
  if (cohort === undefined || input.runtimeProfiles === undefined)
    refuse('missing reviewed cohort');
  const runtimes = nodeManifestRuntimeCohortSources(cohort, input.sources);
  return digest({
    root: input.rootDir,
    dist: input.distDir,
    profiles: input.runtimeProfiles,
    sources: input.sources.map((source) => sourceIdentity(source)),
    runtimes,
    boots: cohort.boots,
    lookups: cohort.lookupEdges,
  });
}
function factoryFingerprint(factory: NodeManifestTurbopackGraphFactory): string {
  return digest([
    factory.physicalId,
    factory.projection.original.sha256,
    factory.projection.moduleId,
    factory.projection.factory.start,
    factory.projection.factory.end,
    factory.imports,
    factory.projection.boundRuntimeInputs,
  ]);
}
function obligation(
  factory: NodeManifestTurbopackGraphFactory,
  input: NodeManifestTurbopackConsumerInput,
): string {
  const source = input.sources.find((candidate) => candidate.id === factory.physicalId);
  if (
    source?.source.sha256 !== factory.projection.original.sha256 ||
    source.source.code !== factory.projection.original.code
  )
    refuse('factory source binding');
  return factoryFingerprint(factory);
}

/** A real AppPage source/import/runtime-input check, never a caller-supplied approval boolean. */
export function certifyNodeManifestBoundConsumer(input: {
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly imports: Parameters<typeof assertNodeManifestConsumer>[0]['imports'];
  readonly route: Parameters<typeof assertNodeManifestConsumer>[0]['route'];
  readonly context: NodeManifestTurbopackConsumerInput;
  readonly cohort: NodeManifestRuntimeCohort | undefined;
}): NodeManifestBoundConsumerProof {
  const checked = projectNodeManifestTurbopackFactory(
    input.factory.projection.original,
    input.factory.projection.moduleId,
  );
  if (
    checked.factory.start !== input.factory.projection.factory.start ||
    checked.factory.end !== input.factory.projection.factory.end ||
    checked.source.code !== input.factory.projection.source.code ||
    checked.source.sha256 !== input.factory.projection.source.sha256 ||
    JSON.stringify(checked.boundRuntimeInputs) !==
      JSON.stringify(input.factory.projection.boundRuntimeInputs)
  )
    refuse('AppPage source projection binding');
  const bindings = checked.boundRuntimeInputs;
  const required = bindings.filter((binding) => binding.kind === 'require');
  const chunks = bindings.filter((binding) => binding.kind === 'loadChunk');
  const requireInput = required[0];
  const loadChunkInput = chunks[0];
  if (
    requireInput === undefined ||
    loadChunkInput === undefined ||
    bindings.length !== 2 ||
    required.length !== 1 ||
    chunks.length !== 1
  )
    refuse('unproved bound runtime callbacks');
  assertNodeManifestConsumer({
    source: checked.source,
    imports: input.imports,
    route: input.route,
    runtimeInputs: { require: requireInput.identifier, loadChunk: loadChunkInput.identifier },
  });
  const scope = input.cohort === undefined ? undefined : boundScope(input.context, input.cohort);
  const proof = Object.freeze({ [CONSUMER]: true as const });
  CONSUMERS.set(proof, {
    key: factoryFingerprint(input.factory),
    scope,
    batch: input.context.boundBatch,
  });
  return proof;
}

/** Internal build scope only. A collector never appears in bundle or runtime configuration. */
export function createNodeManifestBoundBatch(): NodeManifestBoundBatch {
  const batch = Object.freeze({ [BATCH]: true as const });
  BATCHES.set(batch, {
    closed: false,
    scope: undefined,
    obligations: new Set(),
    approved: new Set(),
    pending: new Set(),
    committed: new Set(),
  });
  return batch;
}

/** A staged discharge is provisional until the outer graph closes every actual SDK terminal. */
export function stageNodeManifestBoundProof(input: {
  readonly batch: NodeManifestBoundBatch;
  readonly consumer: NodeManifestTurbopackConsumerInput;
  readonly cohort: NodeManifestRuntimeCohort | undefined;
  readonly factories: readonly NodeManifestTurbopackGraphFactory[];
  /** Only the private appPageConsumer validation path may supply these factories. */
  readonly certified: readonly NodeManifestBoundConsumerProof[];
}): NodeManifestBoundStage {
  const state = active(input.batch);
  if (input.consumer.boundBatch !== input.batch) refuse('consumer collector identity');
  const scope = boundScope(input.consumer, input.cohort);
  if (state.scope !== undefined && state.scope !== scope) refuse('source or cohort scope mismatch');
  state.scope = scope;
  const own = new Set<string>();
  for (const factory of input.factories) {
    if (factory.projection.boundRuntimeInputs.length === 0) continue;
    const key = obligation(factory, input.consumer);
    own.add(key);
    state.obligations.add(key);
  }
  const kind = input.consumer.producer.kind ?? APP_PAGE_FACTORY;
  if (kind !== APP_PAGE_CLASS && kind !== APP_PAGE_FACTORY && input.certified.length > 0)
    refuse('non-AppPage discharge');
  const discharges = input.certified.map((proof) => {
    const certified = CONSUMERS.get(proof);
    if (certified?.scope !== scope || certified.batch !== input.batch)
      refuse('uncertified or foreign AppPage discharge');
    if (!own.has(certified.key)) refuse('discharge outside bound inventory');
    return certified.key;
  });
  const stage = Object.freeze({ [STAGE]: true as const });
  STAGES.set(stage, { batch: input.batch, discharges: Object.freeze(discharges) });
  state.pending.add(stage);
  return stage;
}

/** Called only after the enclosing proof's actual SDK terminal recursion has succeeded. */
export function commitNodeManifestBoundStage(
  batch: NodeManifestBoundBatch,
  stage: NodeManifestBoundStage,
): void {
  const state = active(batch);
  const proof = STAGES.get(stage);
  if (proof?.batch !== batch || !state.pending.has(stage)) refuse('uncertified or reused stage');
  for (const key of proof.discharges) state.approved.add(key);
  state.pending.delete(stage);
  state.committed.add(stage);
}

/** Read-only intrinsic check: only the existing commit path can add this exact stage. */
export function assertNodeManifestBoundStageCommitted(
  batch: NodeManifestBoundBatch,
  stage: NodeManifestBoundStage,
): void {
  const state = active(batch);
  if (STAGES.get(stage)?.batch !== batch || !state.committed.has(stage))
    refuse('uncommitted or foreign SDK stage');
}

/** No source/compiler approvals may leave the outer graph before this final conjunction. */
export function assertNodeManifestBoundBatch(batch: NodeManifestBoundBatch): void {
  const state = active(batch);
  state.closed = true;
  if (state.pending.size > 0) refuse('uncommitted SDK terminal stage');
  for (const key of state.obligations)
    if (!state.approved.has(key)) refuse('bound callback escapes a sealed AppPage consumer');
}

/** Default callers retain the pre-batch immediate all-factory refusal and diagnostic. */
export function assertStandaloneNodeBoundConsumers(
  input: NodeManifestTurbopackConsumerInput,
  factories: Iterable<NodeManifestTurbopackGraphFactory>,
  certified: ReadonlySet<string>,
): void {
  if (input.boundBatch !== undefined) return;
  for (const factory of factories) {
    if (factory.projection.boundRuntimeInputs.length > 0 && !certified.has(factory.id))
      throw new AuditError(
        'Unproved Next.js Turbopack manifest chain bound runtime callback escapes a sealed consumer; refusing native publication',
      );
  }
}
