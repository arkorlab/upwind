import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { nodeJwtRequireOnly } from './node-jwt-compiler-sites.ts';
import {
  declaration,
  identifier,
  reference,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import {
  assertNodeManifestIdentity,
  captureNodeManifestIdentity,
  type NodeManifestIdentitySnapshot,
} from './node-manifest-identity-snapshot.ts';
import {
  previewCertifiedNodeCachePolicy,
  rewriteCertifiedNodeNextFile,
  type NodeNextRewriteInput,
  type NodeNextRewriteProof,
} from './node-next-rewrite-proof.ts';

const POLICY: unique symbol = Symbol('unused certified cache import');
const MAX_BYTES = 4_194_304;
const MAX_NODES = 100_000;
const TWO = 2;
interface Range {
  readonly start: number;
  readonly end: number;
}
export interface NodeJwtCallerPolicyProof {
  readonly [POLICY]: true;
}
interface PolicyInput {
  readonly rewrites: NodeNextRewriteProof | undefined;
  readonly input: NodeNextRewriteInput;
  readonly file: string;
  readonly code: string;
}
interface State {
  readonly original: PolicyInput;
  readonly snapshot: NodeManifestIdentitySnapshot;
  readonly file: string;
  readonly raw: string;
  readonly analysis: string;
  readonly text: string;
  readonly rewrites: NodeNextRewriteProof;
  readonly input: NodeNextRewriteInput;
}
const POLICIES = new WeakMap<NodeJwtCallerPolicyProof, State>();
function refuse(reason: string): never {
  throw new AuditError(`Unproved Node JWT cache caller inspection: ${reason}`);
}
function parsed(code: string): Node | undefined {
  if (Buffer.byteLength(code) > MAX_BYTES) return undefined;
  const value: unknown = parseAst(code, { sourceType: 'commonjs' });
  return isNode(value) ? value : undefined;
}
function named(value: unknown, name: string): boolean {
  return identifier(value) && value.name === name;
}
function dot(value: unknown, name: string): value is Node {
  return (
    isNode(value) &&
    value.type === 'MemberExpression' &&
    value['computed'] !== true &&
    value['optional'] !== true &&
    named(value['property'], name)
  );
}
function simpleArrow(value: unknown): value is Node {
  return (
    isNode(value) &&
    value.type === 'ArrowFunctionExpression' &&
    value['async'] !== true &&
    listOf(value, 'params').length === 1 &&
    identifier(listOf(value, 'params')[0])
  );
}
function importHelper(value: unknown): boolean {
  if (!simpleArrow(value)) return false;
  const parameter = listOf(value, 'params')[0];
  const call = value['body'];
  if (
    !identifier(parameter) ||
    !isNode(call) ||
    call.type !== 'CallExpression' ||
    call['optional'] === true ||
    !dot(call['callee'], 'then')
  )
    return false;
  const imported = call['callee']['object'];
  if (
    !isNode(imported) ||
    imported.type !== 'ImportExpression' ||
    !named(imported['source'], parameter.name) ||
    (imported['options'] !== undefined && imported['options'] !== null)
  )
    return false;
  const callbacks = listOf(call, 'arguments');
  const callback = callbacks[0];
  if (callbacks.length !== 1 || !simpleArrow(callback)) return false;
  const item = listOf(callback, 'params')[0];
  const result = callback['body'];
  return (
    identifier(item) &&
    isNode(result) &&
    result.type === 'LogicalExpression' &&
    result['operator'] === '||' &&
    dot(result['left'], 'default') &&
    named(result['left']['object'], item.name) &&
    named(result['right'], item.name)
  );
}
function declarationStatement(visit: Visit, visits: ReadonlyMap<Node, Visit>): Node | undefined {
  const node = visit.node;
  const statement = visit.parent;
  const owner = statement === undefined ? undefined : visits.get(statement);
  if (
    owner?.parent === undefined ||
    owner.key !== 'body' ||
    !['BlockStatement', 'Program', 'StaticBlock'].includes(owner.parent.type)
  )
    return undefined;
  return node.type === 'VariableDeclarator' &&
    identifier(node['id']) &&
    node['id'].name !== 'require' &&
    importHelper(node['init']) &&
    statement?.type === 'VariableDeclaration' &&
    listOf(statement, 'declarations').length === 1
    ? statement
    : undefined;
}
function scopeOf(name: string, scopes: readonly Scope[]): Scope | undefined {
  return scopes.findLast((scope) => scope.declared.has(name));
}
function binds(value: unknown, name: string): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!isNode(node)) continue;
    if (identifier(node) && node.name === name) return true;
    switch (node.type) {
      case 'Property': {
        pending.push(node['value']);
        break;
      }
      case 'AssignmentPattern': {
        pending.push(node['left']);
        break;
      }
      case 'RestElement': {
        pending.push(node['argument']);
        break;
      }
      default: {
        const children = listOf(node, node.type === 'ObjectPattern' ? 'properties' : 'elements');
        for (const child of children) pending.push(child);
      }
    }
  }
  return false;
}
interface Binding {
  readonly candidate: Visit;
  readonly name: string;
  readonly scope: Scope;
  readonly visits: ReadonlyMap<Node, Visit>;
}
function redeclared(visit: Visit, binding: Binding): boolean {
  const { candidate, name, scope, visits } = binding;
  const node = visit.node;
  if (node === candidate.node) return false;
  if (node.type === 'VariableDeclarator' && binds(node['id'], name))
    return scopeOf(name, visit.scopes) === scope;
  if (!['ClassDeclaration', 'FunctionDeclaration'].includes(node.type) || !named(node['id'], name))
    return false;
  const parent = visit.parent === undefined ? undefined : visits.get(visit.parent);
  return parent !== undefined && scopeOf(name, parent.scopes) === scope;
}
function ownReference(visit: Visit, binding: Binding): boolean {
  return (
    identifier(visit.node) &&
    visit.node.name === binding.name &&
    reference(visit) &&
    declaration(binding.name, visit.scopes)?.node === binding.candidate.node
  );
}
function opaqueScope(visit: Visit, scope: Scope): boolean {
  if (!visit.scopes.includes(scope)) return false;
  return (
    visit.node.type === 'WithStatement' ||
    (named(visit.node, 'eval') &&
      reference(visit) &&
      declaration('eval', visit.scopes) === undefined)
  );
}
function implicitAlias(all: readonly Visit[], name: string, scope: Scope): boolean {
  const owner = all.find((visit) => {
    return (
      visit.scopes.at(-1) === scope &&
      ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(
        visit.node.type,
      )
    );
  });
  return (
    owner !== undefined &&
    (binds(owner.node['id'], name) ||
      listOf(owner.node, 'params').some((parameter) => binds(parameter, name)))
  );
}
function references(candidate: Visit, all: readonly Visit[], ranges: readonly Range[]): boolean {
  const id = candidate.node['id'];
  if (!identifier(id) || declaration(id.name, candidate.scopes)?.node !== candidate.node)
    return false;
  const scope = scopeOf(id.name, candidate.scopes);
  if (scope === undefined || implicitAlias(all, id.name, scope)) return false;
  const visits = new Map(all.map((visit) => [visit.node, visit]));
  const binding = { candidate, name: id.name, scope, visits };
  const counts = ranges.map(() => 0);
  for (const visit of all) {
    const { node, parent } = visit;
    if (redeclared(visit, binding) || opaqueScope(visit, scope)) return false;
    if (!ownReference(visit, binding)) continue;
    if (
      parent?.type !== 'CallExpression' ||
      parent['callee'] !== node ||
      parent['optional'] === true
    )
      return false;
    const at = ranges.findIndex((range) => node.start >= range.start && node.end <= range.end);
    if (at === -1) return false;
    counts[at] = (counts[at] ?? 0) + 1;
  }
  return counts.every((count) => count === 1);
}
function rangesValid(code: string, all: readonly Visit[], ranges: readonly Range[]): boolean {
  if (ranges.length !== TWO) return false;
  const sorted = ranges.toSorted((left, right) => left.start - right.start);
  for (const range of sorted) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.start >= range.end ||
      range.end > code.length ||
      all.every(
        ({ node }) =>
          !(node.type === 'CallExpression' && node.start === range.start && node.end === range.end),
      )
    )
      return false;
  }
  return sorted[0] !== undefined && sorted[1] !== undefined && sorted[0].end <= sorted[1].start;
}
/** Unqualified DATA only. Caller-provided ranges can never mint the private policy below. */
export function nodeJwtUnusedCacheImport(input: {
  readonly code: string;
  readonly original: unknown;
  readonly removed: readonly Range[];
}): { readonly status: 'UNQUALIFIED'; readonly declaration: Range } | undefined {
  const fresh = parsed(input.code);
  if (
    fresh === undefined ||
    !isNode(input.original) ||
    JSON.stringify(input.original) !== JSON.stringify(fresh)
  )
    return undefined;
  const all = visitTree(input.original);
  if (all.length > MAX_NODES || !rangesValid(input.code, all, input.removed)) return undefined;
  const visits = new Map(all.map((visit) => [visit.node, visit]));
  const candidates = all.filter((visit) => declarationStatement(visit, visits) !== undefined);
  const candidate = candidates[0];
  const statement = candidate === undefined ? undefined : declarationStatement(candidate, visits);
  if (
    candidate === undefined ||
    statement === undefined ||
    candidates.length !== 1 ||
    !references(candidate, all, input.removed)
  )
    return undefined;
  return Object.freeze({
    status: 'UNQUALIFIED',
    declaration: Object.freeze({ start: statement.start, end: statement.end }),
  });
}
function unused(code: string, text: string): Range | undefined {
  const program = parsed(code);
  if (program === undefined) return undefined;
  const all = visitTree(program);
  if (all.length > MAX_NODES) return undefined;
  const visits = new Map(all.map((visit) => [visit.node, visit]));
  const candidates = all.filter((visit) => {
    const statement = declarationStatement(visit, visits);
    return statement !== undefined && code.slice(statement.start, statement.end) === text;
  });
  const candidate = candidates[0];
  if (candidate === undefined || candidates.length !== 1 || !identifier(candidate.node['id']))
    return undefined;
  const name = candidate.node['id'].name;
  if (declaration(name, candidate.scopes)?.node !== candidate.node) return undefined;
  const scope = scopeOf(name, candidate.scopes);
  if (scope === undefined || implicitAlias(all, name, scope)) return undefined;
  const binding = { candidate, name, scope, visits };
  if (
    all.some(
      (visit) =>
        redeclared(visit, binding) || opaqueScope(visit, scope) || ownReference(visit, binding),
    )
  )
    return undefined;
  const statement = declarationStatement(candidate, visits);
  return statement === undefined ? undefined : { start: statement.start, end: statement.end };
}
function remove(code: string, range: Range): string {
  // Keep a statement barrier: inspection must not manufacture a directive prologue.
  return `${code.slice(0, range.start)};${code.slice(range.end)}`;
}
function current(policy: NodeJwtCallerPolicyProof): State {
  const state = POLICIES.get(policy) ?? refuse('copied policy proof');
  assertNodeManifestIdentity(state.snapshot, [state.original]);
  const preview = previewCertifiedNodeCachePolicy(state.rewrites, state.input, {
    file: state.file,
    code: state.raw,
  });
  if (preview?.analysis !== state.analysis) refuse('changed source or policy analysis');
  return state;
}
export function certifyNodeJwtCallerPolicy(
  input: PolicyInput,
): NodeJwtCallerPolicyProof | undefined {
  const snapshot = captureNodeManifestIdentity([input]);
  const preview = previewCertifiedNodeCachePolicy(input.rewrites, input.input, {
    file: input.file,
    code: input.code,
  });
  if (preview === undefined || input.rewrites === undefined) return undefined;
  const result = nodeJwtUnusedCacheImport({
    code: input.code,
    original: parsed(input.code),
    removed: preview.removed,
  });
  if (result === undefined) return undefined;
  const text = input.code.slice(result.declaration.start, result.declaration.end);
  if (unused(preview.analysis, text) === undefined) return undefined;
  const proof = Object.freeze<NodeJwtCallerPolicyProof>({ [POLICY]: true });
  POLICIES.set(proof, {
    original: input,
    snapshot,
    file: input.file,
    raw: input.code,
    analysis: preview.analysis,
    text,
    rewrites: input.rewrites,
    input: input.input,
  });
  current(proof);
  return proof;
}
export function nodeJwtCallerPolicyInspection(
  policy: NodeJwtCallerPolicyProof,
  original: { readonly file: string; readonly code: string },
): string {
  const state = current(policy);
  if (original.file !== state.file || original.code !== state.raw)
    refuse('foreign original caller');
  const preview = previewCertifiedNodeCachePolicy(state.rewrites, state.input, original);
  const range = preview === undefined ? undefined : unused(preview.analysis, state.text);
  return range === undefined || preview === undefined
    ? refuse('changed original helper')
    : remove(preview.analysis, range);
}
export function nodeJwtCallerPolicyArchiveInspection(
  policy: NodeJwtCallerPolicyProof,
  actual: PolicyInput & { readonly name: string },
): string {
  const state = current(policy);
  if (actual.rewrites !== state.rewrites || actual.file !== state.file)
    refuse('foreign physical caller');
  const expected = rewriteCertifiedNodeNextFile(state.rewrites, actual.input, {
    file: state.file,
    name: actual.name,
    code: state.raw,
  });
  if (expected === undefined || actual.code !== expected)
    refuse('uncertified physical caller bytes');
  const range = unused(actual.code, state.text);
  return range === undefined
    ? refuse('physical helper escaped or changed')
    : remove(actual.code, range);
}
export function nodeJwtCallerInspection(input: {
  readonly rewrites: NodeNextRewriteProof | undefined;
  readonly input: NodeNextRewriteInput | undefined;
  readonly file: string;
  readonly code: string;
  readonly specifiers: readonly string[];
}): { readonly code: string; readonly policy?: NodeJwtCallerPolicyProof } | undefined {
  if (input.specifiers.every((specifier) => nodeJwtRequireOnly(input.code, specifier)))
    return { code: input.code };
  if (input.input === undefined) return undefined;
  const policy = certifyNodeJwtCallerPolicy({
    rewrites: input.rewrites,
    input: input.input,
    file: input.file,
    code: input.code,
  });
  return policy === undefined
    ? undefined
    : {
        code: nodeJwtCallerPolicyInspection(policy, input),
        policy,
      };
}
