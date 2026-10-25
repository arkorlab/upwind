import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { identifier, propertyName } from './node-manifest-consumer-ast.ts';
import { projectTurbopackFactory, turbopackModuleId } from './node-manifest-turbopack-factory.ts';

export { turbopackModuleId, turbopackModuleSpecifier } from './node-manifest-turbopack-factory.ts';

export type NodeManifestTurbopackModuleId = number | string;

export interface NodeManifestTurbopackSource {
  readonly code: string;
  readonly sha256: string;
}
export interface NodeManifestTurbopackFactory {
  readonly ids: readonly NodeManifestTurbopackModuleId[];
  readonly start: number;
  readonly end: number;
}
export interface NodeManifestTurbopackImport {
  readonly kind: 'import' | 'require' | 'external';
  readonly specifier: string;
  readonly targetId?: NodeManifestTurbopackModuleId;
}
export interface NodeManifestTurbopackCacheInitializer {
  readonly id: NodeManifestTurbopackModuleId;
  readonly start: number;
  readonly end: number;
}
export type NodeManifestTurbopackExports =
  | { readonly kind: 'commonjs' }
  | { readonly kind: 'opaque' }
  | { readonly kind: 'getters'; readonly names: readonly string[] }
  | { readonly kind: 'namespace'; readonly specifier: string };
export interface NodeManifestTurbopackProjection {
  readonly mode: 'strict' | 'dependencies';
  /** Runtime identity selected from this factory's possibly merged registration group. */
  readonly moduleId: NodeManifestTurbopackModuleId;
  readonly original: NodeManifestTurbopackSource;
  readonly factory: NodeManifestTurbopackFactory;
  /** Inspection only. Never write these bytes into the physical Node artifact. */
  readonly source: NodeManifestTurbopackSource;
  readonly imports: readonly NodeManifestTurbopackImport[];
  /** Ordinary cache writes, never independently invocable registered factory IDs. */
  readonly cacheInitializers: readonly NodeManifestTurbopackCacheInitializer[];
  readonly exports: NodeManifestTurbopackExports;
  readonly boundRuntimeInputs: readonly {
    readonly kind: 'require' | 'loadChunk';
    readonly identifier: string;
  }[];
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
  if (!isNode(value) || value.type !== 'ExpressionStatement') return false;
  const expression = value['expression'];
  return (
    isNode(expression) &&
    expression.type === 'Literal' &&
    expression.start === value.start &&
    (expression['raw'] === '"use strict"' || expression['raw'] === "'use strict'")
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

function registration(program: Node): { readonly table: Node; readonly inheritedStrict: boolean } {
  let statements = listOf(program, 'body');
  let inheritedStrict = strictStatement(statements[0]);
  if (inheritedStrict) statements = statements.slice(1);
  const only = statements[0];
  if (statements.length !== 1 || !isNode(only) || only.type !== 'ExpressionStatement')
    return refuseTurbopack('registration statements');
  let expression = only['expression'];
  if (!isNode(expression)) return refuseTurbopack('registration expression');
  if (expression.type === 'CallExpression') {
    expression = strictWrapper(expression, false);
    inheritedStrict = expression !== undefined;
  }
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
  return { table: right, inheritedStrict };
}

function factoryParameters(factory: Node): Node {
  const body = functionBody(factory);
  const params = listOf(factory, 'params');
  if (params.length !== 1 && params.length !== COMMONJS_PARAMETERS)
    refuseTurbopack('factory parameters');
  if (params.some((param) => !identifier(param))) refuseTurbopack('factory parameter binding');
  const names = params.filter(identifier).map((param) => param.name);
  if (new Set(names).size !== params.length) refuseTurbopack('duplicate factory parameter');
  return body;
}

function appendNested(
  node: Node,
  result: NodeManifestTurbopackFactory[],
  known: Set<NodeManifestTurbopackModuleId>,
  inheritedStrict: boolean,
): void {
  if (node.type !== 'ArrayExpression') refuseTurbopack('strict factory table');
  const previous = result.length;
  appendFactories(node, result, known, { allowNested: false, inheritedStrict });
  if (!inheritedStrict && result.length === previous)
    refuseTurbopack('nested table has no strict factory proof');
}

function factoryShape(node: Node): string {
  if (node.type !== 'Literal') return node.type;
  const value = node['value'];
  const length = typeof value === 'string' ? `:${value.length}` : '';
  return `${node.type}:${typeof value}${length}`;
}

interface RegistrationContext {
  readonly allowNested: boolean;
  readonly inheritedStrict: boolean;
}

function nestedTable(
  item: Node,
  index: number,
  context: RegistrationContext,
): { readonly table: Node; readonly inheritedStrict: boolean } | undefined {
  const nested = index === 0 ? strictWrapper(item, true) : undefined;
  if (nested !== undefined) {
    if (!context.allowNested) refuseTurbopack('recursive strict factory tables');
    return { table: nested, inheritedStrict: true };
  }
  if (item.type !== 'ArrayExpression') return undefined;
  if (index !== 0 || !context.allowNested) refuseTurbopack('later or recursive factory table');
  return { table: item, inheritedStrict: context.inheritedStrict };
}

function assertNestedStrict(body: Node, context: RegistrationContext): void {
  if (!context.allowNested && !context.inheritedStrict && !strictStatement(listOf(body, 'body')[0]))
    refuseTurbopack('nested factory lacks strict mode');
}

function appendFactories(
  table: Node,
  result: NodeManifestTurbopackFactory[],
  known: Set<NodeManifestTurbopackModuleId>,
  context: RegistrationContext,
): void {
  let pending: NodeManifestTurbopackModuleId[] = [];
  for (const [index, item] of listOf(table, 'elements').entries()) {
    if (!isNode(item)) refuseTurbopack('factory table hole');
    const nested = nestedTable(item, index, context);
    if (nested !== undefined) {
      appendNested(nested.table, result, known, nested.inheritedStrict);
      continue;
    }
    const id = turbopackModuleId(item);
    if (id !== undefined) {
      if (known.has(id)) refuseTurbopack('duplicate module id');
      known.add(id);
      pending.push(id);
      continue;
    }
    if (pending.length === 0)
      refuseTurbopack(`unbound factory at item ${index} (${factoryShape(item)})`);
    const body = factoryParameters(item);
    assertNestedStrict(body, context);
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
  const { table, inheritedStrict } = registration(checkedTurbopackProgram(source));
  const result: NodeManifestTurbopackFactory[] = [];
  appendFactories(table, result, new Set(), { allowNested: true, inheritedStrict });
  if (result.length === 0) refuseTurbopack('empty factory table');
  return result;
}

export function projectNodeManifestTurbopackFactory(
  source: NodeManifestTurbopackSource,
  id: NodeManifestTurbopackModuleId,
  mode: 'strict' | 'dependencies' = 'strict',
): NodeManifestTurbopackProjection {
  const factory = nodeManifestTurbopackFactories(source).find((candidate) =>
    candidate.ids.includes(id),
  );
  if (factory === undefined) return refuseTurbopack('unknown module id');
  return projectTurbopackFactory(source, factory, checkedTurbopackProgram(source), {
    mode,
    moduleId: id,
  });
}
