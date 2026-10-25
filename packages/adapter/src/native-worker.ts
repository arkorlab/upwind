import type { Node } from '@oxc-project/types';

import type { NativeAddonEntryTrace } from './native-addons.ts';
import { type NativeBindings, required, stringOf } from './native-ast.ts';
import type { NativeEdit } from './native-operations.ts';
import { ownedNativeFiles } from './native-ownership.ts';
import {
  nativeWorkerMemberKey as memberKey,
  nativeWorkerValues,
  retainedWorkerNodes,
  scalarNamespaceSelection,
  scalarWorkerBinding,
  workerNodeMayExecute,
  workerSelectionWasMutated,
} from './native-worker-branches.ts';

type WorkerOrigin = 'constructor' | 'prototype' | 'namespace' | 'module' | 'promise' | 'ambiguous';
const IMPORTS = new WeakMap<readonly Node[], ReadonlyMap<Node, WorkerOrigin>>();
const CONSTRUCTOR_METHODS: ReadonlySet<string> = new Set(['apply', 'bind', 'call', 'constructor']);
const PROMISE_METHODS: ReadonlySet<string> = new Set(['catch', 'finally', 'then']);
const WORKER_MODULES: ReadonlySet<string> = new Set(['node:worker_threads', 'worker_threads']);
interface WorkerContext {
  readonly bindings: NativeBindings;
  readonly imports: ReadonlyMap<Node, WorkerOrigin>;
  readonly requires?: ReadonlySet<Node> | undefined;
  readonly nodeTarget?: boolean | undefined;
  readonly tree?: readonly Node[] | undefined;
}

interface RetainedWorkerOptions {
  readonly nodeTarget: boolean;
  readonly guards?: ReadonlyMap<number, 'plain' | 'ambiguous'> | undefined;
}

function importedWorkers(
  node: Extract<Node, { type: 'ImportDeclaration' }>,
  imports: Map<Node, WorkerOrigin>,
): void {
  if (!WORKER_MODULES.has(stringOf(node.source) ?? '')) return;
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

function constructorMember(
  owner: 'constructor' | 'prototype',
  key: string | undefined,
): WorkerOrigin | undefined {
  if (key === undefined) return 'ambiguous';
  if (owner === 'prototype') return key === 'constructor' ? 'constructor' : undefined;
  if (key === 'prototype') return 'prototype';
  return CONSTRUCTOR_METHODS.has(key) ? 'ambiguous' : undefined;
}

function memberOrigin(
  member: Extract<Node, { type: 'MemberExpression' }>,
  owner: WorkerOrigin | undefined,
): WorkerOrigin | undefined {
  if (owner === 'ambiguous') return owner;
  const property = memberKey(member);
  if (owner === 'constructor' || owner === 'prototype') return constructorMember(owner, property);
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
  if (owner === 'constructor' || owner === 'prototype') return constructorMember(owner, key);
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
  const scalar = scalarWorkerBinding(declaration, node.name, {
    ...context,
    origin: (value) => workerOrigin(value, context, seen),
  });
  const found =
    origin === undefined || scalar ? undefined : bindingOrigin(declaration.id, node.name, origin);
  return stableOrigin(found, node, context);
}

function workerRequire(node: Node, context: WorkerContext): boolean {
  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return false;
  const source = node.arguments.length === 1 ? stringOf(node.arguments[0]) : undefined;
  if (!WORKER_MODULES.has(source ?? '')) return false;
  const name = node.callee.name;
  const declaration = context.bindings.lookup(node.callee, name);
  if (!context.bindings.unmodified(node.callee, name, false)) return false;
  if (declaration === undefined) return required(node) !== undefined;
  return declaration !== null && context.requires?.has(declaration) === true;
}

function containerInitializer(
  value: Node,
  context: WorkerContext,
  seen: ReadonlySet<Node>,
):
  | { readonly object: Extract<Node, { type: 'ObjectExpression' }>; readonly stable: boolean }
  | undefined {
  if (seen.has(value)) return undefined;
  if (value.type === 'ObjectExpression') return { object: value, stable: true };
  if (value.type !== 'Identifier') return undefined;
  const declaration = context.bindings.lookup(value, value.name);
  if (declaration?.type !== 'VariableDeclarator' || declaration.init === null) return undefined;
  const next = new Set([...seen, value]);
  const found = containerInitializer(declaration.init, context, next);
  return found === undefined
    ? undefined
    : { ...found, stable: found.stable && context.bindings.unmodified(value, value.name, true) };
}

function containerMemberOrigin(
  member: Extract<Node, { type: 'MemberExpression' }>,
  context: WorkerContext,
  seen: ReadonlySet<Node>,
): WorkerOrigin | undefined {
  const container = containerInitializer(member.object, context, seen);
  if (container === undefined) return undefined;
  const key = memberKey(member);
  const origins: WorkerOrigin[] = [];
  for (const property of container.object.properties) {
    const value = property.type === 'Property' ? property.value : property.argument;
    const origin = workerOrigin(value, context, seen);
    if (origin === undefined) continue;
    if (
      key === undefined ||
      !container.stable ||
      property.type !== 'Property' ||
      property.computed ||
      property.kind !== 'init'
    )
      return 'ambiguous';
    const name = property.key.type === 'Identifier' ? property.key.name : stringOf(property.key);
    if (key === name) origins.push(origin);
  }
  return origins.length > 1 ? 'ambiguous' : origins[0];
}

function workerOrigin(
  node: Node,
  context: WorkerContext,
  seen: ReadonlySet<Node> = new Set(),
): WorkerOrigin | undefined {
  if (seen.has(node)) return undefined;
  const next = new Set([...seen, node]);
  const branches = nativeWorkerValues(node);
  if (branches !== undefined) {
    const origins = branches.map((branch) => workerOrigin(branch, context, next));
    return origins.every((origin) => origin === origins[0]) ? origins[0] : 'ambiguous';
  }
  if (node.type === 'Identifier') return declaredOrigin(node, context, next);
  if (node.type === 'ImportExpression' && WORKER_MODULES.has(stringOf(node.source) ?? ''))
    return 'promise';
  if (node.type === 'AwaitExpression') {
    const origin = workerOrigin(node.argument, context, next);
    return origin === 'promise' ? 'module' : origin;
  }
  if (workerRequire(node, context)) return 'namespace';
  if (node.type === 'MemberExpression')
    return scalarNamespaceSelection(node, {
      ...context,
      origin: (value) => workerOrigin(value, context, next),
    })
      ? undefined
      : (memberOrigin(node, workerOrigin(node.object, context, next)) ??
          containerMemberOrigin(node, context, next));
  return undefined;
}

function invokedCapability(
  node: Extract<Node, { type: 'CallExpression' | 'NewExpression' }>,
  context: WorkerContext,
): Node | undefined {
  if (node.callee.type === 'MemberExpression') {
    const receiver = node.callee.object;
    const owner = workerOrigin(receiver, context);
    if (
      owner === 'constructor' ||
      (owner === 'ambiguous' && workerOrigin(node.callee, context) !== undefined)
    )
      return receiver;
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

function capabilityReceiver(node: Node, context: WorkerContext): Node {
  let receiver = node;
  while (receiver.type === 'MemberExpression' || receiver.type === 'AwaitExpression') {
    const inner = receiver.type === 'MemberExpression' ? receiver.object : receiver.argument;
    if (workerOrigin(inner, context) === undefined) break;
    receiver = inner;
  }
  return receiver;
}

function returnedCapability(node: Node, context: WorkerContext): Node | undefined {
  let value: Node | undefined;
  if (node.type === 'ReturnStatement') value = node.argument ?? undefined;
  if (node.type === 'ArrowFunctionExpression' && node.expression) value = node.body;
  if (value === undefined) return undefined;
  const origin = workerOrigin(value, context);
  if (origin === undefined) return undefined;
  // A Worker-only namespace is workerd's stub. This never relaxes the strict Node closure.
  if (
    context.nodeTarget === false &&
    isNamespace(origin) &&
    context.tree !== undefined &&
    unmodifiedWorkerSource(value, context) &&
    !workerSelectionWasMutated(context.tree, (candidate) => workerOrigin(candidate, context))
  )
    return undefined;
  return capabilityReceiver(value, context);
}

function unmodifiedWorkerBinding(
  value: Node,
  context: WorkerContext,
): { readonly kind: 'import' } | { readonly kind: 'initializer'; readonly node: Node } | undefined {
  if (value.type !== 'Identifier' || !context.bindings.unmodified(value, value.name, true))
    return undefined;
  const declared = context.bindings.lookup(value, value.name);
  if (declared === undefined || declared === null) return undefined;
  if (context.imports.has(declared)) return { kind: 'import' };
  return declared.type === 'VariableDeclarator' && declared.init !== null
    ? { kind: 'initializer', node: declared.init }
    : undefined;
}

function unmodifiedWorkerSource(node: Node, context: WorkerContext): boolean {
  const seen = new Set<Node>();
  let value = node;
  while (!seen.has(value)) {
    seen.add(value);
    if (value.type === 'MemberExpression' || value.type === 'AwaitExpression') {
      value = value.type === 'MemberExpression' ? value.object : value.argument;
      continue;
    }
    if (value.type === 'ImportExpression') return WORKER_MODULES.has(stringOf(value.source) ?? '');
    if (workerRequire(value, context)) return true;
    const declared = unmodifiedWorkerBinding(value, context);
    if (declared === undefined) return false;
    if (declared.kind === 'import') return true;
    value = declared.node;
  }
  return false;
}

function handledWorkerConstructor(
  node: Node,
  context: WorkerContext,
  tree: readonly Node[],
  guards: ReadonlyMap<number, 'plain' | 'ambiguous'> | undefined,
): boolean {
  return (
    guards?.get(node.start) === 'plain' &&
    (node.type === 'NewExpression' || node.type === 'CallExpression') &&
    workerOrigin(node.callee, context) === 'constructor' &&
    unmodifiedWorkerSource(node.callee, context) &&
    !workerSelectionWasMutated(tree, (value) => workerOrigin(value, context))
  );
}

function exportedPattern(pattern: Node, context: WorkerContext): boolean {
  let value = pattern;
  while (value.type === 'AssignmentPattern' || value.type === 'RestElement')
    value = value.type === 'AssignmentPattern' ? value.left : value.argument;
  if (value.type === 'Identifier') return handedOffCapability(value, context);
  if (value.type === 'ArrayPattern')
    return value.elements.some((element) => element !== null && exportedPattern(element, context));
  if (value.type === 'ObjectPattern')
    return value.properties.some((property) =>
      exportedPattern(property.type === 'Property' ? property.value : property.argument, context),
    );
  return false;
}

function objectInitializer(value: Node, context: WorkerContext): Node | undefined {
  if (value.type !== 'Identifier') return undefined;
  const declaration = context.bindings.lookup(value, value.name);
  if (
    declaration?.type !== 'VariableDeclarator' ||
    declaration.init === null ||
    declaration.id.type !== 'Identifier'
  )
    return undefined;
  return declaration.init;
}

function handoffValues(node: Node, context: WorkerContext): readonly Node[] {
  if (node.type === 'ObjectExpression')
    return node.properties.map((property) =>
      property.type === 'Property' ? property.value : property.argument,
    );
  const initializer = objectInitializer(node, context);
  return initializer === undefined ? [] : [initializer];
}

function handedOffCapability(value: Node, context: WorkerContext): boolean {
  const seen = new Set<Node>();
  const pending: Node[] = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    if (workerOrigin(node, context) !== undefined) return true;
    const values = handoffValues(node, context);
    pending.push(...values);
  }
  return false;
}

function exportedCapability(node: Node, context: WorkerContext): boolean {
  if (node.type === 'ExportAllDeclaration') return WORKER_MODULES.has(stringOf(node.source) ?? '');
  if (node.type === 'ExportDefaultDeclaration')
    return handedOffCapability(node.declaration, context);
  if (node.type === 'AssignmentExpression') return handedOffCapability(node.right, context);
  if (node.type !== 'ExportNamedDeclaration') return false;
  if (node.source !== null) {
    if (!WORKER_MODULES.has(stringOf(node.source) ?? '')) return false;
    return node.specifiers.some((specifier) => {
      const name =
        specifier.local.type === 'Identifier' ? specifier.local.name : stringOf(specifier.local);
      return name === 'Worker' || name === 'default';
    });
  }
  const declared = node.declaration;
  if (
    declared?.type === 'VariableDeclaration' &&
    declared.declarations.some((item) => exportedPattern(item.id, context))
  )
    return true;
  return node.specifiers.some((specifier) => handedOffCapability(specifier.local, context));
}

/** Inspect only the tree-shaken chunk; exports receive no eager source marker. */
export function hasRetainedWorkerCapability(
  tree: readonly Node[],
  bindings: NativeBindings,
  requires?: ReadonlySet<Node>,
): boolean {
  return retainedWorkerCapabilityNodes(tree, bindings, requires).length > 0;
}

/** Exact capability sites also let refusal-only loader-origin checks retain lexical shadows. */
export function retainedWorkerCapabilityNodes(
  tree: readonly Node[],
  bindings: NativeBindings,
  requires?: ReadonlySet<Node>,
  options?: RetainedWorkerOptions,
): readonly Node[] {
  const context = {
    bindings,
    imports: workerImports(tree),
    requires,
    tree,
    nodeTarget: options?.nodeTarget,
  };
  return retainedWorkerNodes(tree).filter((node) => {
    if (
      options?.nodeTarget === false &&
      handledWorkerConstructor(node, context, tree, options.guards)
    )
      return false;
    if (returnedCapability(node, context) !== undefined || exportedCapability(node, context))
      return true;
    return (
      (node.type === 'CallExpression' || node.type === 'NewExpression') &&
      invokedCapability(node, context) !== undefined
    );
  });
}

export interface NativeWorkerSite {
  readonly kind: 'call' | 'constructor' | 'return';
  readonly start: number;
  readonly end: number;
}

export async function nativeWorkerEdit(
  node: Node,
  context: {
    readonly source: string;
    readonly importer: string;
    readonly traces: readonly NativeAddonEntryTrace[];
    readonly tree: readonly Node[];
    readonly bindings: NativeBindings;
    readonly nodeTarget: boolean;
    readonly guards: ReadonlyMap<number, 'plain' | 'ambiguous'>;
    markChild(binaries: readonly string[], site: NativeWorkerSite): string;
  },
): Promise<NativeEdit | undefined> {
  if (!workerNodeMayExecute(node, context.tree)) return undefined;
  const capability = {
    bindings: context.bindings,
    imports: workerImports(context.tree),
    tree: context.tree,
    nodeTarget: context.nodeTarget,
  };
  if (
    !context.nodeTarget &&
    handledWorkerConstructor(node, capability, context.tree, context.guards)
  )
    return undefined;
  let target = returnedCapability(node, capability);
  if (target === undefined && (node.type === 'CallExpression' || node.type === 'NewExpression'))
    target = invokedCapability(node, capability);
  if (target === undefined) return undefined;
  const binaries = await ownedNativeFiles(context.importer, context.traces);
  if (binaries.length === 0) return undefined;
  let kind: NativeWorkerSite['kind'] = 'return';
  if (node.type === 'NewExpression') kind = 'constructor';
  else if (node.type === 'CallExpression') kind = 'call';
  const site: NativeWorkerSite = {
    end: target.end,
    kind,
    start: target.start,
  };
  return {
    start: target.start,
    end: target.end,
    text: `(${context.markChild(binaries, site)},${context.source.slice(target.start, target.end)})`,
  };
}
