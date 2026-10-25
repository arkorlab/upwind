import type { Node } from '@oxc-project/types';

import type { NativeAddonEntryTrace } from './native-addons.ts';
import { identifier, type NativeBindings, stringOf, workerModule } from './native-ast.ts';
import type { NativeEdit } from './native-operations.ts';
import { ownedNativeFiles } from './native-ownership.ts';

type WorkerOrigin = 'constructor' | 'namespace';
interface WorkerContext {
  readonly bindings: NativeBindings;
  readonly imports: ReadonlyMap<Node, WorkerOrigin>;
}

function importedWorkers(
  node: Extract<Node, { type: 'ImportDeclaration' }>,
  imports: Map<Node, WorkerOrigin>,
): void {
  if (!['node:worker_threads', 'worker_threads'].includes(String(node.source.value))) return;
  for (const specifier of node.specifiers) {
    if (['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(specifier.type))
      imports.set(specifier, 'namespace');
    if (specifier.type === 'ImportSpecifier' && identifier(specifier.imported, 'Worker'))
      imports.set(specifier, 'constructor');
  }
}

function workerImports(tree: readonly Node[]): ReadonlyMap<Node, WorkerOrigin> {
  const imports = new Map<Node, WorkerOrigin>();
  for (const node of tree) {
    if (node.type === 'ImportDeclaration') importedWorkers(node, imports);
  }
  return imports;
}

function workerProperty(callee: Extract<Node, { type: 'MemberExpression' }>): boolean {
  const property = callee.computed
    ? stringOf(callee.property)
    : callee.property.type === 'Identifier'
      ? callee.property.name
      : undefined;
  return property === 'Worker' || (callee.computed && property === undefined);
}

function destructuredWorker(pattern: Node, name: string): boolean {
  if (pattern.type !== 'ObjectPattern') return false;
  return pattern.properties.some((property) => {
    if (property.type !== 'Property' || !identifier(property.key, 'Worker')) return false;
    const value =
      property.value.type === 'AssignmentPattern' ? property.value.left : property.value;
    return identifier(value, name);
  });
}

function declaredOrigin(
  node: Extract<Node, { type: 'Identifier' }>,
  context: WorkerContext,
  seen: ReadonlySet<Node>,
): WorkerOrigin | undefined {
  const declaration = context.bindings.lookup(node, node.name);
  if (declaration === undefined || declaration === null) return undefined;
  const imported = context.imports.get(declaration);
  if (imported !== undefined) return imported;
  if (declaration.type !== 'VariableDeclarator' || declaration.init === null) return undefined;
  const origin = workerOrigin(declaration.init, context, seen);
  if (declaration.id.type === 'Identifier') return origin;
  return origin === 'namespace' && destructuredWorker(declaration.id, node.name)
    ? 'constructor'
    : undefined;
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
  if (
    node.type === 'MemberExpression' &&
    workerProperty(node) &&
    workerOrigin(node.object, context, next) === 'namespace'
  )
    return 'constructor';
  return undefined;
}

/** Only the lexically imported Node constructor; mutated origins still require child-graph proof. */
function nodeWorkerConstructor(
  callee: Node,
  tree: readonly Node[],
  bindings: NativeBindings,
): boolean {
  return workerOrigin(callee, { bindings, imports: workerImports(tree) }) === 'constructor';
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
