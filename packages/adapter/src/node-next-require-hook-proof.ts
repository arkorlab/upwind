import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode } from './lexical-scope.ts';
import type { NodeJwtCompilerInput } from './node-jwt-compiler-proof.ts';
import { nodeJwtRequireOnly } from './node-jwt-compiler-sites.ts';
import {
  nodeJwtCallerInspection,
  type NodeJwtCallerPolicyProof,
} from './node-jwt-unused-cache-import.ts';
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
import { nodeNextHookAliasRoleData } from './node-next-hook-alias-role.ts';
import {
  nodeNextStaticRequireHookSites,
  type NodeNextRequireHookSites,
} from './node-next-require-hook-sites.ts';
import {
  assertOriginalCommonJsMode,
  assertOriginalNodeModesGraph,
  useOriginalCommonJsMode,
  type OriginalCommonJsMode,
} from './node-original-load-mode.ts';
import { checkedNodeRouteRewriteSources } from './node-route-rewrite-approval.ts';

const PROOF = Symbol('fixed original Next require hook');
const SUFFIX = '/dist/server/require-hook.js';
const SHA256 = 'e82f0ceba88d025c725ea3062974ad9d7a54a892df8c34a525cb129202387db8';
const BYTES = 3066;
const NEXT_PACKAGE_SHA256 = 'b67bad7944d603b27dd2d2719b57203fd3b3e5c147b2efa6dea5ceb135274caf';
const SHARED_RUNTIME = '.shared-runtime';
const STYLE = 'styled-jsx/style';
const CONTEXTS = 'next/dist/server/route-modules/pages/vendored/contexts/';
const MAX_SOURCE_BYTES = 4_194_304;
const MAX_METADATA_BYTES = 65_536;
const MAX_SCOPE_DEPTH = 64;
export interface NodeNextRequireHookProof {
  readonly [PROOF]: true;
}
export interface NodeNextRequireHookGuardRecord {
  readonly schema: 1;
  readonly profile: 'next-16.4.3-require-hook-v1';
  readonly nodeVersion: '24.22.1';
  readonly archivePath: string;
  readonly sha256: typeof SHA256;
  readonly bytes: typeof BYTES;
}
export interface NodeNextHookAlias {
  readonly request: 'styled-jsx' | 'styled-jsx/style' | 'styled-jsx/style.js';
  readonly target: string;
}
export interface NodeNextSharedRuntimeEdge {
  readonly caller: string;
  readonly specifier: string;
  readonly target: string;
}
interface Caller extends ManifestGraphFile {
  readonly specifiers: readonly string[];
  readonly policy?: NodeJwtCallerPolicyProof | undefined;
}
interface Mode {
  readonly id: string;
  readonly source: ManifestGraphFile;
  readonly proof: OriginalCommonJsMode;
}
interface State {
  readonly input: NodeJwtCompilerInput;
  readonly snapshot: NodeManifestIdentitySnapshot;
  readonly file: string;
  readonly root: string;
  readonly files: Map<string, NodeManifestHandlerFile>;
  readonly missing: Set<string>;
  readonly directories: Map<string, string>;
  readonly modes: Mode[];
  readonly callers: Map<string, Caller>;
  readonly codes: Map<string, string>;
  readonly originals: Map<string, string>;
  readonly aliases: NodeNextHookAlias[];
  readonly sharedRuntimeEdges: NodeNextSharedRuntimeEdge[];
  aliasMetadata: string | undefined;
}
const proofs = new WeakMap<NodeNextRequireHookProof, State>();
function refuse(reason: string): never {
  throw new AuditError(`Unproved fixed Next require hook: ${reason}`);
}
function stored(proof: NodeNextRequireHookProof): State {
  return proofs.get(proof) ?? refuse('copied or missing proof');
}
function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function approved(input: NodeJwtCompilerInput) {
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
async function source(state: State, file: string, expected?: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.size > MAX_SOURCE_BYTES || (await realpath(file)) !== file)
    refuse('noncanonical regular source');
  const bytes = await readFile(file);
  const sha256 = digest(bytes);
  if (bytes.length !== info.size || (expected !== undefined && sha256 !== expected))
    refuse('source changed or digest mismatch');
  const previous = state.files.get(file);
  if (previous !== undefined && previous.sha256 !== sha256)
    refuse('conflicting source digests during qualification');
  state.files.set(file, await checkedNodeManifestHandlerFile(file, sha256));
  return bytes.toString('utf8');
}
function json(code: string): Record<string, unknown> {
  if (Buffer.byteLength(code) > MAX_METADATA_BYTES) refuse('package metadata bound');
  const value: unknown = JSON.parse(code);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    refuse('package metadata shape');
  const first = parseAst(`(${code});`).body[0];
  if (first?.type !== 'ExpressionStatement' || first.expression.type !== 'ObjectExpression')
    refuse('package metadata syntax');
  const keys = first.expression.properties.map((property) => {
    return property.type === 'Property' && property.key.type === 'Literal'
      ? property.key.value
      : undefined;
  });
  if (new Set(keys).size !== keys.length || keys.includes(undefined))
    refuse('duplicate package metadata');
  return value as Record<string, unknown>;
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
async function commonjs(state: State, id: string, own: ManifestGraphFile): Promise<boolean> {
  const mode = await useOriginalCommonJsMode(state.input.originalModes, id, own);
  if (mode !== undefined) {
    state.modes.push({ id, source: own, proof: mode });
    return true;
  }
  if (!own.file.endsWith('.js') || !own.file.includes(`${path.sep}node_modules${path.sep}`))
    return false;
  let directory = path.dirname(own.file);
  for (let depth = 0; depth < MAX_SCOPE_DEPTH; depth += 1) {
    const info = await lstat(directory);
    if (!info.isDirectory() || (await realpath(directory)) !== directory)
      refuse('package directory identity');
    const identity = `${info.dev}:${info.ino}`;
    const previous = state.directories.get(directory);
    if (previous !== undefined && previous !== identity) refuse('changed package directory');
    state.directories.set(directory, identity);
    const metadata = path.join(directory, 'package.json');
    if (!(await missing(metadata))) {
      if (Object.hasOwn(json(await source(state, metadata)), 'type')) return false;
      parseAst(await source(state, own.file, own.sha256), { sourceType: 'commonjs' });
      return true;
    }
    state.missing.add(metadata);
    if (path.basename(directory) === 'node_modules') return false;
    directory = path.dirname(directory);
  }
  return false;
}
/** Pure selection DATA only. Supplying a resolver never grants a private source proof. */
export function nodeNextHookAliasData(resolve: (specifier: string) => string): {
  readonly qualification: 'UNQUALIFIED DATA';
  readonly aliases: readonly NodeNextHookAlias[];
  readonly metadata: string | undefined;
} {
  let metadata: string | undefined;
  let defaults: NodeNextHookAlias[];
  try {
    metadata = resolve('styled-jsx/package.json');
    // Match Object.assign's argument evaluation: no partial assignment if any resolve throws.
    defaults = [
      { request: 'styled-jsx', target: path.dirname(metadata) },
      { request: STYLE, target: resolve(STYLE) },
      { request: 'styled-jsx/style.js', target: resolve(STYLE) },
    ];
  } catch {
    defaults = [];
  }
  const aliases: NodeNextHookAlias[] = [];
  for (const entry of defaults) {
    try {
      aliases.push({ request: entry.request, target: resolve(entry.target) });
    } catch {
      /* The original toResolveMap catches each individual second-stage resolution. */
    }
  }
  return { qualification: 'UNQUALIFIED DATA', aliases, metadata };
}
function initialAliases(file: string) {
  return nodeNextHookAliasData(createRequire(file).resolve);
}
function owned(state: State, file: string): ManifestGraphFile {
  const rows = [...state.input.graph.sources].filter(
    ([id, own]) => state.input.graph.retained.has(id) && own.file === file,
  );
  const first = rows[0]?.[1];
  if (first === undefined || rows.some(([, own]) => own.sha256 !== first.sha256))
    refuse('alias target is outside the retained physical closure');
  return first;
}
function sharedTarget(caller: string, specifier: string): string {
  return createRequire(caller).resolve(`${CONTEXTS}${path.basename(specifier, SHARED_RUNTIME)}`);
}
async function sharedEdge(
  state: State,
  caller: ManifestGraphFile,
  specifier: string,
): Promise<void> {
  const target = sharedTarget(caller.file, specifier);
  const prefix = `${state.root}${path.sep}dist${path.sep}server${path.sep}route-modules${path.sep}pages${path.sep}vendored${path.sep}contexts${path.sep}`;
  if (!target.startsWith(prefix)) refuse('shared-runtime target outside qualified Next root');
  const own = owned(state, target);
  await source(state, own.file, own.sha256);
  await source(state, caller.file, caller.sha256);
  state.sharedRuntimeEdges.push(Object.freeze({ caller: caller.file, specifier, target }));
}
async function aliasInventory(state: State): Promise<void> {
  const initial = initialAliases(state.file);
  state.aliasMetadata = initial.metadata;
  if (initial.metadata !== undefined) await source(state, initial.metadata);
  for (const alias of initial.aliases) {
    const data = nodeNextHookAliasRoleData(state.input.graph, alias);
    if (data === undefined) refuse('incomplete alias execution inventory');
    const own = data.requiresOwned ? owned(state, alias.target) : undefined;
    await source(state, alias.target, own?.sha256 ?? data.sha256);
    state.aliases.push(Object.freeze(alias));
  }
  const imports = state.input.graph.imports;
  if (imports === undefined) refuse('missing shared-runtime inventory');
  for (const [id, edges] of imports) {
    if (!state.input.graph.retained.has(id)) continue;
    const caller = state.input.graph.sources.get(id) ?? refuse('missing shared-runtime caller');
    for (const edge of edges)
      if (edge.specifier.endsWith(SHARED_RUNTIME)) await sharedEdge(state, caller, edge.specifier);
  }
}
async function incomingCaller(
  state: State,
  caller: string,
  id: string,
  ids: ReadonlySet<string>,
): Promise<void> {
  const graph = state.input.graph;
  const own = graph.sources.get(caller) ?? refuse('missing original caller');
  const code = await source(state, own.file, own.sha256);
  const edges = graph.imports?.get(caller)?.filter((edge) => edge.target === id);
  if (edges === undefined || edges.length === 0 || !(await commonjs(state, caller, own)))
    refuse('unproved CJS caller');
  const specifiers = edges.map((edge) => edge.specifier);
  const view = nodeJwtCallerInspection({
    rewrites: state.input.rewrites,
    input: state.input.rewriteInput,
    file: own.file,
    code,
    specifiers,
  });
  if (view === undefined) refuse('unproved caller inspection');
  for (const specifier of specifiers)
    if (
      !nodeJwtRequireOnly(view.code, specifier) ||
      graph.imports
        ?.get(caller)
        ?.some((edge) => edge.specifier === specifier && !ids.has(edge.target)) === true
    )
      refuse('incoming load role');
  const known = new Set(state.callers.get(own.file)?.specifiers);
  for (const specifier of specifiers) known.add(specifier);
  state.callers.set(
    own.file,
    Object.freeze({
      ...own,
      specifiers: Object.freeze([...known]),
      ...(view.policy !== undefined && { policy: view.policy }),
    }),
  );
}
async function incoming(state: State, ids: ReadonlySet<string>): Promise<void> {
  const graph = state.input.graph;
  if (graph.imports === undefined) refuse('missing incoming load inventory');
  for (const id of ids) {
    const callers = graph.importers.get(id)?.filter((caller) => graph.retained.has(caller));
    if (callers === undefined || callers.length === 0 || graph.roots?.has(id) === true)
      refuse('unsupported hook entry');
    for (const caller of callers) await incomingCaller(state, caller, id, ids);
  }
  for (const [caller, edges] of graph.imports)
    for (const edge of edges)
      if (
        graph.retained.has(caller) &&
        ids.has(edge.target) &&
        graph.importers.get(edge.target)?.includes(caller) !== true
      )
        refuse('incomplete incoming inventory');
}
async function fresh(state: State): Promise<void> {
  current(state);
  await assertCurrentNodeManifestHandlerFiles([...state.files.values()]);
  for (const [file, identity] of state.directories) {
    const info = await lstat(file);
    if (
      !info.isDirectory() ||
      `${info.dev}:${info.ino}` !== identity ||
      (await realpath(file)) !== file
    )
      refuse('changed package directory');
  }
  for (const file of state.missing) if (!(await missing(file))) refuse('new package boundary');
  for (const mode of state.modes)
    await assertOriginalCommonJsMode(mode.proof, state.input.originalModes, mode.id, mode.source);
  const initial = initialAliases(state.file);
  if (
    initial.metadata !== state.aliasMetadata ||
    JSON.stringify(initial.aliases) !== JSON.stringify(state.aliases)
  )
    refuse('changed default alias resolution');
  for (const edge of state.sharedRuntimeEdges)
    if (sharedTarget(edge.caller, edge.specifier) !== edge.target)
      refuse('changed shared-runtime resolution');
  current(state);
}

/** Fixed original operations only. Bootstrap must run pre-app on default Node with NEXT_MINIMAL false. */
export async function qualifyNodeNextRequireHook(
  input: NodeJwtCompilerInput,
): Promise<NodeNextRequireHookProof | undefined> {
  const snapshot = captureNodeManifestIdentity([input]);
  const candidates = [...input.graph.sources].filter(
    ([id, own]) =>
      input.graph.retained.has(id) && own.file.split(path.sep).join('/').endsWith(SUFFIX),
  );
  const first = candidates[0]?.[1];
  if (first === undefined) return undefined;
  if (candidates.some(([, own]) => own.file !== first.file || own.sha256 !== SHA256))
    refuse('fixed source identity');
  const root = first.file.slice(0, -SUFFIX.length);
  if (
    path.basename(root) !== 'next' ||
    path.basename(path.dirname(root)) !== 'node_modules' ||
    approved(input).every((route) => route.root !== root)
  )
    refuse('canonical Next route root');
  const state: State = {
    input,
    snapshot,
    file: first.file,
    root,
    files: new Map(),
    missing: new Set(),
    directories: new Map(),
    modes: [],
    callers: new Map(),
    codes: new Map(),
    originals: new Map(),
    aliases: [],
    sharedRuntimeEdges: [],
    aliasMetadata: undefined,
  };
  const metadata = json(await source(state, path.join(root, 'package.json'), NEXT_PACKAGE_SHA256));
  if (metadata['name'] !== 'next' || metadata['version'] !== '16.4.3') refuse('fixed Next package');
  const raw = await source(state, first.file, SHA256);
  if (
    Buffer.byteLength(raw) !== BYTES ||
    nodeNextStaticRequireHookSites(parseAst(raw, { sourceType: 'commonjs' })) === undefined
  )
    refuse('fixed original operation shapes');
  const ids = new Set(candidates.map(([id]) => id));
  if (input.patches.some((patch) => patch.file === first.file || ids.has(patch.file)))
    refuse('patched fixed source');
  for (const [id, own] of candidates) {
    const code = input.graph.rendered?.get(id);
    const edges = input.graph.imports?.get(id);
    if (code === undefined || edges === undefined) refuse('missing rendered inventory');
    if (!(await commonjs(state, id, own))) refuse('original CommonJS mode');
    if (
      edges.some((edge) => {
        return (
          !['module', 'path'].includes(edge.specifier) ||
          edge.target.replace(/^node:/u, '') !== edge.specifier
        );
      })
    )
      refuse('fixed builtin closure');
    state.codes.set(id, code);
    state.originals.set(id, raw);
  }
  await incoming(state, ids);
  await aliasInventory(state);
  await fresh(state);
  const proof = Object.freeze<NodeNextRequireHookProof>({ [PROOF]: true });
  proofs.set(proof, state);
  return proof;
}
/** Audit the unchanged archive bytes, with the corresponding rendered inventory still sealed. */
export function nodeNextRequireHookInspection(
  proof: NodeNextRequireHookProof | undefined,
  file: string,
  code: string,
): string | undefined {
  if (proof === undefined) return undefined;
  const state = stored(proof);
  const original = state.originals.get(file);
  if (original === undefined) return undefined;
  current(state);
  if (state.codes.get(file) !== code) refuse('changed rendered audit input');
  return original;
}
export function nodeNextRequireHookSites(
  proof: NodeNextRequireHookProof | undefined,
  file: string,
  code: string,
  program: unknown,
): NodeNextRequireHookSites {
  if (proof === undefined) return { operations: new Set(), namespaceOperands: new Set() };
  const state = stored(proof);
  if (!state.originals.has(file)) return { operations: new Set(), namespaceOperands: new Set() };
  current(state);
  if (
    state.originals.get(file) !== code ||
    !isNode(program) ||
    JSON.stringify(program) !== JSON.stringify(parseAst(code))
  )
    refuse('changed actual audit program');
  return nodeNextStaticRequireHookSites(program) ?? refuse('changed actual operation sites');
}
export async function nodeNextRequireHookMetadata(proof: NodeNextRequireHookProof): Promise<{
  readonly files: readonly ManifestGraphFile[];
  readonly missing: readonly string[];
  readonly callers: readonly Caller[];
  readonly aliases: readonly NodeNextHookAlias[];
  readonly sharedRuntimeEdges: readonly NodeNextSharedRuntimeEdge[];
}> {
  const state = stored(proof);
  await fresh(state);
  return Object.freeze({
    files: Object.freeze(
      [...state.files.values()].map(({ file, sha256 }) => Object.freeze({ file, sha256 })),
    ),
    missing: Object.freeze([...state.missing]),
    callers: Object.freeze([...state.callers.values()]),
    aliases: Object.freeze([...state.aliases]),
    sharedRuntimeEdges: Object.freeze([...state.sharedRuntimeEdges]),
  });
}
export async function nodeNextRequireHookGuardRecord(
  proof: NodeNextRequireHookProof,
  nameOf: (file: string) => string,
): Promise<NodeNextRequireHookGuardRecord> {
  const state = stored(proof);
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
  return Object.freeze({
    schema: 1,
    profile: 'next-16.4.3-require-hook-v1',
    nodeVersion: '24.22.1',
    archivePath,
    sha256: SHA256,
    bytes: BYTES,
  });
}
