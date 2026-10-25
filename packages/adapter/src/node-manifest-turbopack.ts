import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { identifier, propertyName, stringOf } from './node-manifest-consumer-ast.ts';
import { projectTurbopackFactory } from './node-manifest-turbopack-factory.ts';

export interface NodeManifestTurbopackSource {
  readonly code: string;
  readonly sha256: string;
}
export interface NodeManifestTurbopackFactory {
  readonly ids: readonly number[];
  readonly start: number;
  readonly end: number;
}
export interface NodeManifestTurbopackImport {
  readonly kind: 'import' | 'require' | 'external';
  readonly specifier: string;
  readonly targetId?: number;
}
export type NodeManifestTurbopackExports =
  | { readonly kind: 'commonjs' }
  | { readonly kind: 'getters'; readonly names: readonly string[] }
  | { readonly kind: 'namespace'; readonly specifier: string };
export interface NodeManifestTurbopackProjection {
  readonly original: NodeManifestTurbopackSource;
  readonly factory: NodeManifestTurbopackFactory;
  /** Inspection only. Never write these bytes into the physical Node artifact. */
  readonly source: NodeManifestTurbopackSource;
  readonly imports: readonly NodeManifestTurbopackImport[];
  readonly exports: NodeManifestTurbopackExports;
  /** The graph owner must independently seal the runtime implementing these context methods. */
  readonly requiresReviewedRuntime: true;
}
const COMMONJS_PARAMETERS = 3;

function refuseTurbopack(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest ${reason}; refusing native publication`,
  );
}

function turbopackDigest(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

function functionBody(value: unknown): Node {
  if (
    !isNode(value) ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(value.type) ||
    value['async'] === true ||
    value['generator'] === true ||
    (value['id'] !== null && value['id'] !== undefined) ||
    !isNode(value['body']) ||
    value['body'].type !== 'BlockStatement'
  )
    return refuseTurbopack('factory shape');
  return value['body'];
}

function strictStatement(value: unknown): boolean {
  return (
    isNode(value) &&
    value.type === 'ExpressionStatement' &&
    stringOf(value['expression']) === 'use strict'
  );
}

/** Next29bbe factory_group.rs emits these zero-argument strict wrappers, and no other code. */
function strictWrapper(value: Node, returned: boolean): Node | undefined {
  if (
    value.type !== 'CallExpression' ||
    value['optional'] === true ||
    listOf(value, 'arguments').length > 0
  )
    return undefined;
  const callee = value['callee'];
  if (!isNode(callee) || listOf(callee, 'params').length > 0) return undefined;
  const body = functionBody(callee);
  const statements = listOf(body, 'body');
  const last = statements[1];
  if (statements.length !== 2 || !strictStatement(statements[0]) || !isNode(last)) return undefined;
  const key = returned ? 'argument' : 'expression';
  const type = returned ? 'ReturnStatement' : 'ExpressionStatement';
  return last.type === type && isNode(last[key]) ? last[key] : undefined;
}

function registration(program: Node): Node {
  let statements = listOf(program, 'body');
  if (strictStatement(statements[0])) statements = statements.slice(1);
  const only = statements[0];
  if (statements.length !== 1 || !isNode(only) || only.type !== 'ExpressionStatement')
    return refuseTurbopack('registration statements');
  let expression = only['expression'];
  if (!isNode(expression)) return refuseTurbopack('registration expression');
  if (expression.type === 'CallExpression') expression = strictWrapper(expression, false);
  if (
    !isNode(expression) ||
    expression.type !== 'AssignmentExpression' ||
    expression['operator'] !== '='
  )
    return refuseTurbopack('registration assignment');
  const left = expression['left'];
  const right = expression['right'];
  if (
    !isNode(left) ||
    left.type !== 'MemberExpression' ||
    !identifier(left['object']) ||
    left['object'].name !== 'module' ||
    propertyName(left) !== 'exports' ||
    !isNode(right) ||
    right.type !== 'ArrayExpression'
  )
    return refuseTurbopack('registration target');
  return right;
}

function turbopackModuleId(value: unknown): number | undefined {
  if (!isNode(value) || value.type !== 'Literal') return undefined;
  const id = value['value'];
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
}

function factoryParameters(factory: Node): void {
  functionBody(factory);
  const params = listOf(factory, 'params');
  if (params.length !== 1 && params.length !== COMMONJS_PARAMETERS)
    refuseTurbopack('factory parameters');
  if (params.some((param) => !identifier(param))) refuseTurbopack('factory parameter binding');
  const names = params.filter(identifier).map((param) => param.name);
  if (new Set(names).size !== params.length) refuseTurbopack('duplicate factory parameter');
}

function appendNested(
  node: Node,
  result: NodeManifestTurbopackFactory[],
  known: Set<number>,
): void {
  if (node.type !== 'ArrayExpression') refuseTurbopack('strict factory table');
  const first = listOf(node, 'elements')[0];
  if (isNode(first) && strictWrapper(first, true) !== undefined)
    refuseTurbopack('recursive strict factory tables');
  appendFactories(node, result, known);
}

function appendFactories(
  table: Node,
  result: NodeManifestTurbopackFactory[],
  known: Set<number>,
): void {
  let pending: number[] = [];
  for (const [index, item] of listOf(table, 'elements').entries()) {
    if (!isNode(item)) refuseTurbopack('factory table hole');
    const nested = index === 0 ? strictWrapper(item, true) : undefined;
    if (nested !== undefined) {
      appendNested(nested, result, known);
      continue;
    }
    const id = turbopackModuleId(item);
    if (id !== undefined) {
      if (known.has(id)) refuseTurbopack('duplicate module id');
      known.add(id);
      pending.push(id);
      continue;
    }
    if (pending.length === 0) refuseTurbopack('unbound factory');
    factoryParameters(item);
    result.push({ ids: pending, start: item.start, end: item.end });
    pending = [];
  }
  if (pending.length > 0) refuseTurbopack('missing factory');
}

function checkedTurbopackProgram(source: NodeManifestTurbopackSource): Node {
  if (turbopackDigest(source.code) !== source.sha256) refuseTurbopack('source byte identity');
  const program: unknown = parseAst(source.code);
  if (!isNode(program) || program.type !== 'Program') refuseTurbopack('source program');
  return program;
}

/** This validates registration only; no factory body receives a manifest exemption here. */
export function nodeManifestTurbopackFactories(
  source: NodeManifestTurbopackSource,
): readonly NodeManifestTurbopackFactory[] {
  const table = registration(checkedTurbopackProgram(source));
  const result: NodeManifestTurbopackFactory[] = [];
  appendFactories(table, result, new Set());
  if (result.length === 0) refuseTurbopack('empty factory table');
  return result;
}

export function projectNodeManifestTurbopackFactory(
  source: NodeManifestTurbopackSource,
  id: number,
): NodeManifestTurbopackProjection {
  const factory = nodeManifestTurbopackFactories(source).find((candidate) =>
    candidate.ids.includes(id),
  );
  if (factory === undefined) return refuseTurbopack('unknown module id');
  return projectTurbopackFactory(source, factory, checkedTurbopackProgram(source));
}
