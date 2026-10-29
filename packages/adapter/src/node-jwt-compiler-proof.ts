import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, type Node } from './lexical-scope.ts';
import { nodeGuardVersion, type GuardedNodeVersion } from './node-guard-version.ts';
import { nodeJwtGlobalRecoverySite, nodeJwtRequireOnly } from './node-jwt-compiler-sites.ts';
import {
  nodeJwtCallerInspection,
  type NodeJwtCallerPolicyProof,
} from './node-jwt-unused-cache-import.ts';
import type { ManifestGraphFile, ManifestModuleGraph } from './node-manifest-graph.ts';
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
import type { NodeManifestProof } from './node-manifest-proof.ts';
import type { NodeNextRewriteInput, NodeNextRewriteProof } from './node-next-rewrite-proof.ts';
import {
  assertOriginalCommonJsMode,
  assertOriginalNodeModesGraph,
  useOriginalCommonJsMode,
  type OriginalCommonJsMode,
  type OriginalNodeModeScope,
} from './node-original-load-mode.ts';
import { checkedNodeRouteRewriteSources } from './node-route-rewrite-approval.ts';
import type { AppliedPatch } from './patches/rolldown.ts';

const PROOF: unique symbol = Symbol('fixed Node JWT compiler sites');
const JWT_SUFFIX = '/dist/compiled/jsonwebtoken/index.js';
const JWT_SHA256 = '056c2dddba96faa35f4dc0740228a241990561290ff3bd5456c7c7dbc5a7a6b9';
const JWT_BYTES = 121_051;
const SEMVER_SHA256 = '34c5853dd094229baa28a8b15b86e2143eeb0de0360530798ef3e9a7890942b6';
const NEXT_PACKAGE_SHA256 = 'b67bad7944d603b27dd2d2719b57203fd3b3e5c147b2efa6dea5ceb135274caf';
const BUILTINS = new Set(['buffer', 'crypto', 'stream', 'util']);
const MAX_METADATA_BYTES = 65_536;
const MAX_SOURCE_BYTES = 4_194_304;
const MAX_SCOPE_DEPTH = 64;
const COPIED_PROOF = 'copied compiler proof';
const UNSUPPORTED = 'unsupported fixed whole-source contract';
export interface NodeJwtCompilerProof {
  readonly [PROOF]: true;
}
export interface NodeJwtCompilerInput {
  readonly graph: ManifestModuleGraph;
  readonly originalModes: OriginalNodeModeScope;
  readonly patches: readonly AppliedPatch[];
  readonly context: Parameters<typeof checkedNodeRouteRewriteSources>[0]['context'];
  readonly manifests: Pick<NodeManifestProof, 'routeRewriteApprovals' | 'normalization'>;
  readonly rewrites?: NodeNextRewriteProof | undefined;
  readonly rewriteInput?: NodeNextRewriteInput | undefined;
}
export interface NodeJwtGuardRecord {
  readonly schema: 1;
  readonly profile: 'next-16.4.3-jsonwebtoken-ncc-v1';
  readonly nodeVersion: GuardedNodeVersion;
  readonly archivePath: string;
  readonly sha256: string;
  readonly bytes: typeof JWT_BYTES;
}
interface Mode {
  readonly id: string;
  readonly source: ManifestGraphFile;
  readonly proof: OriginalCommonJsMode;
}
interface Directory {
  readonly file: string;
  readonly identity: string;
}
interface Caller extends ManifestGraphFile {
  readonly specifiers: readonly string[];
  readonly policy?: NodeJwtCallerPolicyProof | undefined;
}
interface State {
  readonly input: NodeJwtCompilerInput;
  readonly snapshot: NodeManifestIdentitySnapshot;
  readonly data: ManifestModuleGraph;
  readonly originals: ReadonlyMap<string, ManifestGraphFile>;
  readonly scope: OriginalNodeModeScope;
  readonly rewrites: NodeNextRewriteProof | undefined;
  readonly rewriteInput: NodeNextRewriteInput | undefined;
  readonly patched: ReadonlySet<string>;
  readonly callers: Map<string, Caller>;
  readonly files: NodeManifestHandlerFile[];
  readonly missing: string[];
  readonly directories: Directory[];
  readonly modes: Mode[];
  readonly codes: ReadonlyMap<string, string>;
  readonly file: string;
}
const PROOFS = new WeakMap<NodeJwtCompilerProof, State>();
function refuse(reason: string): never {
  throw new AuditError(`Unproved fixed Node JWT compiler profile: ${reason}`);
}
function digest(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}
async function source(state: State, file: string, sha256?: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES || (await realpath(file)) !== file)
    refuse('noncanonical regular source');
  const bytes = await readFile(file);
  if (bytes.length !== info.size) refuse('source changed while read');
  const hash = digest(bytes);
  if (sha256 !== undefined && hash !== sha256) refuse('source digest');
  state.files.push(await checkedNodeManifestHandlerFile(file, hash));
  return bytes.toString('utf8');
}
function json(code: string): Record<string, unknown> {
  if (Buffer.byteLength(code) > MAX_METADATA_BYTES) refuse('package metadata bound');
  const value: unknown = JSON.parse(code);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    refuse('package metadata shape');
  const body = parseAst(`(${code});`).body[0];
  if (body?.type !== 'ExpressionStatement' || body.expression.type !== 'ObjectExpression')
    refuse('package metadata syntax');
  const keys = body.expression.properties.map((property) => {
    return property.type === 'Property' && property.key.type === 'Literal'
      ? property.key.value
      : undefined;
  });
  if (new Set(keys).size !== keys.length || keys.includes(undefined))
    refuse('duplicate package metadata');
  return value as Record<string, unknown>;
}
async function directory(state: State, file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isDirectory() || (await realpath(file)) !== file) refuse('directory identity');
  state.directories.push({ file, identity: `${info.dev}:${info.ino}` });
}
async function missing(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw error;
  }
}
async function commonjs(state: State, id: string, known: ManifestGraphFile): Promise<boolean> {
  const original = state.originals.get(id);
  if (original === undefined) return false;
  const proof = await useOriginalCommonJsMode(state.scope, id, original);
  if (proof !== undefined) {
    state.modes.push({ id, source: original, proof });
    return true;
  }
  // This private profile alone uses Node24's missing-type node_modules CommonJS rule.
  // It additionally requires the bootstrap's default-loader/no-custom-startup precondition.
  if (!known.file.endsWith('.js') || !known.file.includes(`${path.sep}node_modules${path.sep}`))
    return false;
  let scope = path.dirname(known.file);
  for (let depth = 0; depth < MAX_SCOPE_DEPTH; depth += 1) {
    await directory(state, scope);
    const metadata = path.join(scope, 'package.json');
    if (!(await missing(metadata))) {
      const value = json(await source(state, metadata));
      if (Object.hasOwn(value, 'type')) return false;
      parseAst(await source(state, known.file, known.sha256), { sourceType: 'commonjs' });
      return true;
    }
    state.missing.push(metadata);
    if (path.basename(scope) === 'node_modules') return false;
    scope = path.dirname(scope);
  }
  return false;
}
function approved(input: NodeJwtCompilerInput): ReturnType<typeof checkedNodeRouteRewriteSources> {
  assertOriginalNodeModesGraph(input.originalModes, input.graph);
  const routes = checkedNodeRouteRewriteSources({
    graph: input.graph,
    context: input.context,
    normalization: input.manifests.normalization,
    approvals: input.manifests.routeRewriteApprovals,
  });
  if (routes.length === 0) refuse('missing completed original SDK route closure');
  return routes;
}
function current(state: State): void {
  assertNodeManifestIdentity(state.snapshot, [state.input]);
  approved(state.input);
}
async function fresh(state: State): Promise<void> {
  current(state);
  await assertCurrentNodeManifestHandlerFiles(state.files);
  for (const known of state.directories) {
    const info = await lstat(known.file);
    if (
      !info.isDirectory() ||
      `${info.dev}:${info.ino}` !== known.identity ||
      (await realpath(known.file)) !== known.file
    )
      refuse('directory changed');
  }
  for (const file of state.missing) if (!(await missing(file))) refuse('new package boundary');
  for (const mode of state.modes)
    await assertOriginalCommonJsMode(mode.proof, state.scope, mode.id, mode.source);
  current(state);
}
async function callerIsCommonJs(
  state: State,
  caller: string,
  id: string,
  ids: ReadonlySet<string>,
): Promise<boolean> {
  const graph = state.data;
  const own = graph.sources.get(caller);
  if (own === undefined || !graph.retained.has(caller)) return false;
  const code = await source(state, own.file, own.sha256);
  const imports = graph.imports?.get(caller);
  const edges = imports?.filter((edge) => edge.target === id);
  if (edges === undefined || edges.length === 0 || !(await commonjs(state, caller, own)))
    return false;
  const inspection = nodeJwtCallerInspection({
    rewrites: state.rewrites,
    input: state.rewriteInput,
    file: own.file,
    code,
    specifiers: edges.map((edge) => edge.specifier),
  });
  if (inspection === undefined) return false;
  for (const edge of edges) {
    if (!nodeJwtRequireOnly(inspection.code, edge.specifier)) return false;
    if (
      imports?.some((other) => other.specifier === edge.specifier && !ids.has(other.target)) ===
      true
    )
      return false;
  }
  const previous = state.callers.get(own.file);
  const specifiers = new Set(previous?.specifiers);
  for (const edge of edges) specifiers.add(edge.specifier);
  state.callers.set(
    own.file,
    Object.freeze({
      ...own,
      specifiers: Object.freeze([...specifiers]),
      ...(inspection.policy !== undefined && { policy: inspection.policy }),
    }),
  );
  return true;
}
function completeIncoming(graph: ManifestModuleGraph, ids: ReadonlySet<string>): boolean {
  // Every recorded physical edge must be represented in the incoming inventory too.
  if (graph.imports === undefined) return false;
  for (const [caller, edges] of graph.imports) {
    if (!graph.retained.has(caller)) continue;
    for (const edge of edges)
      if (ids.has(edge.target) && graph.importers.get(edge.target)?.includes(caller) !== true)
        return false;
  }
  return true;
}
async function incoming(state: State, ids: ReadonlySet<string>): Promise<boolean> {
  const graph = state.data;
  for (const id of ids) {
    const callers = graph.importers.get(id)?.filter((caller) => graph.retained.has(caller));
    if (callers === undefined || callers.length === 0 || graph.roots?.has(id) === true)
      return false;
    for (const caller of callers)
      if (!(await callerIsCommonJs(state, caller, id, ids))) return false;
  }
  return completeIncoming(graph, ids);
}
async function semverDependency(state: State, id: string, root: string): Promise<boolean> {
  const graph = state.data;
  const own = graph.sources.get(id);
  if (
    own?.file !== path.join(root, 'dist/lib/semver-noop.js') ||
    own.sha256 !== SEMVER_SHA256 ||
    !graph.retained.has(id)
  )
    return false;
  if (state.patched.has(id) || state.patched.has(own.file)) return false;
  await source(state, own.file, SEMVER_SHA256);
  return await commonjs(state, id, own);
}
async function dependencies(
  state: State,
  ids: ReadonlySet<string>,
  root: string,
): Promise<boolean> {
  for (const id of ids) {
    const edges = state.data.imports?.get(id);
    if (edges?.some((edge) => edge.specifier === 'next/dist/lib/semver-noop') !== true)
      return false;
    for (const edge of edges) {
      if (BUILTINS.has(edge.specifier)) {
        if (edge.target.replace(/^node:/u, '') !== edge.specifier) return false;
      } else if (
        edge.specifier !== 'next/dist/lib/semver-noop' ||
        !(await semverDependency(state, edge.target, root))
      )
        return false;
    }
  }
  return true;
}
async function renderedCodes(
  state: State,
  candidates: readonly (readonly [string, ManifestGraphFile])[],
): Promise<ReadonlyMap<string, string> | undefined> {
  const codes = new Map<string, string>();
  for (const [id, own] of candidates) {
    const code = state.data.rendered?.get(id);
    if (
      code === undefined ||
      own.sha256 !== JWT_SHA256 ||
      !state.data.retained.has(id) ||
      !(await commonjs(state, id, own)) ||
      nodeJwtGlobalRecoverySite(parseAst(code)) === undefined
    )
      return undefined;
    codes.set(id, code);
  }
  return codes;
}
function graphData(graph: ManifestModuleGraph): ManifestModuleGraph {
  const imports = graph.imports;
  return {
    sources: new Map([...graph.sources].map(([id, own]) => [id, Object.freeze({ ...own })])),
    importers: new Map([...graph.importers].map(([id, rows]) => [id, Object.freeze([...rows])])),
    retained: new Set(graph.retained),
    ...(graph.roots !== undefined && { roots: new Set(graph.roots) }),
    ...(graph.rendered !== undefined && { rendered: new Map(graph.rendered) }),
    ...(imports !== undefined && {
      imports: new Map(
        [...imports].map(([id, edges]) => {
          const rows = edges.map((edge) => Object.freeze({ ...edge }));
          return [id, Object.freeze(rows)];
        }),
      ),
    }),
  };
}

/**
 * Manually qualified PRIMARY Next16.4.3 NCC source (Git blob 33a1c8901b96d04376c1649e2f144f0c335d1762).
 * Entry532 exposes verify/sign/three errors/decode, never dispatcher or Lodash464. Its sole
 * Lodash consumer sign863 selects includes/isBoolean/isInteger/isNumber/isPlainObject/isString/
 * once. once preserves user receiver/arguments/result; it is not a purity or sandbox claim.
 * Initial runInContext() completes before user callbacks. Only full Lodash exposes template's
 * captured Function compiler/runInContext; none of the seven methods returns that namespace.
 * Fresh NCC records have no require. The literal process.binding('util') fallback reads only
 * six metadata predicates. Node24's legacy binding filters util.types, not a loader namespace.
 * REQUIRED bootstrap guard closes earlier AMD/global publication, global recovery, prototype
 * overrides and util.types accessors immediately before ORIGINAL CJS evaluation. Without that
 * guard this proof cannot authorize publication. No source is rewritten or skipped by the audit.
 */
export async function qualifyNodeJwtCompiler(
  input: NodeJwtCompilerInput,
): Promise<NodeJwtCompilerProof | undefined> {
  const snapshot = captureNodeManifestIdentity([input]);
  const data = graphData(input.graph);
  const candidates = [...data.sources].filter(
    ([id, own]) => data.retained.has(id) && own.file.split(path.sep).join('/').endsWith(JWT_SUFFIX),
  );
  if (candidates.length === 0) return undefined;
  const first = candidates[0]?.[1];
  if (first === undefined || candidates.some(([, own]) => own.file !== first.file))
    return refuse(UNSUPPORTED);
  const routes = approved(input);
  const state: State = {
    input,
    snapshot,
    data,
    originals: new Map(input.graph.sources),
    scope: input.originalModes,
    rewrites: input.rewrites,
    rewriteInput: input.rewriteInput,
    patched: new Set(input.patches.map((patch) => patch.file)),
    callers: new Map(),
    files: [],
    missing: [],
    directories: [],
    modes: [],
    codes: new Map(),
    file: first.file,
  };
  const root = first.file.slice(0, -JWT_SUFFIX.length);
  if (path.basename(root) !== 'next' || path.basename(path.dirname(root)) !== 'node_modules')
    return refuse(UNSUPPORTED);
  if (routes.every((route) => route.root !== root)) return refuse(UNSUPPORTED);
  const metadata = json(await source(state, path.join(root, 'package.json'), NEXT_PACKAGE_SHA256));
  if (metadata['name'] !== 'next' || metadata['version'] !== '16.4.3') return refuse(UNSUPPORTED);
  const raw = await source(state, first.file, JWT_SHA256);
  if (Buffer.byteLength(raw) !== JWT_BYTES) return refuse(UNSUPPORTED);
  const rawProgram = parseAst(raw, { sourceType: 'commonjs' });
  if (nodeJwtGlobalRecoverySite(rawProgram) === undefined) return refuse(UNSUPPORTED);
  const ids = new Set(candidates.map(([id]) => id));
  for (const file of state.patched)
    if (ids.has(file) || file === first.file) return refuse(UNSUPPORTED);
  const codes = await renderedCodes(state, candidates);
  if (codes === undefined) return refuse(UNSUPPORTED);
  if (!(await incoming(state, ids))) return refuse(`${UNSUPPORTED}: retained incoming load roles`);
  if (!(await dependencies(state, ids, root)))
    return refuse(`${UNSUPPORTED}: fixed builtin and semver dependency closure`);
  const proof = Object.freeze<NodeJwtCompilerProof>({ [PROOF]: true });
  const sealed = { ...state, codes };
  await fresh(sealed);
  PROOFS.set(proof, sealed);
  return proof;
}

/** The ordinary closure walker receives one exact original-program node, not a module waiver. */
export function nodeJwtCompilerSite(
  proof: NodeJwtCompilerProof | undefined,
  file: string,
  code: string,
  program: unknown,
): Node | undefined {
  if (proof === undefined) return undefined;
  const state = PROOFS.get(proof) ?? refuse(COPIED_PROOF);
  if (!state.codes.has(file)) return undefined;
  current(state);
  if (state.codes.get(file) !== code) refuse('foreign or changed rendered module');
  // Bind the supplied original parse, not a caller-constructed equivalent tree.
  if (!isNode(program) || JSON.stringify(program) !== JSON.stringify(parseAst(code)))
    refuse('changed audit program');
  return nodeJwtGlobalRecoverySite(program) ?? refuse('changed rendered compiler site');
}

export async function nodeJwtCompilerMetadata(proof: NodeJwtCompilerProof): Promise<{
  readonly files: readonly ManifestGraphFile[];
  readonly missing: readonly string[];
  readonly callers: readonly Caller[];
}> {
  const state = PROOFS.get(proof) ?? refuse(COPIED_PROOF);
  await fresh(state);
  return Object.freeze({
    files: Object.freeze(
      state.files
        .filter(({ file }) => !state.callers.has(file))
        .map(({ file, sha256 }) => Object.freeze({ file, sha256 })),
    ),
    missing: Object.freeze([...state.missing]),
    callers: Object.freeze([...state.callers.values()]),
  });
}
export async function nodeJwtGuardRecord(
  proof: NodeJwtCompilerProof,
  nameOf: (file: string) => string,
): Promise<NodeJwtGuardRecord> {
  const state = PROOFS.get(proof) ?? refuse(COPIED_PROOF);
  await fresh(state);
  const archivePath = nameOf(state.file);
  if (
    archivePath.length === 0 ||
    archivePath.includes('\\') ||
    path.isAbsolute(archivePath) ||
    archivePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  )
    refuse('archive target boundary');
  await fresh(state);
  return Object.freeze<NodeJwtGuardRecord>({
    schema: 1,
    profile: 'next-16.4.3-jsonwebtoken-ncc-v1',
    nodeVersion: nodeGuardVersion(),
    archivePath,
    sha256: JWT_SHA256,
    bytes: JWT_BYTES,
  });
}
