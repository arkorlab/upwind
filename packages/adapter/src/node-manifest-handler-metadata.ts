import { createHash } from 'node:crypto';

import { AuditError } from './dependencies.ts';
import { assertNodeManifestBoundStageCommitted } from './node-manifest-bound-batch.ts';
import {
  assertNodeManifestClosedHandlerContext,
  assertNodeManifestHandlerMetadataBinding,
  type NodeManifestHandlerContext,
  type NodeManifestHandlerOwnerBinding,
} from './node-manifest-handler-context.ts';
import {
  assertNodeManifestPassBinding,
  assertNodeManifestPassRows,
  assertNodeManifestPassSources,
  type NodeManifestRegistrationPass,
} from './node-manifest-registration-pass.ts';
import { assertNodeManifestRegistrationRows } from './node-manifest-registration-views.ts';
import { nodeManifestRuntimeCohortSources } from './node-manifest-runtime-cohort.ts';
import {
  assertNodeManifestPendingSdkContext,
  assertNodeManifestSdkTerminal,
  type NodeManifestSdkTerminalProof,
} from './node-manifest-sdk-terminal.ts';
import type { NodeManifestTurbopackConsumerProof } from './node-manifest-turbopack-consumer-input.ts';
import { assertNodeManifestTurbopackConsumerOwner } from './node-manifest-turbopack-consumers.ts';
import type { NodeManifestTurbopackGraphFactory } from './node-manifest-turbopack-graph.ts';

interface Input {
  readonly consumerOwner: Readonly<{ identity: symbol }>;
  readonly owned: NodeManifestHandlerOwnerBinding;
  readonly pass: NodeManifestRegistrationPass;
  readonly context: NodeManifestHandlerContext | undefined;
  readonly proof: NodeManifestTurbopackConsumerProof;
}
interface Stage {
  readonly input: Input;
  readonly pointers: readonly unknown[];
  readonly fingerprint: string;
  readonly rows: readonly NodeManifestTurbopackGraphFactory[];
  readonly terminals: NodeManifestTurbopackConsumerProof['terminals'];
  readonly files: ReadonlyMap<string, string>;
  readonly metadata: NonNullable<NodeManifestTurbopackConsumerProof['helperMetadataFiles']>;
  readonly scope: NodeManifestHandlerOwnerBinding['input']['sdkTerminalScope'];
  readonly batch: NodeManifestHandlerOwnerBinding['input']['boundBatch'];
  readonly boundStage: NodeManifestTurbopackConsumerProof['boundStage'];
  readonly context: { readonly rootDir: string; readonly distDir: string };
  pending: boolean;
}
const STAGED = new WeakMap<NodeManifestTurbopackConsumerProof, Stage>();
function refuse(reason: string): never {
  throw new AuditError(`Unproved Pages handler metadata ${reason}; refusing metadata publication`);
}
function pointers(input: Input): readonly unknown[] {
  const { owned, proof } = input;
  const root = owned.input.compilerRootBinding;
  return [
    input.consumerOwner,
    owned,
    input.pass,
    input.context,
    proof,
    proof.helperMetadataFiles,
    proof.terminals,
    proof.files,
    proof.compilerSources,
    proof.boundStage,
    proof.pagesConjunctionStage,
    owned.input.sources,
    owned.input.boundBatch,
    owned.input.sdkTerminalScope,
    root,
    root?.proof,
    root?.input,
    ...owned.input.sources.flatMap((source) => [source, source.source, source.imports]),
    ...owned.graphs.flatMap((graph) => [graph, graph.factories, graph.registrationIndex]),
    ...owned.factories.values(),
  ];
}
function fingerprint(input: Input): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.proof,
        input.owned.input,
        input.owned.graphs,
        [...input.owned.factories],
        input.owned.cohort,
      ]),
    )
    .digest('hex');
}
function binding(stage: Stage) {
  return {
    consumerOwner: stage.input.consumerOwner,
    owned: stage.input.owned,
    metadata: stage.metadata,
  };
}
function current(proof: NodeManifestTurbopackConsumerProof): Stage {
  const stage = STAGED.get(proof);
  if (stage === undefined || !stage.pending || stage.input.proof !== proof)
    return refuse('copied, consumed or unstaged proof');
  assertNodeManifestTurbopackConsumerOwner(stage.input.consumerOwner, stage.input.owned);
  const actual = pointers(stage.input);
  if (
    actual.length !== stage.pointers.length ||
    actual.some((value, index) => value !== stage.pointers[index]) ||
    fingerprint(stage.input) !== stage.fingerprint
  )
    return refuse('changed original proof or metadata field');
  assertNodeManifestRegistrationRows(stage.input.owned.registrations, stage.rows);
  if (stage.input.owned.cohort !== undefined)
    nodeManifestRuntimeCohortSources(stage.input.owned.cohort, stage.input.owned.input.sources);
  return stage;
}

/** Sole caller is the real private semantic walk, after Pages staging, inside its original pass. */
export function stageNodeManifestHandlerMetadata(input: Input): NodeManifestTurbopackConsumerProof {
  assertNodeManifestTurbopackConsumerOwner(input.consumerOwner, input.owned);
  const rows = Object.freeze([...input.owned.factories.values()]);
  assertNodeManifestPassBinding(input.pass, input.owned.registrations);
  assertNodeManifestPassSources(input.pass, input.owned.input.sources);
  assertNodeManifestPassRows(input.pass, rows);
  if (STAGED.has(input.proof)) refuse('proof already staged');
  const metadata = input.proof.helperMetadataFiles ?? Object.freeze([]);
  if (input.context === undefined) {
    if (metadata.length > 0) refuse('metadata without its private qualification context');
  } else
    assertNodeManifestHandlerMetadataBinding(input.context, {
      consumerOwner: input.consumerOwner,
      owned: input.owned,
      metadata,
    });
  if (!Object.isFrozen(metadata)) refuse('mutable metadata inventory');
  const captured = Object.freeze({ ...input });
  STAGED.set(input.proof, {
    input: captured,
    pointers: pointers(captured),
    fingerprint: fingerprint(captured),
    rows,
    terminals: Object.freeze(
      input.proof.terminals.map((terminal) => Object.freeze(structuredClone(terminal))),
    ),
    files: new Map(input.proof.files.map((source) => [source.file, source.sha256])),
    metadata,
    scope: input.owned.input.sdkTerminalScope,
    batch: input.owned.input.boundBatch,
    boundStage: input.proof.boundStage,
    context: Object.freeze({
      rootDir: input.owned.input.rootDir,
      distDir: input.owned.input.distDir,
    }),
    pending: true,
  });
  return input.proof;
}

/** Publish the private original JSON list only after every real SDK terminal and bound commit. */
export async function commitNodeManifestHandlerMetadata(
  proof: NodeManifestTurbopackConsumerProof,
  terminals: readonly NodeManifestSdkTerminalProof[],
): Promise<Stage['metadata']> {
  const stage = current(proof);
  if (
    stage.scope === undefined ||
    stage.batch === undefined ||
    stage.boundStage === undefined ||
    terminals.length !== stage.terminals.length ||
    new Set(terminals).size !== terminals.length
  )
    return refuse('incomplete outer closure');
  assertNodeManifestBoundStageCommitted(stage.batch, stage.boundStage);
  assertNodeManifestPendingSdkContext(stage.scope, stage.input.owned.input);
  for (const [index, terminal] of stage.terminals.entries()) {
    const certificate = terminals[index];
    const sha256 = stage.files.get(terminal.file);
    if (certificate === undefined || sha256 === undefined)
      return refuse('missing original terminal source');
    await assertNodeManifestSdkTerminal(certificate, {
      scope: stage.scope,
      terminal,
      sha256,
      consumer: stage.context,
    });
    current(proof);
  }
  if (stage.input.context !== undefined)
    await assertNodeManifestClosedHandlerContext(stage.input.context, binding(stage));
  current(proof);
  assertNodeManifestBoundStageCommitted(stage.batch, stage.boundStage);
  stage.pending = false;
  return stage.metadata;
}
