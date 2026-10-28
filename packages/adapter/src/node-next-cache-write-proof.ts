import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import type { Node } from './lexical-scope.ts';
import type { NodeJwtCompilerInput } from './node-jwt-compiler-proof.ts';
import type { ManifestGraphFile } from './node-manifest-graph.ts';
import {
  assertCurrentNodeManifestHandlerFiles,
  checkedNodeManifestHandlerFile,
  type NodeManifestHandlerFile,
} from './node-manifest-handler-sources.ts';
import {
  assertNodeManifestIdentity,
  captureNodeManifestIdentity,
  type NodeManifestIdentitySnapshot,
} from './node-manifest-identity-snapshot.ts';
import { nodeNextCacheWriteData } from './node-next-cache-write-data.ts';
import { previewCertifiedNodeCachePolicy } from './node-next-rewrite-proof.ts';
import { assertOriginalNodeModesGraph } from './node-original-load-mode.ts';
import { checkedNodeRouteRewriteSources } from './node-route-rewrite-approval.ts';

const PROOF = Symbol('fixed Next cache state write');
const SUFFIX = '/dist/compiled/next-server/pages-turbo.runtime.prod.js';
const SOURCE_SHA = '6a6fb036d30a72fcd4cb10b4ffc13318f5b0df6a205fd3fa1ce97cda1717d9c1';
const PACKAGE_SHA = 'b67bad7944d603b27dd2d2719b57203fd3b3e5c147b2efa6dea5ceb135274caf';
const MAX_BYTES = 4_194_304;
export interface NodeNextCacheWriteProof {
  readonly [PROOF]: true;
}
interface State {
  readonly input: NodeJwtCompilerInput;
  readonly snapshot: NodeManifestIdentitySnapshot;
  readonly sources: NodeManifestHandlerFile[];
  readonly code: Map<string, string>;
  readonly roots: Set<string>;
}
const proofs = new WeakMap<NodeNextCacheWriteProof, State>();
function refuse(reason: string): never {
  throw new AuditError(`Unproved fixed Next cache state write: ${reason}`);
}
function stored(proof: NodeNextCacheWriteProof): State {
  return proofs.get(proof) ?? refuse('copied or missing proof');
}
function routes(input: NodeJwtCompilerInput) {
  assertOriginalNodeModesGraph(input.originalModes, input.graph);
  return checkedNodeRouteRewriteSources({
    graph: input.graph,
    context: input.context,
    normalization: input.manifests.normalization,
    approvals: input.manifests.routeRewriteApprovals,
  });
}
function current(state: State): void {
  assertNodeManifestIdentity(state.snapshot, [state.input]);
  const approved = routes(state.input);
  for (const root of state.roots)
    if (approved.every((route) => route.root !== root)) refuse('changed SDK route root');
}
async function source(state: State, file: string, sha256: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_BYTES || (await realpath(file)) !== file)
    refuse('noncanonical bounded source');
  const bytes = await readFile(file);
  if (bytes.length !== info.size || createHash('sha256').update(bytes).digest('hex') !== sha256)
    refuse('fixed source identity');
  state.sources.push(await checkedNodeManifestHandlerFile(file, sha256));
  return bytes.toString('utf8');
}
async function candidate(state: State, id: string, own: ManifestGraphFile): Promise<void> {
  const input = state.input;
  const root = own.file.slice(0, -SUFFIX.length);
  if (
    path.basename(root) !== 'next' ||
    path.basename(path.dirname(root)) !== 'node_modules' ||
    routes(input).every((route) => route.root !== root)
  )
    refuse('canonical completed SDK route root');
  state.roots.add(root);
  await source(state, path.join(root, 'package.json'), PACKAGE_SHA);
  const raw = await source(state, own.file, SOURCE_SHA);
  if (
    input.rewriteInput === undefined ||
    previewCertifiedNodeCachePolicy(input.rewrites, input.rewriteInput, {
      file: own.file,
      code: raw,
    }) === undefined
  )
    refuse('missing exact SDK cache policy certificate');
  const rendered = input.graph.rendered?.get(id);
  if (
    rendered === undefined ||
    nodeNextCacheWriteData(parseAst(raw, { sourceType: 'commonjs' })) === undefined ||
    nodeNextCacheWriteData(parseAst(rendered)) === undefined
  )
    refuse('fixed original and rendered metadata operation');
  state.code.set(id, rendered);
}

/** Only the pinned framework operation inside a completed SDK route and rewrite closure. */
export async function qualifyNodeNextCacheWrites(
  input: NodeJwtCompilerInput,
): Promise<NodeNextCacheWriteProof | undefined> {
  const rows = [...input.graph.sources].filter(
    ([id, own]) =>
      input.graph.retained.has(id) && own.file.split(path.sep).join('/').endsWith(SUFFIX),
  );
  if (rows.length === 0) return undefined;
  if (rows.some(([, own]) => own.sha256 !== SOURCE_SHA)) refuse('fixed source identity');
  const state: State = {
    input,
    snapshot: captureNodeManifestIdentity([input]),
    sources: [],
    code: new Map(),
    roots: new Set(),
  };
  for (const [id, own] of rows) await candidate(state, id, own);
  current(state);
  await assertCurrentNodeManifestHandlerFiles(state.sources);
  const proof = Object.freeze<NodeNextCacheWriteProof>({ [PROOF]: true });
  proofs.set(proof, state);
  return proof;
}

/** Exact original AST nodes only; never a module exemption or a runtime loader permission. */
export function nodeNextCacheWriteSites(
  proof: NodeNextCacheWriteProof | undefined,
  file: string,
  code: string,
  program: unknown,
): ReadonlySet<Node> {
  if (proof === undefined) return new Set();
  const state = stored(proof);
  const expected = state.code.get(file);
  if (expected === undefined) return new Set();
  current(state);
  if (expected !== code || JSON.stringify(program) !== JSON.stringify(parseAst(code)))
    refuse('changed original audit program');
  return nodeNextCacheWriteData(program)?.roots ?? refuse('changed metadata operation');
}

export async function nodeNextCacheWriteMetadata(
  proof: NodeNextCacheWriteProof,
): Promise<readonly ManifestGraphFile[]> {
  const state = stored(proof);
  current(state);
  await assertCurrentNodeManifestHandlerFiles(state.sources);
  return state.sources.map(({ file, sha256 }) => Object.freeze({ file, sha256 }));
}
