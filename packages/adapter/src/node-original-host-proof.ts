import {
  childrenOf,
  isNode,
  listOf,
  scopeOpenedBy,
  type Node,
  type Scope,
} from './lexical-scope.ts';
import { parseNativeSource } from './native-source-parser.ts';
import { hostPropertyName, isCommonJsHost } from './node-closure-hosts.ts';

const HOST_LOADERS: ReadonlySet<string> = new Set(['constructor', 'load', 'require']);

function isIdentifier(value: unknown): boolean {
  return isNode(value) && value.type === 'Identifier';
}

function isLoaderMember(name: string | undefined): boolean {
  return name === undefined || HOST_LOADERS.has(name);
}

function isHostPattern(node: Node, scopes: readonly Scope[]): boolean {
  if (node.type !== 'VariableDeclarator' || !isCommonJsHost(node['init'], scopes)) return false;
  const pattern = node['id'];
  if (!isNode(pattern) || pattern.type !== 'ObjectPattern') return false;
  return listOf(pattern, 'properties').some((property) => {
    return (
      !isNode(property) ||
      property.type === 'RestElement' ||
      isLoaderMember(hostPropertyName(property))
    );
  });
}

function isHostOperation(node: Node, scopes: readonly Scope[]): boolean {
  if (node.type === 'MemberExpression' && isCommonJsHost(node['object'], scopes))
    return isLoaderMember(hostPropertyName(node));
  if (isHostPattern(node, scopes)) return true;
  return (
    node.type === 'AssignmentExpression' &&
    isIdentifier(node['left']) &&
    isCommonJsHost(node['right'], scopes)
  );
}

function registerImports(program: Node, scope: Scope): void {
  for (const statement of listOf(program, 'body')) {
    if (!isNode(statement) || statement.type !== 'ImportDeclaration') continue;
    const specifiers = listOf(statement, 'specifiers');
    for (const specifier of specifiers) {
      const local = isNode(specifier) ? specifier['local'] : undefined;
      if (isNode(local) && local.type === 'Identifier' && typeof local['name'] === 'string')
        scope.declared.add(local['name']);
    }
  }
}

function openedScopes(node: Node, parents: readonly Scope[]): readonly Scope[] {
  const scope = scopeOpenedBy(node);
  if (scope === undefined) return parents;
  if (node.type === 'Program') registerImports(node, scope);
  return [...parents, scope];
}

function childNodes(node: Node): Node[] {
  return childrenOf(node).flatMap((child) => {
    const values: unknown[] = Array.isArray(child) ? child : [child];
    return values.filter((value) => isNode(value));
  });
}

function hasOriginalHostOperation(program: Node): boolean {
  const pending: { node: Node; scopes: readonly Scope[] }[] = [{ node: program, scopes: [] }];
  for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
    const scopes = openedScopes(visit.node, visit.scopes);
    if (isHostOperation(visit.node, scopes)) return true;
    const children = childNodes(visit.node);
    for (const node of children) pending.push({ node, scopes });
  }
  return false;
}

/**
 * A compiler's CommonJS wrapper shadows the real host `module`. Check retained original source
 * too; classified native operations and separately proved manifest VM calls stay independent.
 */
export function originalNodeHostLoaderRefusal(file: string, code: string): string | undefined {
  const program: unknown = parseNativeSource(code, file);
  if (!isNode(program)) throw new TypeError('Original host-loader proof requires a program');
  return hasOriginalHostOperation(program)
    ? 'an unproved original CommonJS host loader'
    : undefined;
}
