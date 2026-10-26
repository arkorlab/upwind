import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import { AuditError } from './dependencies.ts';
import {
  assertCurrentNodeManifestCompilerRoot,
  nodeManifestCompilerRoot,
} from './node-manifest-compiler-root.ts';
import { manifestConstructorImport } from './node-manifest-framework.ts';
import {
  nodeManifestHandlerActualData,
  type NodeManifestHandlerActualData,
} from './node-manifest-handler-actual.ts';
import {
  NODE_MANIFEST_HANDLER_MODULE,
  NODE_MANIFEST_HANDLER_PROFILES,
  NODE_MANIFEST_HANDLER_SHA256,
  type NodeManifestHandlerProfile,
} from './node-manifest-handler-catalog.ts';
import { compareNodeManifestHandlerGraphs } from './node-manifest-handler-graph.ts';
import { nodeManifestHandlerLiteralValues } from './node-manifest-handler-literals.ts';
import {
  assertCurrentNodeManifestHandlerFiles,
  assertCurrentNodeManifestHandlerDirectory,
  checkedNodeManifestHandlerDirectory,
  checkedNodeManifestHandlerFile,
  checkedNodeManifestHandlerPin,
  type NodeManifestHandlerFile,
  type NodeManifestHandlerDirectory,
} from './node-manifest-handler-sources.ts';
import {
  assertNodeManifestPassBinding,
  assertNodeManifestPassRows,
  assertNodeManifestPassSources,
  type NodeManifestRegistrationPass,
} from './node-manifest-registration-pass.ts';
import {
  assertNodeManifestRegistrationRows,
  type NodeManifestRegistrationViews,
} from './node-manifest-registration-views.ts';
import {
  nodeManifestRuntimeCohortSources,
  type NodeManifestRuntimeCohort,
} from './node-manifest-runtime-cohort.ts';
import { assertNodeManifestPendingSdkContext } from './node-manifest-sdk-terminal.ts';
import type { NodeManifestTemplateHelperOwner } from './node-manifest-template-helpers.ts';
import type { NodeManifestTurbopackConsumerInput } from './node-manifest-turbopack-consumer-input.ts';
import { assertNodeManifestTurbopackConsumerOwner } from './node-manifest-turbopack-consumers.ts';
import type {
  NodeManifestTurbopackBootGraph,
  NodeManifestTurbopackGraphFactory,
  NodeManifestTurbopackGraphFile,
} from './node-manifest-turbopack-graph.ts';

const CONTEXT: unique symbol = Symbol('private Pages handler comparison context');
export interface NodeManifestHandlerContext {
  readonly [CONTEXT]: true;
}
export interface NodeManifestHandlerOwnerBinding {
  readonly owner: NodeManifestTemplateHelperOwner;
  readonly input: NodeManifestTurbopackConsumerInput;
  readonly graphs: readonly NodeManifestTurbopackBootGraph[];
  readonly registrations: NodeManifestRegistrationViews;
  readonly factories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;
  readonly strictFactories: ReadonlyMap<string, NodeManifestTurbopackGraphFactory>;
  readonly cohort: NodeManifestRuntimeCohort | undefined;
}
interface ContextInput {
  readonly owned: NodeManifestHandlerOwnerBinding;
  readonly consumerOwner: Readonly<{ identity: symbol }>;
  readonly pass: NodeManifestRegistrationPass;
}
interface State {
  readonly input: ContextInput;
  readonly captured: ContextInput;
  readonly rows: readonly NodeManifestTurbopackGraphFactory[];
  readonly pointers: readonly unknown[];
  readonly fingerprint: string;
  readonly nextRoot: string;
  readonly directory: NodeManifestHandlerDirectory;
  readonly pins: ReadonlyMap<NodeManifestHandlerProfile, readonly NodeManifestHandlerFile[]>;
  readonly files: Map<string, NodeManifestHandlerFile>;
  readonly used: Map<string, NodeManifestTurbopackGraphFile>;
  readonly consumers: Map<NodeManifestTurbopackGraphFactory, readonly unknown[]>;
  rootUsed: boolean;
  metadata: readonly { readonly file: string; readonly sha256: string }[] | undefined;
}
const CONTEXTS = new WeakMap<NodeManifestHandlerContext, State>();
function refuse(reason: string): never {
  throw new AuditError(`Unproved Pages handler ${reason}; refusing helper member`);
}
function graphPointers(graph: NodeManifestTurbopackBootGraph): readonly unknown[] {
  return [graph, graph.factories, graph.registrationIndex, graph.runtime];
}
function rowPointers(row: NodeManifestTurbopackGraphFactory): readonly unknown[] {
  return [row, row.projection, row.projection.original, row.imports];
}
function pointers(input: ContextInput): readonly unknown[] {
  const binding = input.owned.input.compilerRootBinding;
  return [
    input.owned,
    input.consumerOwner,
    input.pass,
    input.owned.input.sources,
    input.owned.input.producer,
    input.owned.input.sdkTerminalScope,
    binding,
    binding?.proof,
    binding?.input,
    ...input.owned.graphs.flatMap((graph) => graphPointers(graph)),
    ...[...input.owned.factories.values()].flatMap((row) => rowPointers(row)),
    ...input.owned.input.sources.flatMap((source) => [source, source.source, source.imports]),
  ];
}
function fingerprint(input: ContextInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.owned.input,
        input.owned.graphs,
        [...input.owned.factories],
        input.owned.cohort,
        NODE_MANIFEST_HANDLER_PROFILES,
      ]),
    )
    .digest('hex');
}
function ownedCurrent(state: State): void {
  const { input, captured } = state;
  assertNodeManifestTurbopackConsumerOwner(input.consumerOwner, input.owned);
  const values = Object.values(input);
  if (
    values.length !== Object.values(captured).length ||
    values.some((value, index) => value !== Object.values(captured)[index])
  )
    refuse('changed private context input');
  assertNodeManifestRegistrationRows(input.owned.registrations, state.rows);
  const actual = pointers(input);
  if (
    actual.length !== state.pointers.length ||
    actual.some((value, index) => value !== state.pointers[index]) ||
    fingerprint(input) !== state.fingerprint
  )
    refuse('changed private context sources or graph');
  if (input.owned.cohort === undefined) refuse('missing current runtime cohort');
  nodeManifestRuntimeCohortSources(input.owned.cohort, input.owned.input.sources);
  for (const [consumer, known] of state.consumers)
    if (
      (input.owned.strictFactories.get(consumer.id) !== consumer &&
        input.owned.factories.get(consumer.id) !== consumer) ||
      [
        consumer.projection,
        consumer.projection.original,
        consumer.imports,
        JSON.stringify(consumer),
      ].some((value, index) => value !== known[index])
    )
      refuse('changed actual template consumer');
  const scope = input.owned.input.sdkTerminalScope;
  if (scope === undefined) refuse('missing pending SDK scope');
  assertNodeManifestPendingSdkContext(scope, input.owned.input);
}
function checked(state: State): void {
  assertNodeManifestPassBinding(state.input.pass, state.input.owned.registrations);
  assertNodeManifestPassSources(state.input.pass, state.input.owned.input.sources);
  assertNodeManifestPassRows(state.input.pass, state.rows);
  ownedCurrent(state);
}
function current(context: NodeManifestHandlerContext): State {
  const state = CONTEXTS.get(context);
  if (state === undefined) return refuse('uncertified or copied context');
  checked(state);
  return state;
}

/** Only the unexported real consumer may mint this context; no caller reference/catalog is accepted. */
export async function qualifyNodeManifestHandlerContext(
  input: ContextInput,
): Promise<NodeManifestHandlerContext | undefined> {
  assertNodeManifestTurbopackConsumerOwner(input.consumerOwner, input.owned);
  if (
    input.owned.input.producer.kind !== 'pages-class' ||
    input.owned.cohort === undefined ||
    input.owned.input.sdkTerminalScope === undefined
  )
    return undefined;
  const captured = Object.freeze({ ...input });
  const originalPointers = pointers(input);
  const originalFingerprint = fingerprint(input);
  const rows = Object.freeze([...input.owned.factories.values()]);
  assertNodeManifestPassBinding(input.pass, input.owned.registrations);
  assertNodeManifestPassSources(input.pass, input.owned.input.sources);
  assertNodeManifestPassRows(input.pass, rows);
  const producer = input.owned.input.sources.find(
    (source) => source.id === input.owned.input.producer.id,
  );
  const identity =
    producer === undefined
      ? undefined
      : manifestConstructorImport(producer.file, producer.source.sha256);
  if (
    identity?.kind !== 'pages' ||
    producer?.file !== input.owned.input.producer.file ||
    producer.source.sha256 !== input.owned.input.producer.sha256
  )
    return refuse('actual pinned Pages producer');
  const source = await checkedNodeManifestHandlerFile(producer.file, producer.source.sha256);
  const nextRoot = await realpath(identity.root);
  if (nextRoot !== identity.root) return refuse('ambiguous declared Next root');
  const directory = await checkedNodeManifestHandlerDirectory(nextRoot);
  const binding = input.owned.input.compilerRootBinding;
  if (
    binding !== undefined &&
    NODE_MANIFEST_HANDLER_PROFILES.some((profile) => profile.literalSlots.length > 0)
  )
    await assertCurrentNodeManifestCompilerRoot(binding.proof, binding.input);
  const pins = new Map<NodeManifestHandlerProfile, readonly NodeManifestHandlerFile[]>();
  for (const profile of NODE_MANIFEST_HANDLER_PROFILES) {
    if (
      ![1].includes(profile.version) ||
      !['getHandler'].includes(profile.exportName) ||
      profile.declaredExport.length === 0 ||
      profile.sources.every((pin) => {
        return !(
          pin.relative === NODE_MANIFEST_HANDLER_MODULE &&
          pin.sha256 === NODE_MANIFEST_HANDLER_SHA256
        );
      })
    )
      return refuse('unqualified static profile producer');
    const files: NodeManifestHandlerFile[] = [];
    for (const pin of profile.sources)
      files.push(await checkedNodeManifestHandlerPin(nextRoot, pin));
    pins.set(profile, Object.freeze(files));
  }
  const state: State = {
    input,
    captured,
    rows,
    pointers: originalPointers,
    fingerprint: originalFingerprint,
    nextRoot,
    directory,
    pins,
    files: new Map([[source.file, source]]),
    used: new Map(),
    consumers: new Map(),
    rootUsed: false,
    metadata: undefined,
  };
  await assertCurrentNodeManifestHandlerDirectory(directory);
  checked(state);
  const context = Object.freeze<NodeManifestHandlerContext>({ [CONTEXT]: true });
  CONTEXTS.set(context, state);
  return context;
}

interface HandlerUse {
  readonly owner: NodeManifestTemplateHelperOwner;
  readonly consumer: NodeManifestTurbopackGraphFactory;
  readonly target: NodeManifestTurbopackGraphFactory;
  readonly physical: NodeManifestTurbopackGraphFile;
  readonly specifier: string;
  readonly exportName: string;
  readonly nextRoot: string | undefined;
}
function actualUse(state: State, input: HandlerUse): boolean {
  if (
    input.owner !== state.input.owned.owner ||
    input.nextRoot !== state.nextRoot ||
    (state.input.owned.factories.get(input.consumer.id) !== input.consumer &&
      state.input.owned.strictFactories.get(input.consumer.id) !== input.consumer) ||
    state.input.owned.factories.get(input.target.id) !== input.target ||
    !state.input.owned.input.sources.includes(input.physical) ||
    input.physical.id !== input.target.physicalId ||
    input.physical.source !== input.target.projection.original
  )
    return false;
  const edges = input.consumer.imports.filter((edge) => edge.specifier === input.specifier);
  const logical = input.consumer.projection.imports.filter(
    (edge) => edge.specifier === input.specifier,
  );
  return (
    !(
      edges.length === 0 ||
      edges.some((edge) => edge.target !== input.target.id) ||
      logical.length === 0 ||
      logical.some((edge) => edge.targetId !== input.target.projection.moduleId)
    ) && input.consumer.runtimeId === input.target.runtimeId
  );
}
export function nodeManifestHandlerMember(
  context: NodeManifestHandlerContext,
  input: HandlerUse,
):
  | { readonly module: typeof NODE_MANIFEST_HANDLER_MODULE; readonly name: 'getHandler' }
  | undefined {
  const state = current(context);
  if (!actualUse(state, input)) return undefined;
  const profiles = NODE_MANIFEST_HANDLER_PROFILES.filter(
    (profile) => profile.declaredExport === input.exportName,
  );
  if (profiles.length === 0) return undefined;
  const actual = nodeManifestHandlerActualData({
    pass: state.input.pass,
    rows: state.rows,
    sources: state.input.owned.input.sources,
    root: input.target,
    nextRoot: state.nextRoot,
  });
  if (actual === undefined) return undefined;
  for (const profile of profiles) {
    if (!matched(state, profile, actual)) continue;
    state.consumers.set(input.consumer, [
      input.consumer.projection,
      input.consumer.projection.original,
      input.consumer.imports,
      JSON.stringify(input.consumer),
    ]);
    return { module: NODE_MANIFEST_HANDLER_MODULE, name: 'getHandler' };
  }
  return undefined;
}

function matched(
  state: State,
  profile: NodeManifestHandlerProfile,
  actual: NodeManifestHandlerActualData,
): boolean {
  const literalSlots = nodeManifestHandlerLiteralValues({
    binding: state.input.owned.input.compilerRootBinding,
    distDir: state.input.owned.input.distDir,
    nextRoot: state.nextRoot,
    profile,
  });
  if (literalSlots === undefined && profile.literalSlots.length > 0) return false;
  const comparison = compareNodeManifestHandlerGraphs({
    reference: profile.reference,
    actual: actual.graph,
    literalSlots,
  });
  if (comparison.comparison !== 'equal') return false;
  for (const source of actual.sources) state.used.set(source.id, source);
  const pins = state.pins.get(profile);
  if (pins !== undefined) for (const source of pins) state.files.set(source.file, source);
  if (profile.literalSlots.length > 0) state.rootUsed = true;
  return true;
}

/** Revalidate after every asynchronous template walk, while the original pass is still active. */
export async function assertCurrentNodeManifestHandlerContext(
  context: NodeManifestHandlerContext | undefined,
): Promise<readonly { readonly file: string; readonly sha256: string }[]> {
  if (context === undefined) return Object.freeze([]);
  const state = current(context);
  await assertEvidence(state);
  current(context);
  const binding = state.input.owned.input.compilerRootBinding;
  state.metadata =
    binding !== undefined && state.rootUsed
      ? Object.freeze([nodeManifestCompilerRoot(binding.proof, binding.input).metadata])
      : Object.freeze([]);
  return state.metadata;
}
async function assertEvidence(state: State): Promise<void> {
  await assertCurrentNodeManifestHandlerDirectory(state.directory);
  ownedCurrent(state);
  for (const source of state.used.values()) {
    const actual = await checkedNodeManifestHandlerFile(source.file, source.source.sha256);
    ownedCurrent(state);
    state.files.set(actual.file, actual);
  }
  await assertCurrentNodeManifestHandlerFiles(state.files.values());
  await assertCurrentNodeManifestHandlerDirectory(state.directory);
  ownedCurrent(state);
  const binding = state.input.owned.input.compilerRootBinding;
  if (state.rootUsed) {
    if (binding === undefined) return refuse('missing used compiler root binding');
    await assertCurrentNodeManifestCompilerRoot(binding.proof, binding.input);
    ownedCurrent(state);
  }
}

interface MetadataBinding {
  readonly consumerOwner: Readonly<{ identity: symbol }>;
  readonly owned: NodeManifestHandlerOwnerBinding;
  readonly metadata: readonly { readonly file: string; readonly sha256: string }[] | undefined;
}
function metadataState(context: NodeManifestHandlerContext, binding: MetadataBinding): State {
  const state = CONTEXTS.get(context);
  if (
    state?.input.consumerOwner !== binding.consumerOwner ||
    state.input.owned !== binding.owned ||
    state.metadata === undefined ||
    state.metadata !== binding.metadata
  )
    return refuse('foreign metadata context binding');
  ownedCurrent(state);
  return state;
}
/** Assert only: the private metadata ledger must be minted inside the original active pass. */
export function assertNodeManifestHandlerMetadataBinding(
  context: NodeManifestHandlerContext,
  binding: MetadataBinding,
): void {
  checked(metadataState(context, binding));
}
/** Original private ownership and evidence remain required after the inner pass was revoked. */
export async function assertNodeManifestClosedHandlerContext(
  context: NodeManifestHandlerContext,
  binding: MetadataBinding,
): Promise<void> {
  const state = metadataState(context, binding);
  await assertEvidence(state);
  metadataState(context, binding);
}
