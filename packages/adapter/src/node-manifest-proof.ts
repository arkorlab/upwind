/* eslint-disable no-template-curly-in-string -- Reviewed Next.js producer templates are compared as inert JavaScript AST shapes. */
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { parseAst } from 'rolldown/parseAst';

import { beneath } from './build-paths.ts';
import { AuditError } from './dependencies.ts';
import { childrenOf, isNode, listOf, type Node } from './lexical-scope.ts';
import type { TextModule } from './manifests.ts';
import type { NativeAddonEntryTrace } from './native-addons.ts';
import {
  proveManifestConsumerGraph,
  type ManifestGraphInput,
  type ManifestModuleGraph,
  type ManifestRouteSource,
  type NodeManifestNormalization,
} from './node-manifest-graph.ts';
import type { NodeRouteRewriteApproval } from './node-route-rewrite-approval.ts';

const MAX_MANIFEST_BYTES = 33_554_432;
const MAX_PACKAGE_BYTES = 65_536;
const STATEMENTS_WITH_DEPLOYMENT_SUFFIX = 3;
const MANIFEST_SUFFIX = '_client-reference-manifest.js';
const EVALUATOR = 'dist/server/load-manifest.external.js';
const EVALUATOR_SHA = '6e88909558245f1e1e95d97de869a9210f58995e4e19fdba62c25adf8e43d826';
export interface ManifestProofFile {
  readonly file: string;
  readonly sha256: string;
}

interface ManifestProofInput extends ManifestGraphInput {
  readonly manifests?: readonly TextModule[] | undefined;
  readonly entryTraces?: readonly NativeAddonEntryTrace[] | undefined;
}

export interface NodeManifestProof {
  readonly files: readonly ManifestProofFile[];
  /** Code is separate from inert generated manifest data; the original closure gates still apply. */
  readonly codeSources: readonly ManifestProofFile[];
  /** Exact raw compiler runtimes, only after their complete caller/route/SDK-root proof closes. */
  readonly approvedCompilerSources: readonly ManifestProofFile[];
  /** Completed class/caller proof; separate from compiler and VM authority. */
  readonly approvedRouteSources?: readonly ManifestRouteSource[];
  readonly routeRewriteApprovals?: readonly NodeRouteRewriteApproval[];
  readonly normalization?: NodeManifestNormalization | undefined;
  /** Inspection only: never returned to Rolldown or copied into the physical Node artifact. */
  inspectionCode(file: string, code: string): string;
}

function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js client manifest ${reason}; refusing native publication`);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function posix(file: string): string {
  return file.split(path.sep).join('/');
}

async function boundedSource(file: string, maximum: number): Promise<Buffer> {
  const info = await stat(file);
  if (!info.isFile() || info.size > maximum) refuse('source bounds');
  const bytes = await readFile(file);
  if (bytes.byteLength !== info.size) refuse('source changed while reading');
  return bytes;
}

function isIdentifier(value: unknown, name?: string): value is Node {
  return (
    isNode(value) && value.type === 'Identifier' && (name === undefined || value['name'] === name)
  );
}

function isJsonProperty(value: unknown): value is Node {
  if (
    !isNode(value) ||
    value.type !== 'Property' ||
    value['kind'] !== 'init' ||
    value['method'] === true ||
    value['computed'] === true ||
    value['shorthand'] === true
  )
    return false;
  const key = value['key'];
  return (
    isNode(key) &&
    key.type === 'Literal' &&
    typeof key['value'] === 'string' &&
    key['value'] !== '__proto__'
  );
}

function jsonChildren(node: Node): readonly unknown[] {
  switch (node.type) {
    case 'ObjectExpression': {
      const properties = listOf(node, 'properties');
      if (properties.some((property) => !isJsonProperty(property))) refuse('non-data property');
      return properties.map((property) => (property as Node)['value']);
    }
    case 'ArrayExpression': {
      return listOf(node, 'elements');
    }
    case 'Literal': {
      const value = node['value'];
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))
      )
        return [];
      return refuse('non-JSON literal');
    }
    case 'UnaryExpression': {
      const argument = node['argument'];
      if (
        node['operator'] === '-' &&
        isNode(argument) &&
        argument.type === 'Literal' &&
        typeof argument['value'] === 'number' &&
        Number.isFinite(argument['value'])
      )
        return [];
      return refuse('non-JSON unary expression');
    }
    default: {
      return refuse('executable data');
    }
  }
}

function assertJsonData(value: unknown): void {
  const pending: unknown[] = [value];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!isNode(next)) refuse('array hole or non-data value');
    for (const child of jsonChildren(next)) pending.push(child);
  }
}

function manifestTemplate(page: string, deploymentSuffix: boolean): string {
  const key = JSON.stringify(page);
  const prefix = `globalThis.__RSC_MANIFEST=globalThis.__RSC_MANIFEST||{};globalThis.__RSC_MANIFEST[${key}]=null;`;
  if (!deploymentSuffix) return prefix;
  // Exact optional suffix of next-core/client_reference_manifest.rs at the reviewed source pin.
  const suffix = [
    `for(const key in globalThis.__RSC_MANIFEST[${key}].clientModules){`,
    `const val={...globalThis.__RSC_MANIFEST[${key}].clientModules[key]};`,
    `globalThis.__RSC_MANIFEST[${key}].clientModules[key]=val;`,
    "val.chunks=val.chunks.map((c)=>typeof c==='string'",
    '?`${c}?dpl=${process.env.NEXT_DEPLOYMENT_ID}`',
    ':[`${c[0]}?dpl=${process.env.NEXT_DEPLOYMENT_ID}`,c[1],c[2]]);}',
  ].join('');
  return prefix + suffix;
}

function astShape(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) =>
    key === 'start' || key === 'end' || key === 'raw' ? undefined : item,
  );
}

/** Recognize generated data, without running it in Node's VM or changing its original bytes. */
export function assertClientReferenceManifest(source: string, page: string): void {
  try {
    const program: unknown = parseAst(source);
    if (!isNode(program)) refuse('program');
    const body = listOf(program, 'body');
    const statement = body[1];
    if (!isNode(statement)) refuse('missing assignment');
    const expression = statement['expression'];
    if (!isNode(expression) || expression.type !== 'AssignmentExpression') refuse('assignment');
    assertJsonData(expression['right']);
    const empty = parseAst('null;').body[0];
    if (empty?.type !== 'ExpressionStatement') refuse('internal template');
    const replaced = {
      ...program,
      body: body.map((node, index) => {
        return index === 1
          ? { ...statement, expression: { ...expression, right: empty.expression } }
          : node;
      }),
    };
    const expected = parseAst(
      manifestTemplate(page, body.length === STATEMENTS_WITH_DEPLOYMENT_SUFFIX),
    );
    if (astShape(replaced) !== astShape(expected)) refuse('producer shape');
  } catch (error) {
    if (error instanceof AuditError) throw error;
    refuse('syntax or data shape');
  }
}

async function packageSource(root: string): Promise<ManifestProofFile> {
  const file = await realpath(path.join(root, 'package.json'));
  if (path.dirname(file) !== root) refuse('package identity');
  const bytes = await boundedSource(file, MAX_PACKAGE_BYTES);
  let metadata: unknown;
  try {
    metadata = JSON.parse(bytes.toString('utf8'));
  } catch {
    refuse('package metadata');
  }
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('name' in metadata) ||
    metadata.name !== 'next' ||
    !('version' in metadata) ||
    metadata.version !== '16.4.3'
  )
    refuse('version or package identity');
  return { file, sha256: sha256(bytes) };
}

async function ownedScripts(input: ManifestProofInput): Promise<Map<string, string>> {
  const scripts = new Map<string, string>();
  const candidates = (input.entryTraces ?? []).flatMap((trace) =>
    Object.values(trace.assets).filter((asset) => asset.endsWith(MANIFEST_SUFFIX)),
  );
  if (candidates.length === 0) return scripts;
  const dist = await realpath(input.distDir);
  const root = await realpath(path.join(dist, 'server', 'app'));
  if (beneath(dist, root) === undefined) refuse('app output escapes build');
  for (const asset of candidates) {
    const file = await realpath(asset);
    const relative = beneath(root, file);
    if (relative === undefined || relative === '') refuse('owned path escapes app output');
    scripts.set(file, `/${posix(relative).slice(0, -MANIFEST_SUFFIX.length)}`);
  }
  return scripts;
}

async function proveScripts(
  input: ManifestProofInput,
  pages: ReadonlySet<string>,
): Promise<ManifestProofFile[]> {
  if (input.manifests === undefined) refuse('missing sealed manifest inventory');
  const owned = await ownedScripts(input);
  const ownedPages = new Set(owned.values());
  for (const page of pages) {
    if (!ownedPages.has(page.replaceAll('%5F', '_'))) refuse('missing sealed route manifest');
  }
  const files = new Map<string, ManifestProofFile>();
  for (const manifest of input.manifests) {
    if (manifest.routeFile?.endsWith(MANIFEST_SUFFIX) !== true) continue;
    const file = await realpath(manifest.routeFile);
    const page = owned.get(file);
    if (page === undefined || files.has(file)) refuse('missing or duplicate manifest ownership');
    const bytes = await boundedSource(file, MAX_MANIFEST_BYTES);
    assertClientReferenceManifest(bytes.toString('utf8'), page);
    files.set(file, { file, sha256: sha256(bytes) });
  }
  if (files.size !== owned.size) refuse('incomplete owned manifest inventory');
  return [...files.values()];
}

function isVmCall(node: Node): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = node['callee'];
  const expressions =
    isNode(callee) && callee.type === 'SequenceExpression'
      ? listOf(callee, 'expressions')
      : [callee];
  if (expressions.length > 1) {
    const first = expressions[0];
    if (
      expressions.length !== 2 ||
      !isNode(first) ||
      first.type !== 'Literal' ||
      first['value'] !== 0
    )
      return false;
  }
  const member = expressions.at(-1);
  const args = listOf(node, 'arguments');
  return (
    isNode(member) &&
    member.type === 'MemberExpression' &&
    member['computed'] !== true &&
    isIdentifier(member['object']) &&
    isIdentifier(member['property'], 'runInNewContext') &&
    args.length === 2 &&
    args.every((argument) => isIdentifier(argument))
  );
}

function childNodes(node: Node): Node[] {
  return childrenOf(node).flatMap((child) => {
    const values: unknown[] = Array.isArray(child) ? child : [child];
    return values.filter((value) => isNode(value));
  });
}

function vmOperations(program: Node): Node[] {
  const pending = [program];
  const operations: Node[] = [];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isVmCall(node)) operations.push(node);
    for (const child of childNodes(node)) pending.push(child);
  }
  return operations;
}

function inspectedEvaluator(code: string): string {
  const program: unknown = parseAst(code);
  if (!isNode(program)) refuse('retained evaluator program');
  const operations = vmOperations(program);
  if (operations.length > 1) refuse('extra retained VM operation');
  const operation = operations[0];
  if (operation === undefined) return code;
  // Only the separate refusal inspection sees this placeholder. Rolldown's code and every
  // physical source remain original; all other loader/compiler operations are still inspected.
  return `${code.slice(0, operation.start)}undefined${code.slice(operation.end)}`;
}

function mergeRouteSources(
  target: Map<string, ManifestRouteSource>,
  sources: readonly ManifestRouteSource[],
): void {
  for (const source of sources) {
    const previous = target.get(source.file);
    if (
      previous !== undefined &&
      (previous.root !== source.root || previous.sha256 !== source.sha256)
    )
      refuse('conflicting completed route source');
    target.set(source.file, source);
  }
}

/** Certify the one reviewed VM operation over sealed, owned, generated client-manifest data. */
export async function proveNodeManifests(
  input: ManifestProofInput,
  graph: ManifestModuleGraph,
): Promise<NodeManifestProof> {
  const evaluators = [...graph.sources].filter(([id, source]) => {
    if (!graph.retained.has(id) || !posix(source.file).endsWith(`/${EVALUATOR}`)) return false;
    if (graph.rendered === undefined) return true;
    const code = graph.rendered.get(id);
    if (code === undefined) return false;
    const program: unknown = parseAst(code);
    return isNode(program) && vmOperations(program).length > 0;
  });
  const approved = new Set<string>();
  const files = new Map<string, ManifestProofFile>();
  const codeSources = new Map<string, ManifestProofFile>();
  const compilerSources = new Map<string, ManifestProofFile>();
  const routeSources = new Map<string, ManifestRouteSource>();
  const routeRewriteApprovals: NodeRouteRewriteApproval[] = [];
  let normalization: NodeManifestNormalization | undefined;
  const pages = new Set<string>();
  for (const [id, evaluator] of evaluators) {
    const evaluatorBytes = await boundedSource(evaluator.file, MAX_MANIFEST_BYTES);
    if (evaluator.sha256 !== EVALUATOR_SHA || sha256(evaluatorBytes) !== evaluator.sha256)
      refuse('evaluator identity');
    const root = path.resolve(path.dirname(evaluator.file), '../..');
    const metadata = await packageSource(root);
    const consumers = await proveManifestConsumerGraph(input, graph, { id, root });
    normalization = consumers.normalization;
    for (const page of consumers.pages) pages.add(page);
    for (const source of consumers.files) {
      files.set(source.file, source);
      codeSources.set(source.file, source);
    }
    for (const source of consumers.metadataFiles) files.set(source.file, source);
    for (const source of consumers.approvedCompilerSources)
      compilerSources.set(source.file, source);
    mergeRouteSources(routeSources, consumers.approvedRouteSources);
    routeRewriteApprovals.push(consumers.routeRewriteApproval);
    files.set(evaluator.file, evaluator);
    codeSources.set(evaluator.file, evaluator);
    files.set(metadata.file, metadata);
    approved.add(id);
  }
  if (approved.size > 0) {
    const scripts = await proveScripts(input, pages);
    for (const source of scripts) files.set(source.file, source);
  }
  return {
    files: [...files.values()],
    codeSources: [...codeSources.values()],
    approvedCompilerSources: [...compilerSources.values()],
    approvedRouteSources: Object.freeze([...routeSources.values()]),
    routeRewriteApprovals: Object.freeze(routeRewriteApprovals),
    ...(normalization !== undefined && { normalization }),
    inspectionCode: (file, code) => (approved.has(file) ? inspectedEvaluator(code) : code),
  };
}
