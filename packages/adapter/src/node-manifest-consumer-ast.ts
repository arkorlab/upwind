import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, scopeOpenedBy, type Node, type Scope } from './lexical-scope.ts';

export const MANIFEST_CONSUMER_FIELDS = ['__next_app__', 'routeModule', 'handler'] as const;
const ARGUMENT_KEYS = ['tree', 'page', 'pathname', 'require', 'loadChunk', 'interopDefault'];
export interface ConsumerRoute {
  readonly page: string;
  readonly pathname: string;
}
export interface Visit {
  readonly node: Node;
  readonly parent?: Node;
  readonly key?: string;
  readonly scopes: readonly Scope[];
}

export function refuse(reason: string): never {
  throw new AuditError(`Unproved Next.js manifest consumer ${reason}; refusing native publication`);
}

export function identifier(
  value: unknown,
): value is Node & { readonly type: 'Identifier'; readonly name: string } {
  return isNode(value) && value.type === 'Identifier' && typeof value['name'] === 'string';
}

export function stringOf(value: unknown): string | undefined {
  if (!isNode(value)) return undefined;
  if (value.type === 'Literal' && typeof value['value'] === 'string') return value['value'];
  if (value.type !== 'TemplateLiteral' || listOf(value, 'expressions').length > 0) return undefined;
  const parts = listOf(value, 'quasis');
  const part = parts[0];
  if (parts.length !== 1 || !isNode(part)) return undefined;
  const text = part['value'];
  return typeof text === 'object' &&
    text !== null &&
    'cooked' in text &&
    typeof text.cooked === 'string'
    ? text.cooked
    : undefined;
}

export function propertyName(node: Node): string | undefined {
  if (node['computed'] === true) return undefined;
  const key = node['key'] ?? node['property'];
  return identifier(key) ? key.name : stringOf(key);
}

function registerImports(program: Node, scope: Scope): void {
  for (const statement of listOf(program, 'body')) {
    if (!isNode(statement) || statement.type !== 'ImportDeclaration') continue;
    for (const specifier of listOf(statement, 'specifiers')) {
      if (!isNode(specifier) || !identifier(specifier['local'])) continue;
      scope.declared.add(specifier['local'].name);
      scope.bindings.set(specifier['local'].name, specifier);
    }
  }
}

function childrenOf(parent: Node, scopes: readonly Scope[]): Visit[] {
  const children: Visit[] = [];
  for (const [key, child] of Object.entries(parent)) {
    if (key === 'start' || key === 'end') continue;
    const values = Array.isArray(child) ? child : [child];
    for (const node of values) {
      if (isNode(node)) children.push({ node, parent, key, scopes });
    }
  }
  return children;
}

/** A class expression's self-name belongs to its own scope, including its heritage TDZ. */
function namedClassScope(node: Node): Scope | undefined {
  const name = node['id'];
  if (node.type !== 'ClassExpression' || !identifier(name)) return undefined;
  return {
    declared: new Set([name.name]),
    constants: new Set(),
    bindings: new Map([[name.name, node]]),
  };
}

export function visitTree(program: Node): Visit[] {
  const visits: Visit[] = [];
  const pending: Visit[] = [{ node: program, scopes: [] }];
  while (pending.length > 0) {
    const visit = pending.pop();
    if (visit === undefined) break;
    const opened = namedClassScope(visit.node) ?? scopeOpenedBy(visit.node);
    const scopes = opened === undefined ? visit.scopes : [...visit.scopes, opened];
    if (opened !== undefined && visit.node.type === 'Program') registerImports(visit.node, opened);
    visits.push({ ...visit, scopes });
    pending.push(...childrenOf(visit.node, scopes));
  }
  return visits;
}

export function declaration(
  name: string,
  scopes: readonly Scope[],
): { readonly node: Node | undefined } | undefined {
  for (const scope of scopes.toReversed()) {
    if (scope.declared.has(name)) return { node: scope.bindings.get(name) };
  }
  return undefined;
}

export function unwrappedCallee(node: Node): unknown {
  const callee = node['callee'];
  if (!isNode(callee) || callee.type !== 'SequenceExpression') return callee;
  const expressions = listOf(callee, 'expressions');
  const first = expressions[0];
  return expressions.length === 2 &&
    isNode(first) &&
    first.type === 'Literal' &&
    first['value'] === 0
    ? expressions[1]
    : undefined;
}

function exactProperties(value: unknown): Map<string, Node> {
  if (!isNode(value) || value.type !== 'ObjectExpression') return refuse('factory argument');
  const result = new Map<string, Node>();
  for (const property of listOf(value, 'properties')) {
    if (
      !isNode(property) ||
      property.type !== 'Property' ||
      property['kind'] !== 'init' ||
      property['method'] === true
    )
      return refuse('argument property');
    const name = propertyName(property);
    if (name === undefined || result.has(name) || !isNode(property['value']))
      return refuse('argument keys');
    result.set(name, property['value']);
  }
  return result;
}

export function assertArgument(call: Node, route: ConsumerRoute): void {
  const args = listOf(call, 'arguments');
  if (args.length !== 1) refuse('factory arity');
  const properties = exactProperties(args[0]);
  if (
    properties.size !== ARGUMENT_KEYS.length ||
    ARGUMENT_KEYS.some((name) => !properties.has(name))
  )
    refuse('factory fields');
  if (
    stringOf(properties.get('page')) !== route.page ||
    stringOf(properties.get('pathname')) !== route.pathname
  )
    refuse('unsealed route constants');
  for (const name of ['tree', 'require', 'loadChunk']) {
    if (!identifier(properties.get(name))) refuse('non-template factory input');
  }
  const interop = properties.get('interopDefault');
  if (
    !identifier(interop) &&
    !(
      isNode(interop) &&
      interop.type === 'MemberExpression' &&
      identifier(interop['object']) &&
      propertyName(interop) === 'interopDefault'
    )
  )
    refuse('non-template interop input');
}

function astShape(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) =>
    ['end', 'raw', 'start'].includes(key) ? undefined : item,
  );
}

function expression(source: string): unknown {
  const program: unknown = parseAst(source);
  const first = isNode(program) ? listOf(program, 'body')[0] : undefined;
  if (!isNode(first)) return undefined;
  return first.type === 'ExpressionStatement' ? first['expression'] : first;
}

/** Exact export helpers in the published next@16.4.3 app-page.js template. */
export function swcHelper(node: unknown, star = false): boolean {
  const template = star
    ? 'function _export_star(from,to){Object.keys(from).forEach(function(k){if(k!=="default"&&!Object.prototype.hasOwnProperty.call(to,k)){Object.defineProperty(to,k,{enumerable:true,get:function(){return from[k]}})}});return from;}'
    : 'function _export(target,all){for(var name in all)Object.defineProperty(target,name,{enumerable:true,get:all[name]});}';
  return astShape(node) === astShape(expression(template));
}

export function getterValue(property: unknown): Node | undefined {
  if (
    !isNode(property) ||
    property.type !== 'Property' ||
    property['method'] === true ||
    property['computed'] === true ||
    property['kind'] !== 'init'
  )
    return undefined;
  const fn = property['value'];
  if (
    !isNode(fn) ||
    fn.type !== 'FunctionExpression' ||
    fn['async'] === true ||
    fn['generator'] === true ||
    listOf(fn, 'params').length > 0
  )
    return undefined;
  const body = fn['body'];
  const statements = isNode(body) ? listOf(body, 'body') : [];
  const statement = statements[0];
  return statements.length === 1 &&
    isNode(statement) &&
    statement.type === 'ReturnStatement' &&
    isNode(statement['argument'])
    ? statement['argument']
    : undefined;
}

export function getterExport(
  value: Node,
  parents: ReadonlyMap<Node, Visit>,
): { readonly call: Node; readonly field: string } | undefined {
  const returned = parents.get(value)?.parent;
  if (returned?.type !== 'ReturnStatement') return undefined;
  const body = parents.get(returned)?.parent;
  const parentOf = (node: Node | undefined): Node | undefined =>
    node === undefined ? undefined : parents.get(node)?.parent;
  const fn = parentOf(body);
  const property = parentOf(fn);
  const object = parentOf(property);
  const call = parentOf(object);
  if (
    property === undefined ||
    getterValue(property) !== value ||
    object?.type !== 'ObjectExpression' ||
    call?.type !== 'CallExpression' ||
    listOf(call, 'arguments')[1] !== object
  )
    return undefined;
  const field = propertyName(property);
  return field === undefined ? undefined : { call, field };
}

export function isProgramCall(node: Node, parents: ReadonlyMap<Node, Visit>): boolean {
  const statement = parents.get(node)?.parent;
  return (
    statement?.type === 'ExpressionStatement' && parents.get(statement)?.parent?.type === 'Program'
  );
}

export function swcHeader(call: Node): boolean {
  return (
    astShape(call) ===
    astShape(expression('Object.defineProperty(exports,"__esModule",{value:true});'))
  );
}

export function swcDeadAnnotation(node: Node): boolean {
  return (
    astShape(node) ===
    astShape(expression('0&&(module.exports={__next_app__:null,handler:null,routeModule:null});'))
  );
}

export function reference(visit: Visit): boolean {
  const { parent, key } = visit;
  if (parent === undefined) return false;
  if (
    ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ImportSpecifier'].includes(parent.type)
  )
    return false;
  if (key === 'id' && parent.type === 'VariableDeclarator') return false;
  if (
    key === 'label' &&
    ['BreakStatement', 'ContinueStatement', 'LabeledStatement'].includes(parent.type)
  )
    return false;
  if (
    ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(
      parent.type,
    ) &&
    (key === 'id' || key === 'params')
  )
    return false;
  if (key === 'property' && parent.type === 'MemberExpression' && parent['computed'] !== true)
    return false;
  if (
    key === 'key' &&
    parent.type === 'Property' &&
    parent['computed'] !== true &&
    parent['shorthand'] !== true
  )
    return false;
  return parent.type !== 'ExportSpecifier' || key !== 'exported';
}
