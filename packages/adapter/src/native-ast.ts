import path from 'node:path';

import type { Node } from '@oxc-project/types';

function nodes(node: Node): Node[] {
  const found: Node[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) found.push(item);
    } else if (isNode(value)) found.push(value);
  }
  return found;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

export function walk(node: Node): Node[] {
  const found: Node[] = [];
  const pending: Node[] = [node];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    found.push(at);
    for (const child of nodes(at)) pending.push(child);
  }
  return found;
}

export function stringOf(node: Node | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

export function identifier(node: Node | undefined, name: string): boolean {
  return node?.type === 'Identifier' && node.name === name;
}

type FunctionNode = Extract<
  Node,
  { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression' }
>;
function hasParameters(node: Node): node is FunctionNode {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(
    node.type,
  );
}

function patternBinds(node: Node, name: string): boolean {
  return walk(node).some((part) => identifier(part, name));
}

function parameterBinds(node: Node, name: string): boolean {
  return hasParameters(node) && node.params.some((param) => patternBinds(param, name));
}

type NamedDeclaration = Extract<
  Node,
  { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ClassDeclaration' | 'ClassExpression' }
>;
function hasDeclaredName(node: Node): node is NamedDeclaration {
  return [
    'FunctionDeclaration',
    'FunctionExpression',
    'ClassDeclaration',
    'ClassExpression',
  ].includes(node.type);
}

function declarationBinds(node: Node, name: string): boolean {
  return hasDeclaredName(node) && identifier(node.id ?? undefined, name);
}

function nodeBinds(node: Node, name: string): boolean {
  switch (node.type) {
    case 'VariableDeclarator':
      return patternBinds(node.id, name);
    case 'CatchClause':
      return node.param !== null && patternBinds(node.param, name);
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return identifier(node.local, name);
    default:
      return declarationBinds(node, name) || parameterBinds(node, name);
  }
}

/** Deliberately narrow: shadowed loader/global bindings are not native proof. */
export function binds(tree: readonly Node[], name: string): boolean {
  return tree.some((node) => nodeBinds(node, name));
}

type AssignmentNode = Extract<Node, { type: 'AssignmentExpression' | 'UpdateExpression' }>;
function isAssignment(node: Node): node is AssignmentNode {
  return ['AssignmentExpression', 'UpdateExpression'].includes(node.type);
}

function assignmentBinds(node: Node, name: string, members: boolean): boolean {
  if (!isAssignment(node)) return false;
  const target = node.type === 'AssignmentExpression' ? node.left : node.argument;
  if (!members && target.type === 'MemberExpression') return false;
  return patternBinds(target, name);
}

export function required(node: Node): string | undefined {
  return node.type === 'CallExpression' &&
    identifier(node.callee, 'require') &&
    node.arguments.length === 1
    ? stringOf(node.arguments[0])
    : undefined;
}

export function workerModule(node: Node): boolean {
  return ['node:worker_threads', 'worker_threads'].includes(required(node) ?? '');
}

export function unchangedBinding(tree: readonly Node[], name: string): boolean {
  return !tree.some((node) => {
    if (
      ['FunctionDeclaration', 'ClassDeclaration'].includes(node.type) &&
      declarationBinds(node, name)
    )
      return true;
    return assignmentBinds(node, name, true) || parameterBinds(node, name);
  });
}

export function unassignedIdentifier(tree: readonly Node[], name: string): boolean {
  return !tree.some((node) => assignmentBinds(node, name, false));
}

function realPathBinding(tree: readonly Node[]): boolean {
  const bindings = tree.filter(
    (node) => node.type === 'VariableDeclarator' && identifier(node.id, 'path'),
  );
  if (bindings.length !== 1) return false;
  const binding = bindings[0];
  if (binding?.type !== 'VariableDeclarator' || binding.init === null) return false;
  if (!['path', 'node:path'].includes(required(binding.init) ?? '')) return false;
  return !tree.some((node) => assignmentBinds(node, 'path', true) || parameterBinds(node, 'path'));
}

export function nativePath(
  node: Node | undefined,
  importer: string,
  tree: readonly Node[],
): string | undefined {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return undefined;
  const { object, property, computed } = node.callee;
  if (
    !identifier(object, 'path') ||
    !realPathBinding(tree) ||
    computed ||
    property.type !== 'Identifier' ||
    !['join', 'resolve'].includes(property.name)
  )
    return undefined;
  if (!identifier(node.arguments[0], '__dirname')) return undefined;
  const parts = node.arguments.slice(1).map((part) => stringOf(part));
  if (parts.some((part) => part === undefined || path.isAbsolute(part))) return undefined;
  const tail = parts as string[];
  return property.name === 'join'
    ? path.join(path.dirname(importer), ...tail)
    : path.resolve(path.dirname(importer), ...tail);
}
