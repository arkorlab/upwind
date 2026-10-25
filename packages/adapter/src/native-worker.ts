import type { Node } from '@oxc-project/types';

import type { NativeAddonEntryTrace } from './native-addons.ts';
import { binds, identifier, stringOf, unchangedBinding, workerModule } from './native-ast.ts';
import type { NativeEdit } from './native-operations.ts';
import { ownedNativeFiles } from './native-ownership.ts';

interface WorkerBindings {
  readonly names: Set<string>;
  readonly namespaces: Set<string>;
}

function importedWorkers(
  node: Extract<Node, { type: 'ImportDeclaration' }>,
  bindings: WorkerBindings,
): void {
  if (!['node:worker_threads', 'worker_threads'].includes(String(node.source.value))) return;
  for (const specifier of node.specifiers) {
    if (['ImportNamespaceSpecifier', 'ImportDefaultSpecifier'].includes(specifier.type))
      bindings.namespaces.add(specifier.local.name);
    if (specifier.type === 'ImportSpecifier' && identifier(specifier.imported, 'Worker'))
      bindings.names.add(specifier.local.name);
  }
}

function requiredWorkers(
  node: Extract<Node, { type: 'VariableDeclarator' }>,
  bindings: WorkerBindings,
): void {
  if (node.init === null || !workerModule(node.init)) return;
  if (node.id.type === 'Identifier') bindings.namespaces.add(node.id.name);
  if (node.id.type !== 'ObjectPattern') return;
  for (const property of node.id.properties) {
    if (
      property.type === 'Property' &&
      identifier(property.key, 'Worker') &&
      property.value.type === 'Identifier'
    )
      bindings.names.add(property.value.name);
  }
}

function workerBindings(tree: readonly Node[]): WorkerBindings {
  const bindings = { names: new Set<string>(), namespaces: new Set<string>() };
  const requireSafe = !binds(tree, 'require');
  for (const node of tree) {
    if (node.type === 'ImportDeclaration') importedWorkers(node, bindings);
    if (requireSafe && node.type === 'VariableDeclarator') requiredWorkers(node, bindings);
  }
  return bindings;
}

function workerProperty(callee: Extract<Node, { type: 'MemberExpression' }>): boolean {
  const property = callee.computed
    ? stringOf(callee.property)
    : callee.property.type === 'Identifier'
      ? callee.property.name
      : undefined;
  return property === 'Worker' || (callee.computed && property === undefined);
}

/** Only the actual imported Node constructor, never a same-named application class. */
export function nodeWorkerConstructor(callee: Node, tree: readonly Node[]): boolean {
  const { names, namespaces } = workerBindings(tree);
  const requireSafe = !binds(tree, 'require');
  if (callee.type === 'Identifier')
    return names.has(callee.name) && unchangedBinding(tree, callee.name);
  if (callee.type !== 'MemberExpression') return false;
  // Unknown computed access to the actual namespace remains an unclassified child marker.
  if (!workerProperty(callee)) return false;
  if (callee.object.type === 'Identifier')
    return namespaces.has(callee.object.name) && unchangedBinding(tree, callee.object.name);
  return requireSafe && workerModule(callee.object);
}

export async function nativeWorkerEdit(
  node: Node,
  context: {
    readonly source: string;
    readonly importer: string;
    readonly traces: readonly NativeAddonEntryTrace[];
    readonly tree: readonly Node[];
    markChild(binaries: readonly string[]): string;
  },
): Promise<NativeEdit | undefined> {
  if (node.type !== 'NewExpression' || !nodeWorkerConstructor(node.callee, context.tree))
    return undefined;
  const binaries = await ownedNativeFiles(context.importer, context.traces);
  if (binaries.length === 0) return undefined;
  return {
    start: node.callee.start,
    end: node.callee.end,
    text: `(${context.markChild(binaries)},${context.source.slice(node.callee.start, node.callee.end)})`,
  };
}
