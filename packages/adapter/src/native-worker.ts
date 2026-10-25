import type { Node } from '@oxc-project/types';

import type { NativeAddonEntryTrace } from './native-addons.ts';
import { type NativeBindings, stringOf, workerModule } from './native-ast.ts';
import type { NativeEdit } from './native-operations.ts';
import { ownedNativeFiles } from './native-ownership.ts';

type WorkerOrigin = 'constructor' | 'namespace' | 'module' | 'promise' | 'ambiguous';
const IMPORTS = new WeakMap<readonly Node[], ReadonlyMap<Node, WorkerOrigin>>();
const PROMISE_METHODS: ReadonlySet<string> = new Set(['catch', 'finally', 'then']);
interface WorkerContext {
  readonly bindings: NativeBindings;
  readonly imports: ReadonlyMap<Node, WorkerOrigin>;
}

function importedWorkers(
  node: Extract<Node, { type: 'ImportDeclaration' }>,
  imports: Map<Node, WorkerOrigin>,
): void {
  if (!['node:worker_threads', 'worker_threads'].includes(stringOf(node.source) ?? '')) return;
  for (const specifier of node.specifiers) {
    const selected = specifier.type === 'ImportSpecifier' ? specifier.imported : undefined;
    const name = selected?.type === 'Identifier' ? selected.name : stringOf(selected);
    if (name === 'default' || specifier.type === 'ImportDefaultSpecifier')
      imports.set(specifier, 'namespace');
    if (specifier.type === 'ImportNamespaceSpecifier') imports.set(specifier, 'module');
    if (name === 'Worker') imports.set(specifier, 'constructor');
  }
}

function workerImports(tree: readonly Node[]): ReadonlyMap<Node, WorkerOrigin> {
  const cached = IMPORTS.get(tree);
  if (cached !== undefined) return cached;
  const imports = new Map<Node, WorkerOrigin>();
  for (const node of tree) {
    if (node.type === 'ImportDeclaration') importedWorkers(node, imports);
  }
  IMPORTS.set(tree, imports);
  return imports;
}

function isNamespace(origin: WorkerOrigin | undefined): boolean {
  return origin === 'namespace' || origin === 'module';
}

function memberKey(member: Extract<Node, { type: 'MemberExpression' }>): string | undefined {
  if (member.computed) return stringOf(member.property);
  return member.property.type === 'Identifier' ? member.property.name : undefined;
}

function memberOrigin(
  member: Extract<Node, { type: 'MemberExpression' }>,
  owner: WorkerOrigin | undefined,
): WorkerOrigin | undefined {
  if (owner === 'ambiguous') return owner;
  const property = memberKey(member);
  if (owner === 'promise')
    return property === undefined || PROMISE_METHODS.has(property) ? 'ambiguous' : undefined;
  if (!isNamespace(owner)) return undefined;
  if (owner === 'module' && property === 'default') return 'namespace';
  return property === 'Worker' || (property === undefined && member.computed)
    ? 'constructor'
    : undefined;
}

function propertyOrigin(
  property: Extract<Node, { type: 'Property' }>,
  owner: WorkerOrigin,
): WorkerOrigin | undefined {
  const key =
    property.computed || property.key.type !== 'Identifier'
      ? stringOf(property.key)
      : property.key.name;
  if (owner === 'promise')
    return key === undefined || PROMISE_METHODS.has(key) ? 'ambiguous' : undefined;
  if (!isNamespace(owner)) return 'ambiguous';
  if (key === undefined) return 'ambiguous';
  if (key === 'Worker') return 'constructor';
  return owner === 'module' && key === 'default' ? 'namespace' : undefined;
}

function arrayOrigin(elements: readonly (Node | null)[], name: string): WorkerOrigin | undefined {
  for (const element of elements) {
    if (element === null) continue;
    const found = bindingOrigin(element, name, 'ambiguous');
    if (found !== undefined) return found;
  }
  return undefined;
}

function objectOrigin(
  pattern: Extract<Node, { type: 'ObjectPattern' }>,
  name: string,
  owner: WorkerOrigin,
): WorkerOrigin | undefined {
  for (const property of pattern.properties) {
    const value = property.type === 'Property' ? property.value : property.argument;
    const origin = property.type === 'Property' ? propertyOrigin(property, owner) : owner;
    if (origin === undefined) continue;
    const found = bindingOrigin(value, name, origin);
    if (found !== undefined) return found;
  }
  return undefined;
}

function bindingOrigin(
  pattern: Node,
  name: string,
  origin: WorkerOrigin,
): WorkerOrigin | undefined {
  let binding = pattern;
  while (binding.type === 'AssignmentPattern' || binding.type === 'RestElement')
    binding = binding.type === 'AssignmentPattern' ? binding.left : binding.argument;
  if (binding.type === 'Identifier') return binding.name === name ? origin : undefined;
  if (binding.type === 'ArrayPattern') return arrayOrigin(binding.elements, name);
  if (binding.type === 'ObjectPattern') return objectOrigin(binding, name, origin);
  return undefined;
}

function stableOrigin(
  origin: WorkerOrigin | undefined,
  node: Extract<Node, { type: 'Identifier' }>,
  context: WorkerContext,
): WorkerOrigin | undefined {
  return (origin === 'promise' || isNamespace(origin)) &&
    !context.bindings.unmodified(node, node.name, true)
    ? 'ambiguous'
    : origin;
}

function declaredOrigin(
  node: Extract<Node, { type: 'Identifier' }>,
  context: WorkerContext,
  seen: ReadonlySet<Node>,
): WorkerOrigin | undefined {
  const declaration = context.bindings.lookup(node, node.name);
  if (declaration === undefined || declaration === null) return undefined;
  const imported = context.imports.get(declaration);
  if (imported !== undefined) return stableOrigin(imported, node, context);
  if (declaration.type !== 'VariableDeclarator' || declaration.init === null) return undefined;
  const origin = workerOrigin(declaration.init, context, seen);
  const found = origin === undefined ? undefined : bindingOrigin(declaration.id, node.name, origin);
  return stableOrigin(found, node, context);
}

function workerOrigin(
  node: Node,
  context: WorkerContext,
  seen: ReadonlySet<Node> = new Set(),
): WorkerOrigin | undefined {
  if (seen.has(node)) return undefined;
  const next = new Set([...seen, node]);
  if (node.type === 'Identifier') return declaredOrigin(node, context, next);
  if (
    node.type === 'ImportExpression' &&
    ['node:worker_threads', 'worker_threads'].includes(stringOf(node.source) ?? '')
  )
    return 'promise';
  if (node.type === 'AwaitExpression') {
    const origin = workerOrigin(node.argument, context, next);
    return origin === 'promise' ? 'module' : origin;
  }
  if (workerModule(node) && context.bindings.lookup(node, 'require') === undefined)
    return 'namespace';
  if (node.type === 'MemberExpression')
    return memberOrigin(node, workerOrigin(node.object, context, next));
  return undefined;
}

function invokedCapability(
  node: Extract<Node, { type: 'CallExpression' | 'NewExpression' }>,
  context: WorkerContext,
): Node | undefined {
  if (node.callee.type === 'MemberExpression') {
    const receiver = node.callee.object;
    const owner = workerOrigin(receiver, context);
    if (owner === 'constructor' || owner === 'ambiguous') return receiver;
    const method = memberKey(node.callee);
    if (owner === 'promise' && (method === undefined || PROMISE_METHODS.has(method)))
      return receiver;
  }
  const origin = workerOrigin(node.callee, context);
  if (origin === 'constructor' || origin === 'ambiguous')
    return node.callee.type === 'MemberExpression' ? node.callee.object : node.callee;
  for (const argument of node.arguments) {
    const value = argument.type === 'SpreadElement' ? argument.argument : argument;
    if (workerOrigin(value, context) !== undefined) return value;
  }
  return undefined;
}

export async function nativeWorkerEdit(
  node: Node,
  context: {
    readonly source: string;
    readonly importer: string;
    readonly traces: readonly NativeAddonEntryTrace[];
    readonly tree: readonly Node[];
    readonly bindings: NativeBindings;
    markChild(binaries: readonly string[]): string;
  },
): Promise<NativeEdit | undefined> {
  if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return undefined;
  const target = invokedCapability(node, {
    bindings: context.bindings,
    imports: workerImports(context.tree),
  });
  if (target === undefined) return undefined;
  const binaries = await ownedNativeFiles(context.importer, context.traces);
  if (binaries.length === 0) return undefined;
  return {
    start: target.start,
    end: target.end,
    text: `(${context.markChild(binaries)},${context.source.slice(target.start, target.end)})`,
  };
}
