import type { Node } from '@oxc-project/types';

import type { NativeAddonEntryTrace } from './native-addons.ts';
import { type NativeBindings, stringOf, workerModule } from './native-ast.ts';
import type { NativeEdit } from './native-operations.ts';
import { ownedNativeFiles } from './native-ownership.ts';

type WorkerOrigin = 'constructor' | 'namespace' | 'ambiguous';
const IMPORTS = new WeakMap<readonly Node[], ReadonlyMap<Node, WorkerOrigin>>();
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
    if (
      name === 'default' ||
      ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(specifier.type)
    )
      imports.set(specifier, 'namespace');
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

function isWorkerProperty(callee: Extract<Node, { type: 'MemberExpression' }>): boolean {
  let property: string | undefined;
  if (callee.computed) property = stringOf(callee.property);
  else if (callee.property.type === 'Identifier') property = callee.property.name;
  return property === 'Worker' || (callee.computed && property === undefined);
}

function propertyOrigin(
  property: Extract<Node, { type: 'Property' }>,
  owner: WorkerOrigin,
): WorkerOrigin | undefined {
  if (owner !== 'namespace') return 'ambiguous';
  const key =
    property.computed || property.key.type !== 'Identifier'
      ? stringOf(property.key)
      : property.key.name;
  if (key === undefined) return 'ambiguous';
  return key === 'Worker' ? 'constructor' : undefined;
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
  return origin === 'namespace' && !context.bindings.unmodified(node, node.name, true)
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
  if (workerModule(node) && context.bindings.lookup(node, 'require') === undefined)
    return 'namespace';
  if (node.type === 'MemberExpression') {
    const owner = workerOrigin(node.object, context, next);
    if (owner === 'ambiguous') return owner;
    if (owner === 'namespace' && isWorkerProperty(node)) return 'constructor';
  }
  return undefined;
}

/** Only the lexically imported Node constructor; mutated origins still require child-graph proof. */
function nodeWorkerConstructor(
  callee: Node,
  tree: readonly Node[],
  bindings: NativeBindings,
): boolean {
  const origin = workerOrigin(callee, { bindings, imports: workerImports(tree) });
  return origin === 'constructor' || origin === 'ambiguous';
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
  if (
    node.type !== 'NewExpression' ||
    !nodeWorkerConstructor(node.callee, context.tree, context.bindings)
  )
    return undefined;
  const binaries = await ownedNativeFiles(context.importer, context.traces);
  if (binaries.length === 0) return undefined;
  return {
    start: node.callee.start,
    end: node.callee.end,
    text: `(${context.markChild(binaries)},${context.source.slice(node.callee.start, node.callee.end)})`,
  };
}
