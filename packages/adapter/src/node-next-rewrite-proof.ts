import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type { OutputChunk } from 'rolldown';

import { jsLiteral } from './codegen.ts';
import { AuditError } from './dependencies.ts';
import type { BuildFunctionInput } from './function.ts';
import {
  nodeCachePolicyConfig,
  nodeCachePolicyExpectedEdits,
  nodeCachePolicyPatch,
  nodeCachePolicyRemovedRanges,
} from './node-cache-policy.ts';
import { reviewedFrameworkSource } from './node-manifest-framework.ts';
import type { ManifestModuleGraph, ManifestRouteSource } from './node-manifest-graph.ts';
import type { NodeManifestNormalization } from './node-manifest-normalization.ts';
import type { NodeManifestProof } from './node-manifest-proof.ts';
import {
  checkedNodeRouteRewriteSources,
  type NodeRouteRewriteApproval,
} from './node-route-rewrite-approval.ts';
import {
  nativeTurbopackSelectorPatch,
  nativeTurbopackSelectorTargets,
  nodeNextPolicySourcePins,
} from './node-turbopack-selector.ts';
import { fetchCacheWaitUntilPatch } from './patches/fetch-cache-wait-until.ts';
import { instrumentationPatch } from './patches/instrumentation.ts';
import { resourceCacheBridgePatch } from './patches/resource-cache-bridge.ts';
import type { AppliedPatch } from './patches/rolldown.ts';
import { turbopackRuntimePatch } from './patches/turbopack-runtime.ts';

const LOADER = 'dist/server/lib/router-utils/instrumentation-globals.external.js';
const LOADER_SHA = '2afb1d2dea656c51d29466c5c92770c1d012fcee49e28cf10dc1510c881f6d46';
const MAX_SOURCE_BYTES = 134_217_728;
const PROOF: unique symbol = Symbol('Node Next.js rewrite proof');
export interface NodeNextRewriteProof {
  readonly [PROOF]: true;
}
export type NodeNextRewriteInput = Pick<BuildFunctionInput, 'projectDir' | 'patch' | 'entries'>;
interface Source {
  readonly file: string;
  readonly sha256: string;
}
interface Record extends Source {
  readonly patch: string;
  readonly analysisSha256: string;
}
interface StoredProof {
  readonly projectDir: string;
  readonly canonicalProjectDir: string;
  readonly declaredDistDir: string;
  readonly distDir: string;
  readonly declaredHook: string | undefined;
  readonly ownHook: string | undefined;
  readonly hook: Source | undefined;
  readonly hookSources: ReadonlyMap<string, string>;
  readonly records: ReadonlyMap<string, Record>;
  readonly metadata: readonly Source[];
  readonly archive: Map<string, string>;
  bundleSha256: string | undefined;
}
const PROOFS = new WeakMap<NodeNextRewriteProof, StoredProof>();
const SHARED_PATCHES = [fetchCacheWaitUntilPatch, resourceCacheBridgePatch];
const NATIVE_POLICIES = [nodeCachePolicyPatch, nativeTurbopackSelectorPatch];
const POLICY_PATCHES = [...NATIVE_POLICIES, instrumentationPatch];

function refuse(reason: string): never {
  throw new AuditError(`Unproved Node Next.js rewrite ${reason}; refusing native publication`);
}
function digest(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function stored(proof: NodeNextRewriteProof | undefined): StoredProof {
  const value = proof === undefined ? undefined : PROOFS.get(proof);
  if (value === undefined) return refuse('certificate');
  return value;
}
async function boundedSource(file: string): Promise<Source> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES) refuse('source bounds');
  const bytes = await readFile(file);
  if (bytes.length !== info.size) refuse('source changed');
  return Object.freeze({ file, sha256: digest(bytes) });
}
async function ownHook(distDir: string): Promise<string | undefined> {
  const file = path.join(distDir, 'server', 'instrumentation.js');
  try {
    const resolved = await realpath(file);
    if (resolved !== file) refuse('project hook path');
    await boundedSource(resolved);
    return resolved;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
function checkedRoutes(
  graph: ManifestModuleGraph,
  routes: readonly ManifestRouteSource[],
): ReadonlyMap<string, ManifestRouteSource> {
  const actual = new Map([...graph.sources].map(([id, value]) => [value.file, { id, ...value }]));
  const checked = new Map<string, ManifestRouteSource>();
  for (const route of routes) {
    const original = actual.get(route.file);
    if (
      original?.sha256 !== route.sha256 ||
      !graph.retained.has(original.id) ||
      path.resolve(route.root, route.relative) !== route.file ||
      reviewedFrameworkSource(route.relative) !== route.sha256
    )
      refuse('completed route source identity');
    checked.set(route.file, Object.freeze({ ...route }));
  }
  return checked;
}
function instrumentationCallerRoot(
  id: string,
  graph: ManifestModuleGraph,
  routes: ReadonlyMap<string, ManifestRouteSource>,
): string {
  const loader = graph.sources.get(id);
  if (loader?.sha256 !== LOADER_SHA) return refuse('loader source');
  const parents = graph.importers.get(id);
  if (parents === undefined || parents.length === 0) refuse('loader caller inventory');
  let root: string | undefined;
  for (const parent of parents) {
    const caller = graph.sources.get(parent);
    const approved = caller === undefined ? undefined : routes.get(caller.file);
    if (
      approved === undefined ||
      approved.sha256 !== caller?.sha256 ||
      (approved.relative !== 'dist/server/route-modules/route-module.js' &&
        !nodeCachePolicyPatch.target.test(approved.relative)) ||
      path.join(approved.root, LOADER) !== loader.file ||
      graph.imports?.get(parent)?.some((edge) => edge.target === id) !== true ||
      (root !== undefined && root !== approved.root)
    )
      refuse('loader caller or root');
    root = approved.root;
  }
  return root ?? refuse('loader root');
}
function hookClosure(graph: ManifestModuleGraph, hook: Source): ReadonlyMap<string, string> {
  const roots = [...graph.sources].filter(([, value]) => value.file === hook.file);
  if (roots.length !== 1 || roots[0]?.[1].sha256 !== hook.sha256) refuse('selected hook source');
  const pending = roots.map(([id]) => id);
  const visited = new Set<string>();
  const sources = new Map<string, string>();
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (visited.has(id)) continue;
    visited.add(id);
    const original = graph.sources.get(id);
    if (original === undefined) continue;
    sources.set(original.file, original.sha256);
    const imports = graph.imports?.get(id);
    if (imports === undefined) refuse('hook dependency inventory');
    for (const edge of imports) pending.push(edge.target);
  }
  return sources;
}

function recognizedRewrite(
  applied: AppliedPatch,
  original: Source,
  graph: ManifestModuleGraph,
  routes: ReadonlyMap<string, ManifestRouteSource>,
): boolean {
  if (NATIVE_POLICIES.some((policy) => policy.name === applied.patch)) {
    const role = applied.patch === nodeCachePolicyPatch.name ? 'cache' : 'selector';
    if (routes.get(original.file)?.sha256 !== original.sha256)
      refuse(`${role} policy caller proof`);
    if (applied.result.edits === 0) refuse('native policy has no checked edits');
    if (
      applied.patch === nativeTurbopackSelectorPatch.name &&
      !nativeTurbopackSelectorTargets(applied, graph, routes)
    )
      refuse('selector target closure');
    return true;
  }
  if (applied.patch !== instrumentationPatch.name) return false;
  instrumentationCallerRoot(applied.file, graph, routes);
  return true;
}

function rewriteRecords(
  graph: ManifestModuleGraph,
  patches: readonly AppliedPatch[],
  routes: ReadonlyMap<string, ManifestRouteSource>,
  normalization: NodeManifestNormalization | undefined,
): ReadonlyMap<string, Record> {
  const records = new Map<string, Record>();
  for (const applied of patches) {
    if (!graph.retained.has(applied.file)) continue;
    const original = graph.sources.get(applied.file);
    if (original === undefined) refuse('missing original source');
    if (!recognizedRewrite(applied, original, graph, routes)) continue;
    if (normalization === undefined) refuse('missing Node entry normalization');
    records.set(
      original.file,
      Object.freeze({
        ...original,
        patch: applied.patch,
        analysisSha256: digest(applied.result.contents),
      }),
    );
  }
  return records;
}

/** Mint only after the completed constructor/caller/SDK-root and bound proof has returned. */
export async function certifyNodeNextRewrites(
  input: NodeNextRewriteInput,
  graph: ManifestModuleGraph,
  patches: readonly AppliedPatch[],
  manifest: {
    readonly normalization?: NodeManifestNormalization | undefined;
    readonly routeRewriteApprovals?: readonly NodeRouteRewriteApproval[] | undefined;
  },
): Promise<NodeNextRewriteProof> {
  const distDir = await realpath(input.patch.distDir);
  const routes = checkedRoutes(
    graph,
    checkedNodeRouteRewriteSources({
      graph,
      approvals: manifest.routeRewriteApprovals,
      normalization: manifest.normalization,
      context: {
        distDir: input.patch.distDir,
        instrumentation: input.patch.instrumentation,
        entries: input.entries,
      },
    }),
  );
  const records = rewriteRecords(graph, patches, routes, manifest.normalization);
  const declaredHook = input.patch.instrumentation;
  const hook =
    declaredHook === undefined ? undefined : await boundedSource(await realpath(declaredHook));
  const projectHook = await ownHook(distDir);
  if (hook === undefined && projectHook !== undefined) refuse('unselected project hook');
  let cache = false;
  for (const record of records.values()) {
    if (record.patch === nodeCachePolicyPatch.name) cache = true;
  }
  const metadata = cache ? [await nodeCachePolicyConfig(distDir)] : [];
  const proof = Object.freeze<NodeNextRewriteProof>({ [PROOF]: true });
  PROOFS.set(proof, {
    projectDir: path.resolve(input.projectDir),
    canonicalProjectDir: await realpath(input.projectDir),
    declaredDistDir: path.resolve(input.patch.distDir),
    distDir,
    declaredHook,
    ownHook: projectHook,
    hook,
    hookSources: hook === undefined ? new Map() : hookClosure(graph, hook),
    records,
    metadata: Object.freeze(metadata),
    archive: new Map(),
    bundleSha256: undefined,
  });
  return proof;
}

export function nodeNextRewriteMetadata(proof: NodeNextRewriteProof): readonly Source[] {
  const state = stored(proof);
  return nodeNextPolicySourcePins([state.metadata, state.records.values()]);
}

export function nodeNextRewriteNormalization(
  proof: NodeNextRewriteProof,
  normalization: NodeManifestNormalization | undefined,
): NodeManifestNormalization | undefined {
  if (normalization === undefined) return undefined;
  return Object.freeze({
    ...normalization,
    metadataFiles: Object.freeze([
      ...(normalization.metadataFiles ?? []),
      ...nodeNextRewriteMetadata(proof),
    ]),
  });
}

function assertContext(input: NodeNextRewriteInput, state: StoredProof): void {
  if (
    path.resolve(input.projectDir) !== state.projectDir ||
    path.resolve(input.patch.distDir) !== state.declaredDistDir ||
    input.patch.instrumentation !== state.declaredHook ||
    input.patch.cacheHandlers !== undefined
  )
    refuse('selected context changed');
}

function patchFor(file: string) {
  return POLICY_PATCHES.find((patch) => patch.target.test(file));
}

/** Preview only completed native policies; do not expose instrumentation or mutate the ledger. */
export function previewCertifiedNodeNextPolicy(
  proof: NodeNextRewriteProof | undefined,
  input: NodeNextRewriteInput,
  original: { readonly file: string; readonly code: string },
): string | undefined {
  if (proof === undefined) return undefined;
  const state = stored(proof);
  assertContext(input, state);
  const { file, code } = original;
  const record = state.records.get(file);
  const patch = NATIVE_POLICIES.find((policy) => policy.name === record?.patch);
  if (record === undefined || patch === undefined) return undefined;
  if (!patch.target.test(file) || record.sha256 !== digest(code))
    refuse('inspection source lacks a matching native policy certificate');
  const result = patch.apply(code, file, input.patch);
  if (
    result.edits === 0 ||
    (patch === nodeCachePolicyPatch && result.edits !== nodeCachePolicyExpectedEdits(code)) ||
    digest(result.contents) !== record.analysisSha256
  )
    refuse('inspection analysis mapping changed');
  return result.contents;
}

/** A private certificate-backed inspection preview; no physical archive bookkeeping is changed. */
export function previewCertifiedNodeCachePolicy(
  proof: NodeNextRewriteProof | undefined,
  input: NodeNextRewriteInput,
  original: { readonly file: string; readonly code: string },
):
  | {
      readonly analysis: string;
      readonly removed: readonly { readonly start: number; readonly end: number }[];
    }
  | undefined {
  if (proof === undefined) return undefined;
  const state = stored(proof);
  assertContext(input, state);
  if (state.records.get(original.file)?.patch !== nodeCachePolicyPatch.name) return undefined;
  const analysis = previewCertifiedNodeNextPolicy(proof, input, original);
  if (analysis === undefined) refuse('inspection analysis mapping changed');
  return Object.freeze({
    analysis,
    removed: nodeCachePolicyRemovedRanges(original.code),
  });
}

/** Every physical policy rewrite needs its own completed source/caller certificate. */
export function rewriteCertifiedNodeNextFile(
  proof: NodeNextRewriteProof | undefined,
  input: NodeNextRewriteInput,
  original: { readonly file: string; readonly name: string; readonly code: string },
): string | undefined {
  const { file, name, code } = original;
  const patch = patchFor(file);
  if (patch === undefined) return undefined;
  const state = stored(proof);
  assertContext(input, state);
  const record = state.records.get(file);
  if (patch === nativeTurbopackSelectorPatch && record === undefined) return undefined;
  if (record?.patch !== patch.name || record.sha256 !== digest(code))
    refuse('physical source lacks a matching certificate');
  const analysis = patch.apply(code, file, input.patch).contents;
  if (digest(analysis) !== record.analysisSha256) refuse('analysis mapping changed');
  let contents = patch.apply(code, file, {
    ...input.patch,
    instrumentation: state.hook === undefined ? undefined : '/bundle/upwind/instrumentation.cjs',
  }).contents;
  for (const shared of SHARED_PATCHES) {
    if (shared.target.test(file) && (shared.marker === undefined || shared.marker(contents)))
      contents = shared.apply(contents, file, input.patch).contents;
  }
  state.archive.set(name, digest(contents));
  return contents;
}

/** Bind the generated host bundle to exactly the hook graph inspected by Node analysis. */
export function sealNodeInstrumentationBundle(
  proof: NodeNextRewriteProof | undefined,
  input: NodeNextRewriteInput,
  physical: {
    readonly instrumentation: string | undefined;
    readonly nameOf: (file: string) => string;
  },
  bundle: { readonly originals: ReadonlyMap<string, string>; readonly bytes: Uint8Array },
): void {
  const { originals, bytes } = bundle;
  const state = stored(proof);
  assertContext(input, state);
  if (state.hook === undefined || physical.instrumentation !== state.ownHook)
    refuse('hook bundle target');
  for (const [file, sha256] of originals) {
    if (state.hookSources.get(file) !== sha256) refuse('hook bundle source differs from analysis');
  }
  if (state.hook.file !== state.ownHook && originals.get(state.hook.file) !== state.hook.sha256)
    refuse('hook bundle entry');
  if (
    state.hook.file === state.ownHook &&
    digest(bytes) !== digest(nodeProjectInstrumentationSource(physical.nameOf(state.hook.file)))
  )
    refuse('project hook wrapper mapping');
  state.bundleSha256 = digest(bytes);
}

export function nodeProjectInstrumentationSource(name: string): string {
  const target = jsLiteral(`/bundle/${name}`);
  return `globalThis.AsyncLocalStorage??=require('node:async_hooks').AsyncLocalStorage;module.exports=require(${target});`;
}

async function assertHookArchive(
  state: StoredProof,
  files: ReadonlyMap<string, { readonly bytes: Uint8Array }>,
): Promise<void> {
  if (state.hook === undefined) {
    if (files.has('upwind/instrumentation.cjs')) refuse('unexpected hook bundle');
    return;
  }
  if (
    state.declaredHook === undefined ||
    (await realpath(state.declaredHook)) !== state.hook.file ||
    (await boundedSource(state.hook.file)).sha256 !== state.hook.sha256
  )
    refuse('selected hook changed');
  const bytes = files.get('upwind/instrumentation.cjs')?.bytes;
  if (
    bytes === undefined ||
    state.bundleSha256 === undefined ||
    digest(bytes) !== state.bundleSha256
  )
    refuse('generated hook bundle changed');
}

/** Final check occurs after every archive file has been added, immediately before archiving. */
export async function assertNodeNextRewriteArchive(
  proof: NodeNextRewriteProof | undefined,
  input: NodeNextRewriteInput,
  files: ReadonlyMap<string, { readonly bytes: Uint8Array }>,
  nameOf: (file: string) => string,
): Promise<void> {
  if (proof === undefined) return;
  const state = stored(proof);
  assertContext(input, state);
  if (
    (await realpath(input.patch.distDir)) !== state.distDir ||
    (await realpath(input.projectDir)) !== state.canonicalProjectDir ||
    (await ownHook(state.distDir)) !== state.ownHook
  )
    refuse('dist or project hook changed');
  await assertHookArchive(state, files);
  for (const record of state.records.values()) {
    if (!state.archive.has(nameOf(record.file)))
      refuse('certified physical source was not rewritten');
  }
  if (
    state.hook !== undefined &&
    state.hook.file === state.ownHook &&
    state.bundleSha256 !== digest(nodeProjectInstrumentationSource(nameOf(state.hook.file)))
  )
    refuse('project hook archive mapping changed');
  for (const [name, sha256] of state.archive) {
    const bytes = files.get(name)?.bytes;
    if (bytes === undefined || digest(bytes) !== sha256) refuse('archived policy bytes changed');
  }
  for (const metadata of state.metadata) {
    const bytes = files.get(nameOf(metadata.file))?.bytes;
    if (
      bytes === undefined ||
      digest(bytes) !== metadata.sha256 ||
      (await boundedSource(metadata.file)).sha256 !== metadata.sha256
    )
      refuse('recorded configuration changed');
  }
}

/** Exact compiler-source authorization remains independent of the policy certificates above. */
export function approvedNodeCompilerModules(
  modules: OutputChunk['modules'],
  sources: ReadonlyMap<string, Source>,
  manifests: NodeManifestProof,
): ReadonlySet<string> {
  const retained = new Map<string, Set<string>>();
  const code = new Map(manifests.codeSources.map((source) => [source.file, source.sha256]));
  const approved = new Map(
    manifests.approvedCompilerSources.map((source) => [source.file, source.sha256]),
  );
  const result = new Set<string>();
  for (const [id, module] of Object.entries(modules)) {
    if (module.code === null) continue;
    const original = sources.get(id);
    if (original === undefined) continue;
    const hashes = retained.get(original.file) ?? new Set<string>();
    hashes.add(original.sha256);
    retained.set(original.file, hashes);
    if (approved.get(original.file) === original.sha256) result.add(id);
  }
  // Deferred executable targets must have passed the ordinary original-closure audit too.
  // Generated manifest data has a separate inert-data proof.
  for (const source of manifests.codeSources) {
    if (retained.get(source.file)?.has(source.sha256) !== true)
      throw new AuditError('Reviewed Next.js code was not retained by the original Node graph');
  }
  for (const source of manifests.approvedCompilerSources) {
    if (code.get(source.file) !== source.sha256)
      throw new AuditError('Reviewed compiler runtime lacks its original code-source proof');
  }
  return result;
}

export function assertCertifiedNodeRuntimePatches(
  modules: OutputChunk['modules'],
  patches: readonly AppliedPatch[],
  compilerModules: ReadonlySet<string>,
  identityOf: (file: string) => string,
): void {
  for (const applied of patches) {
    const module = modules[applied.file];
    if (
      module === undefined ||
      applied.patch !== turbopackRuntimePatch.name ||
      module.code === null
    )
      continue;
    if (!compilerModules.has(applied.file)) {
      const identity = identityOf(applied.file);
      throw new AuditError(
        `Original Node graph has an uncertified Turbopack runtime rewrite in ${identity}; refusing native publication`,
      );
    }
  }
}
