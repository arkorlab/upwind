import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { appEntrySource } from './app-entry.ts';
import { jsLiteral } from './codegen.ts';
import { AuditError } from './dependencies.ts';
import { ROUTE_EXPORTS, type ManifestProtectedKind } from './node-manifest-framework.ts';
import type {
  ManifestGraphInput,
  ManifestModuleGraph,
  ManifestGraphFile,
} from './node-manifest-graph.ts';
import {
  nodeManifestNormalization,
  type NodeManifestNormalization,
} from './node-manifest-normalization.ts';
import { sealedRoutes, type SealedRoute } from './node-manifest-routes.ts';
import type {
  NodeManifestTurbopackConsumerInput,
  NodeManifestTurbopackConsumerProof,
} from './node-manifest-turbopack-consumer-input.ts';

const MAX_SOURCE_BYTES = 134_217_728;
const SCOPE: unique symbol = Symbol('sealed SDK route terminal scope');
const TERMINAL: unique symbol = Symbol('exact generated SDK route terminal');
export interface NodeManifestSdkTerminalScope {
  readonly [SCOPE]: true;
}
export interface NodeManifestSdkTerminalProof {
  readonly [TERMINAL]: true;
}
interface Scope {
  readonly input: ManifestGraphInput;
  readonly graph: ManifestModuleGraph;
  readonly pointers: readonly unknown[];
  readonly fingerprint: string;
  readonly routes: ReadonlyMap<string, SealedRoute>;
  readonly metadata: readonly ManifestGraphFile[];
  readonly generated: string;
  readonly analysisEntry: string | undefined;
  readonly rootDir: string | undefined;
  readonly distDir: string;
}
interface Child {
  readonly id: string;
  readonly kind: ManifestProtectedKind;
}
interface Terminal {
  readonly scope: NodeManifestSdkTerminalScope;
  readonly parent: string;
  readonly child: Child;
  readonly source: ManifestGraphFile;
  readonly identity: ManifestGraphFile;
  readonly route: SealedRoute;
}
const SCOPES = new WeakMap<NodeManifestSdkTerminalScope, Scope>();
const TERMINALS = new WeakMap<NodeManifestSdkTerminalProof, Terminal>();
function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js client manifest ${reason}; refusing native publication`);
}
function digest(code: string | Uint8Array): string {
  return createHash('sha256').update(code).digest('hex');
}
function pointers(input: ManifestGraphInput, graph: ManifestModuleGraph): readonly unknown[] {
  return [
    input.entries,
    graph.sources,
    graph.imports,
    graph.importers,
    graph.roots,
    graph.retained,
    graph.rendered,
  ];
}
function fingerprint(input: ManifestGraphInput, graph: ManifestModuleGraph): string {
  return digest(
    JSON.stringify([
      input,
      [...graph.sources],
      [...(graph.imports ?? [])],
      [...graph.importers],
      [...(graph.roots ?? [])],
      [...graph.retained],
      [...(graph.rendered ?? [])],
    ]),
  );
}
function current(scope: NodeManifestSdkTerminalScope): Scope {
  const state = SCOPES.get(scope);
  if (
    state === undefined ||
    state.pointers.some((value, index) => pointers(state.input, state.graph)[index] !== value) ||
    state.fingerprint !== fingerprint(state.input, state.graph)
  )
    return refuse('stale or uncertified SDK terminal scope');
  return state;
}
async function checkedCode(source: ManifestGraphFile): Promise<string> {
  const { file, sha256 } = source;
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return refuse('consumer source bounds');
  const bytes = await readFile(file);
  if (bytes.length !== info.size || digest(bytes) !== sha256)
    return refuse('consumer source changed');
  return bytes.toString('utf8');
}
function generatedEntry(input: ManifestGraphInput): string {
  if (input.entries === undefined) return refuse('missing generated entry inputs');
  return [
    appEntrySource(input.entries, {
      external: true,
      runtimeDistDir: input.distDir,
      nodeRequestMeta: true,
    }),
    ...(input.instrumentation === undefined
      ? []
      : [`module.exports.instrumentation=()=>require(${jsLiteral(input.instrumentation)});`]),
  ].join('\n');
}

/** Seal real filesystem paths and compiler route metadata once; callers cannot supply approvals. */
export async function prepareNodeManifestSdkTerminalScope(
  input: ManifestGraphInput,
  graph: ManifestModuleGraph,
): Promise<{
  readonly scope: NodeManifestSdkTerminalScope;
  readonly normalization: NodeManifestNormalization;
  readonly sealed: Awaited<ReturnType<typeof sealedRoutes>>;
}> {
  const originalPointers = pointers(input, graph);
  const originalFingerprint = fingerprint(input, graph);
  const captured = Object.freeze({
    ...input,
    entries:
      input.entries === undefined
        ? undefined
        : Object.freeze(input.entries.map((entry) => Object.freeze({ ...entry }))),
  });
  const normalization = await nodeManifestNormalization(captured);
  const sealed = await sealedRoutes(captured, normalization);
  const actualPointers = pointers(input, graph);
  if (
    originalPointers.some((value, index) => actualPointers[index] !== value) ||
    originalFingerprint !== fingerprint(input, graph)
  )
    return refuse('changed SDK terminal inputs while sealing');
  const scope = Object.freeze<NodeManifestSdkTerminalScope>({ [SCOPE]: true });
  SCOPES.set(scope, {
    input,
    graph,
    pointers: originalPointers,
    fingerprint: originalFingerprint,
    routes: new Map(
      [...sealed.routes].map(([file, route]) => [file, Object.freeze(structuredClone(route))]),
    ),
    metadata: Object.freeze(sealed.files.map((source) => Object.freeze({ ...source }))),
    generated: generatedEntry(captured),
    analysisEntry: captured.analysisEntry,
    rootDir: captured.rootDir,
    distDir: path.resolve(captured.distDir),
  });
  return { scope, normalization, sealed };
}
async function checkedTerminal(scope: NodeManifestSdkTerminalScope, parent: string, child: Child) {
  const state = current(scope);
  const source = state.graph.sources.get(parent);
  const childSource = state.graph.sources.get(child.id);
  const identity =
    childSource === undefined
      ? undefined
      : Object.freeze({ file: childSource.file, sha256: childSource.sha256 });
  if (
    source === undefined ||
    childSource === undefined ||
    child.kind !== ROUTE_EXPORTS ||
    state.graph.roots?.has(parent) !== true ||
    !state.graph.retained.has(parent)
  )
    return refuse('unproved SDK entry terminal');
  const edges = state.graph.imports?.get(parent)?.filter((edge) => edge.target === child.id);
  if (
    edges === undefined ||
    edges.length === 0 ||
    !state.graph.importers.get(child.id)?.includes(parent)
  )
    return refuse('missing resolved SDK terminal edge');
  const code = await checkedCode(source);
  if (parent !== state.analysisEntry || code !== state.generated)
    return refuse('unproved SDK entry terminal');
  if (identity === undefined) return refuse('missing SDK route identity');
  const route = state.routes.get(identity.file);
  if (route === undefined) return refuse('unsealed SDK route terminal');
  await checkedCode(identity);
  for (const metadata of state.metadata) await checkedCode(metadata);
  current(scope);
  return { source: childSource, identity, route };
}

/** The same original SDK guard, run against actual source bytes and actual graph edges. */
export async function certifyNodeManifestSdkTerminal(
  scope: NodeManifestSdkTerminalScope,
  parent: string,
  child: Child,
): Promise<NodeManifestSdkTerminalProof | undefined> {
  const state = SCOPES.get(scope);
  if (state === undefined) return refuse('uncertified SDK terminal scope');
  if (parent !== state.analysisEntry) return undefined;
  const checked = await checkedTerminal(scope, parent, child);
  const proof = Object.freeze<NodeManifestSdkTerminalProof>({ [TERMINAL]: true });
  TERMINALS.set(proof, { scope, parent, child: Object.freeze({ ...child }), ...checked });
  return proof;
}

/** A scope/route subset, copied token or changed original graph/root cannot finish a pending stage. */
export async function assertNodeManifestSdkTerminal(
  proof: NodeManifestSdkTerminalProof,
  input: {
    readonly scope: NodeManifestSdkTerminalScope;
    readonly consumer: Pick<NodeManifestTurbopackConsumerInput, 'rootDir' | 'distDir'>;
    readonly terminal: NodeManifestTurbopackConsumerProof['terminals'][number];
    readonly sha256: string;
  },
): Promise<void> {
  const stored = TERMINALS.get(proof);
  if (
    stored?.scope !== input.scope ||
    stored.child.id !== input.terminal.id ||
    stored.identity.file !== input.terminal.file ||
    stored.identity.sha256 !== input.sha256 ||
    stored.route.page !== input.terminal.page ||
    stored.route.pathname !== input.terminal.pathname
  )
    return refuse('foreign or substituted SDK terminal certificate');
  const state = current(input.scope);
  if (
    state.rootDir !== input.consumer.rootDir ||
    state.distDir !== path.resolve(input.consumer.distDir)
  )
    return refuse('SDK terminal context mismatch');
  const checked = await checkedTerminal(input.scope, stored.parent, stored.child);
  if (
    checked.source !== stored.source ||
    checked.identity.file !== stored.identity.file ||
    checked.identity.sha256 !== stored.identity.sha256 ||
    checked.route !== stored.route
  )
    return refuse('changed SDK terminal ownership');
}
