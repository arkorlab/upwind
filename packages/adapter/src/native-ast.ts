import path from 'node:path';

import type { Node } from '@oxc-project/types';

import { scopeOpenedBy, type Node as ScopeNode, type Scope } from './lexical-scope.ts';

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

type AssignmentNode = Extract<Node, { type: 'AssignmentExpression' | 'UpdateExpression' }>;
function isAssignment(node: Node): node is AssignmentNode {
  return ['AssignmentExpression', 'UpdateExpression'].includes(node.type);
}

function assignmentBinds(node: Node, name: string, members: boolean): boolean {
  if (node.type === 'UnaryExpression' && node.operator === 'delete')
    return patternNames(node.argument, members).includes(name);
  if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    const target = node.left;
    return target.type === 'VariableDeclaration'
      ? target.declarations.some((entry) => patternNames(entry.id, members).includes(name))
      : patternNames(target, members).includes(name);
  }
  if (!isAssignment(node)) return false;
  const target = node.type === 'AssignmentExpression' ? node.left : node.argument;
  return patternNames(target, members).includes(name);
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

interface NativeScope {
  readonly scope: Scope;
  readonly parent: NativeScope | undefined;
}

export interface NativeBindings {
  readonly moduleSyntax: boolean;
  /** Undefined means global; null means a declared parameter or another opaque local binding. */
  readonly lookup: (node: Node, name: string) => Node | null | undefined;
  readonly importSource: (node: Node) => string | undefined;
  readonly unmodified: (node: Node, name: string, members: boolean) => boolean;
}

function importSources(program: Node): ReadonlyMap<Node, string> {
  const sources = new Map<Node, string>();
  if (program.type !== 'Program') return sources;
  for (const declaration of program.body) {
    if (declaration.type !== 'ImportDeclaration') continue;
    const source = stringOf(declaration.source);
    if (source === undefined) continue;
    for (const specifier of declaration.specifiers) sources.set(specifier, source);
  }
  return sources;
}

function openedNativeScope(node: Node, parent: NativeScope | undefined): NativeScope | undefined {
  // The shared scope visitor reads this same ESTree syntax without changing its nodes.
  const scope = namedClassScope(node) ?? scopeOpenedBy(node as unknown as ScopeNode);
  if (scope === undefined) return parent;
  if (node.type === 'Program') {
    for (const declaration of node.body) {
      if (declaration.type !== 'ImportDeclaration') continue;
      for (const specifier of declaration.specifiers) {
        scope.declared.add(specifier.local.name);
        scope.bindings.set(specifier.local.name, specifier as unknown as ScopeNode);
      }
    }
  }
  return { scope, parent };
}

function namedClassScope(node: Node): Scope | undefined {
  if ((node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') || node.id === null)
    return undefined;
  return {
    declared: new Set([node.id.name]),
    constants: new Set(),
    bindings: new Map([[node.id.name, node as unknown as ScopeNode]]),
  };
}

function bindingScope(scope: NativeScope | undefined, name: string): NativeScope | undefined {
  for (let at = scope; at !== undefined; at = at.parent) {
    if (at.scope.declared.has(name)) return at;
  }
  return undefined;
}

function nativeBinding(scope: NativeScope | undefined, name: string): Node | null | undefined {
  const found = bindingScope(scope, name);
  return found === undefined
    ? undefined
    : ((found.scope.bindings.get(name) as Node | undefined) ?? null);
}

function patternChildren(pattern: Node, members: boolean): Node[] {
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- Non-binding AST kinds intentionally use the leaf/member default.
  switch (pattern.type) {
    case 'ObjectPattern': {
      return pattern.properties.map((property) =>
        property.type === 'Property' ? property.value : property.argument,
      );
    }
    case 'ArrayPattern': {
      return pattern.elements.filter((element) => element !== null);
    }
    case 'RestElement': {
      return [pattern.argument];
    }
    case 'AssignmentPattern': {
      return [pattern.left];
    }
    default: {
      return members && pattern.type === 'MemberExpression' ? [pattern.object] : [];
    }
  }
}

function patternNames(pattern: Node, members = false): string[] {
  const names: string[] = [];
  const pending: Node[] = [pattern];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'Identifier') names.push(node.name);
    else for (const child of patternChildren(node, members).toReversed()) pending.push(child);
  }
  return names;
}

function recordPatterns(scopes: ReadonlyMap<Node, NativeScope | undefined>): void {
  for (const [node, scope] of scopes) {
    if (node.type !== 'VariableDeclarator') continue;
    for (const name of patternNames(node.id)) {
      const owner = bindingScope(scope, name);
      if (owner !== undefined && !owner.scope.bindings.has(name))
        owner.scope.bindings.set(name, node as unknown as ScopeNode);
    }
  }
}

function initializesBinding(
  node: Node,
  name: string,
  declaration: Node | null | undefined,
): boolean {
  return (
    node.type === 'VariableDeclarator' &&
    node !== declaration &&
    node.init !== null &&
    patternNames(node.id).includes(name)
  );
}

/** Resolve a native operation's own scope; unrelated parameters must not hide a global load. */
export function nativeBindings(program: Node): NativeBindings {
  const sources = importSources(program);
  const scopes = new Map<Node, NativeScope | undefined>();
  const unchanged = new Map<NativeScope | undefined, Map<string, boolean>>();
  let moduleSyntax =
    program.type === 'Program' &&
    program.body.some((node) => node.type.startsWith('Import') || node.type.startsWith('Export'));
  const pending: { node: Node; parent: NativeScope | undefined }[] = [
    { node: program, parent: undefined },
  ];
  for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
    if (visit.node.type === 'MetaProperty' && identifier(visit.node.meta, 'import'))
      moduleSyntax = true;
    const scope = openedNativeScope(visit.node, visit.parent);
    scopes.set(visit.node, scope);
    for (const child of nodes(visit.node)) pending.push({ node: child, parent: scope });
  }
  recordPatterns(scopes);
  return {
    moduleSyntax,
    lookup: (node, name) => nativeBinding(scopes.get(node), name),
    importSource: (node) => sources.get(node),
    unmodified(node, name, members) {
      const binding = bindingScope(scopes.get(node), name);
      const key = members ? `${name}:members` : `${name}:binding`;
      const cached = unchanged.get(binding)?.get(key);
      if (cached !== undefined) return cached;
      const declaration = nativeBinding(scopes.get(node), name);
      let result = true;
      for (const [candidate, scope] of scopes) {
        if (
          (assignmentBinds(candidate, name, members) ||
            initializesBinding(candidate, name, declaration)) &&
          bindingScope(scope, name) === binding
        ) {
          result = false;
          break;
        }
      }
      const checks = unchanged.get(binding) ?? new Map<string, boolean>();
      checks.set(key, result);
      unchanged.set(binding, checks);
      return result;
    },
  };
}

function realPathBinding(node: Node, bindings: NativeBindings): boolean {
  const binding = bindings.lookup(node, 'path');
  if (binding?.type !== 'VariableDeclarator' || binding.init === null) return false;
  if (!identifier(binding.id, 'path')) return false;
  if (!['node:path', 'path'].includes(required(binding.init) ?? '')) return false;
  if (
    bindings.lookup(binding.init, 'require') !== undefined ||
    !bindings.unmodified(binding.init, 'require', false)
  )
    return false;
  return bindings.unmodified(node, 'path', true);
}

export function nativePath(
  node: Node | undefined,
  importer: string,
  bindings: NativeBindings,
): string | undefined {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return undefined;
  const { object, property, computed } = node.callee;
  if (
    computed ||
    property.type !== 'Identifier' ||
    !identifier(object, 'path') ||
    !realPathBinding(node, bindings) ||
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
