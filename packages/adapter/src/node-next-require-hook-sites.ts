import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node } from './lexical-scope.ts';
import {
  declaration,
  identifier,
  reference,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';

export interface NodeNextRequireHookSites {
  readonly operations: ReadonlySet<Node>;
  readonly namespaceOperands: ReadonlySet<Node>;
}
const MAX_NODES = 100_000;
const BIND_ARGUMENTS = 3;
const RESOLVER_PARAMETERS = 6;
function dot(value: unknown, name: string): value is Node {
  return (
    isNode(value) &&
    value.type === 'MemberExpression' &&
    value['computed'] !== true &&
    value['optional'] !== true &&
    identifier(value['property']) &&
    value['property'].name === name
  );
}
function literal(value: unknown, expected: unknown): boolean {
  return isNode(value) && value.type === 'Literal' && value['value'] === expected;
}
function shape(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) =>
    ['end', 'raw', 'start'].includes(key) ? undefined : item,
  );
}
function expression(code: string): unknown {
  const first = parseAst(`(${code});`).body[0];
  return first?.type === 'ExpressionStatement' ? first.expression : undefined;
}
function nameOf(declarator: Node): string | undefined {
  return identifier(declarator['id']) ? declarator['id'].name : undefined;
}
function owns(value: unknown, owner: Node, byNode: ReadonlyMap<Node, Visit>): boolean {
  if (!identifier(value)) return false;
  const visit = byNode.get(value);
  return visit !== undefined && declaration(value.name, visit.scopes)?.node === owner;
}
function builtinDeclaration(all: readonly Visit[], specifier: string): Node | undefined {
  const found = all.filter(({ node, scopes }) => {
    const init = node['init'];
    return (
      node.type === 'VariableDeclarator' &&
      identifier(node['id']) &&
      isNode(init) &&
      init.type === 'CallExpression' &&
      init['optional'] !== true &&
      identifier(init['callee']) &&
      init['callee'].name === 'require' &&
      declaration('require', scopes) === undefined &&
      listOf(init, 'arguments').length === 1 &&
      literal(listOf(init, 'arguments')[0], specifier)
    );
  });
  return found.length === 1 ? found[0]?.node : undefined;
}
function capture(
  all: readonly Visit[],
  mod: Node,
  property: string,
  byNode: ReadonlyMap<Node, Visit>,
): Node | undefined {
  const found = all.filter(({ node }) => {
    const init = node['init'];
    if (node.type !== 'VariableDeclarator' || !identifier(node['id']) || !dot(init, property))
      return false;
    const object = init['object'];
    return property === 'require'
      ? dot(object, 'prototype') && owns(object['object'], mod, byNode)
      : owns(object, mod, byNode);
  });
  return found.length === 1 ? found[0]?.node : undefined;
}
function uniqueReplacement(
  all: readonly Visit[],
  mod: Node,
  property: string,
  byNode: ReadonlyMap<Node, Visit>,
): Node | undefined {
  const found = all.filter(({ node }) => {
    const left = node['left'];
    if (node.type !== 'AssignmentExpression' || node['operator'] !== '=' || !dot(left, property))
      return false;
    const object = left['object'];
    return property === 'require'
      ? dot(object, 'prototype') && owns(object['object'], mod, byNode)
      : owns(object, mod, byNode);
  });
  return found.length === 1 ? found[0]?.node : undefined;
}
function stableDeclaration(owner: Node, all: readonly Visit[]): boolean {
  const name = nameOf(owner);
  if (name === undefined) return false;
  return all.every((visit) => {
    if (
      !identifier(visit.node) ||
      visit.node.name !== name ||
      declaration(name, visit.scopes)?.node !== owner
    )
      return true;
    const parent = visit.parent;
    if (parent?.type === 'VariableDeclarator') return visit.key === 'id' && parent === owner;
    if (parent?.type === 'AssignmentExpression') return visit.key !== 'left';
    return (
      parent?.type !== 'UpdateExpression' &&
      parent?.type !== 'ArrayPattern' &&
      parent?.type !== 'ObjectPattern' &&
      parent?.type !== 'RestElement' &&
      parent?.type !== 'AssignmentPattern'
    );
  });
}
function boundResolver(
  replacement: Node,
  original: Node,
  byNode: ReadonlyMap<Node, Visit>,
): { fn: Node; map: Node } | undefined {
  const bound = replacement['right'];
  if (
    !isNode(bound) ||
    bound.type !== 'CallExpression' ||
    bound['optional'] === true ||
    !dot(bound['callee'], 'bind')
  )
    return undefined;
  const fn = bound['callee']['object'];
  const args = listOf(bound, 'arguments');
  if (
    !isNode(fn) ||
    fn.type !== 'FunctionExpression' ||
    !literal(args[0], null) ||
    args.length !== BIND_ARGUMENTS ||
    !owns(args[1], original, byNode)
  )
    return undefined;
  const map = mapDeclaration(args[2], byNode);
  return map === undefined ? undefined : { fn, map };
}
function mapDeclaration(value: unknown, byNode: ReadonlyMap<Node, Visit>): Node | undefined {
  if (!identifier(value)) return undefined;
  const map = declaration(value.name, byNode.get(value)?.scopes ?? [])?.node;
  const init = map?.['init'];
  return map?.type === 'VariableDeclarator' &&
    isNode(init) &&
    init.type === 'NewExpression' &&
    identifier(init['callee']) &&
    init['callee'].name === 'Map' &&
    listOf(init, 'arguments').length === 0 &&
    declaration('Map', byNode.get(init)?.scopes ?? []) === undefined
    ? map
    : undefined;
}
function resolverBody(
  replacement: Node,
  mod: Node,
  original: Node,
  byNode: ReadonlyMap<Node, Visit>,
): { fn: Node; map: Node; operand: Node } | undefined {
  const bound = boundResolver(replacement, original, byNode);
  if (bound === undefined) return undefined;
  const { fn, map } = bound;
  const params = listOf(fn, 'params');
  if (params.length !== RESOLVER_PARAMETERS || !params.every(identifier)) return undefined;
  const names = params.map((param) => param.name);
  const local = isNode(fn['body']) ? listOf(fn['body'], 'body')[0] : undefined;
  const first = isNode(local) ? listOf(local, 'declarations')[0] : undefined;
  if (!isNode(first) || !identifier(first['id'])) return undefined;
  const [resolve, requestMap, request, parent, isMain, options] = names;
  const temp = first['id'].name;
  const modName = nameOf(mod);
  const expected = `function(${names.join(',')}){const ${temp}=${requestMap}.get(${request});if(${temp})${request}=${temp};return ${resolve}.call(${modName},${request},${parent},${isMain},${options});}`;
  if (shape(fn) !== shape(expression(expected))) return undefined;
  const operands = [...byNode.values()].filter((visit) => {
    return (
      identifier(visit.node) &&
      visit.node.name === modName &&
      owns(visit.node, mod, byNode) &&
      visit.parent?.type === 'CallExpression' &&
      listOf(visit.parent, 'arguments')[0] === visit.node
    );
  });
  return operands.length === 1 && operands[0] !== undefined
    ? { fn, map, operand: operands[0].node }
    : undefined;
}
function requireBody(
  replacement: Node,
  path: Node,
  original: Node,
  byNode: ReadonlyMap<Node, Visit>,
): boolean {
  const fn = replacement['right'];
  if (!isNode(fn) || fn.type !== 'FunctionExpression') return false;
  const params = listOf(fn, 'params');
  const request = params[0];
  if (params.length !== 1 || !identifier(request)) return false;
  const originalName = nameOf(original);
  const pathName = nameOf(path);
  if (originalName === undefined || pathName === undefined) return false;
  const prefix = 'next/dist/server/route-modules/pages/vendored/contexts/';
  const expected = `function(${request.name}){if(${request.name}.endsWith(".shared-runtime")){return ${originalName}.call(this,\`${prefix}\${${pathName}.basename(${request.name},".shared-runtime")}\`);}return ${originalName}.call(this,${request.name});}`;
  if (shape(fn) !== shape(expression(expected))) return false;
  const calls = [...byNode.values()].filter(
    ({ node }) => dot(node, 'call') && owns(node['object'], original, byNode),
  );
  const paths = [...byNode.values()].filter(
    ({ node }) => dot(node, 'basename') && owns(node['object'], path, byNode),
  );
  return calls.length === 2 && paths.length === 1;
}
function privateLoaderUses(
  owner: Node,
  all: readonly Visit[],
  byNode: ReadonlyMap<Node, Visit>,
  allowed: (visit: Visit) => boolean,
): boolean {
  return all.every(
    (visit) => !owns(visit.node, owner, byNode) || !reference(visit) || allowed(visit),
  );
}

interface HookRoles {
  readonly mod: Node;
  readonly path: Node;
  readonly original: Node;
  readonly require: Node;
  readonly resolveReplacement: Node;
  readonly requireReplacement: Node;
}
function hookRoles(all: readonly Visit[], byNode: ReadonlyMap<Node, Visit>): HookRoles | undefined {
  const mod = builtinDeclaration(all, 'module');
  const path = builtinDeclaration(all, 'path');
  if (mod === undefined || path === undefined) return undefined;
  const original = capture(all, mod, '_resolveFilename', byNode);
  const require = capture(all, mod, 'require', byNode);
  const resolveReplacement = uniqueReplacement(all, mod, '_resolveFilename', byNode);
  const requireReplacement = uniqueReplacement(all, mod, 'require', byNode);
  if (
    original === undefined ||
    require === undefined ||
    resolveReplacement === undefined ||
    requireReplacement === undefined
  )
    return undefined;
  return { mod, path, original, require, resolveReplacement, requireReplacement };
}

function checkedResolver(
  roles: HookRoles,
  all: readonly Visit[],
  byNode: ReadonlyMap<Node, Visit>,
): ReturnType<typeof resolverBody> {
  const { mod, path, original, require, resolveReplacement, requireReplacement } = roles;
  const resolver = resolverBody(resolveReplacement, mod, original, byNode);
  if (
    resolver === undefined ||
    !requireBody(requireReplacement, path, require, byNode) ||
    [mod, path, original, require, resolver.map].some((owner) => !stableDeclaration(owner, all))
  )
    return undefined;
  const bound = resolveReplacement['right'];
  if (
    !isNode(bound) ||
    !privateLoaderUses(
      original,
      all,
      byNode,
      ({ node }) => listOf(bound, 'arguments')[1] === node,
    ) ||
    !privateLoaderUses(
      require,
      all,
      byNode,
      ({ node, parent }) => dot(parent, 'call') && parent['object'] === node,
    )
  )
    return undefined;
  return resolver;
}

function hookOperations(
  roles: HookRoles,
  all: readonly Visit[],
  byNode: ReadonlyMap<Node, Visit>,
): ReadonlySet<Node> | undefined {
  const { original, require, resolveReplacement, requireReplacement } = roles;
  const operations = new Set<Node>();
  for (const value of [
    original['init'],
    require['init'],
    resolveReplacement['left'],
    requireReplacement['left'],
  ]) {
    if (!isNode(value)) return undefined;
    operations.add(value);
    if (dot(value['object'], 'prototype')) operations.add(value['object']);
  }
  for (const { node } of all)
    if (dot(node, 'call') && owns(node['object'], require, byNode)) operations.add(node);
  return operations;
}

/** Exact operation DATA only; a private fixed-source/default-loader proof remains mandatory. */
export function nodeNextStaticRequireHookSites(
  program: unknown,
): NodeNextRequireHookSites | undefined {
  if (!isNode(program)) return undefined;
  const all = visitTree(program);
  if (all.length > MAX_NODES || all.some(({ node }) => node.type === 'WithStatement'))
    return undefined;
  const byNode = new Map(all.map((visit) => [visit.node, visit]));
  const roles = hookRoles(all, byNode);
  if (roles === undefined) return undefined;
  const resolver = checkedResolver(roles, all, byNode);
  const operations = hookOperations(roles, all, byNode);
  if (resolver === undefined || operations === undefined) return undefined;
  const namespaceOperands = new Set([resolver.operand]);
  for (const visit of all) {
    if (
      namespaceOperands.has(visit.node) ||
      !owns(visit.node, roles.mod, byNode) ||
      !reference(visit)
    )
      continue;
    if (
      visit.parent?.type !== 'MemberExpression' ||
      visit.key !== 'object' ||
      !operations.has(visit.parent)
    )
      return undefined;
  }
  return Object.freeze({ operations, namespaceOperands });
}
