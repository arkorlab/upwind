import type { Node } from '@oxc-project/types';

import { stringOf, walk, type NativeBindings } from './native-ast.ts';

interface RetainedNodes {
  readonly nodes: readonly Node[];
  readonly identities: ReadonlySet<Node>;
}
const RETAINED = new WeakMap<readonly Node[], RetainedNodes>();
const SCALAR_FIELDS: ReadonlySet<string> = new Set(['isMainThread', 'threadId']);

export function nativeWorkerMemberKey(
  member: Extract<Node, { type: 'MemberExpression' }>,
): string | undefined {
  if (member.computed) return stringOf(member.property);
  return member.property.type === 'Identifier' ? member.property.name : undefined;
}

function primitive(
  node: Node,
): { readonly truthy: boolean; readonly nullish: boolean } | undefined {
  if (node.type !== 'Literal' || 'regex' in node) return undefined;
  const value = node.value;
  if (typeof value !== 'bigint' && 'bigint' in node) return undefined;
  return value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
    ? { truthy: Boolean(value), nullish: value === null }
    : undefined;
}

function logicalValues(node: Extract<Node, { type: 'LogicalExpression' }>): readonly Node[] {
  const known = primitive(node.left);
  if (known === undefined) return [node.left, node.right];
  let right = known.nullish;
  if (node.operator === '&&') right = known.truthy;
  else if (node.operator === '||') right = !known.truthy;
  return [right ? node.right : node.left];
}

/** Possible resulting values only; every original effect remains in its source expression. */
export function nativeWorkerValues(node: Node): readonly Node[] | undefined {
  if (node.type === 'ConditionalExpression') {
    const known = primitive(node.test);
    if (known === undefined) return [node.consequent, node.alternate];
    return [known.truthy ? node.consequent : node.alternate];
  }
  if (node.type === 'LogicalExpression') return logicalValues(node);
  if (node.type === 'SequenceExpression') {
    const last = node.expressions.at(-1);
    return last === undefined ? [] : [last];
  }
  return node.type === 'AssignmentExpression' && node.operator === '=' ? [node.right] : undefined;
}

interface ScalarContext {
  readonly bindings: NativeBindings;
  readonly origin: (node: Node) => string | undefined;
  readonly tree?: readonly Node[] | undefined;
}
interface ScalarArm {
  readonly namespace: boolean;
  readonly selection: boolean;
}
function scalarObject(node: Node, field: string): boolean {
  if (node.type !== 'ObjectExpression') return false;
  let fields = 0;
  for (const property of node.properties) {
    if (
      property.type !== 'Property' ||
      property.kind !== 'init' ||
      property.method ||
      property.computed
    )
      return false;
    const key = property.key.type === 'Identifier' ? property.key.name : stringOf(property.key);
    if (key === '__proto__') return false;
    if (key !== field) continue;
    if (primitive(property.value) === undefined) return false;
    fields += 1;
  }
  return fields === 1;
}
function scalarInitializer(node: Node, bindings: NativeBindings): Node | undefined {
  if (node.type !== 'Identifier') return undefined;
  const binding = bindings.lookup(node, node.name);
  return binding?.type === 'VariableDeclarator' &&
    binding.id.type === 'Identifier' &&
    binding.init !== null &&
    binding.init.type !== 'ObjectExpression' &&
    bindings.unmodified(node, node.name, true)
    ? binding.init
    : undefined;
}
function scalarArm(
  value: Node,
  field: string,
  context: ScalarContext,
  seen: ReadonlySet<Node>,
): ScalarArm | undefined {
  const next = new Set(seen);
  let node = value;
  while (!next.has(node)) {
    next.add(node);
    const origin = context.origin(node);
    if (origin === 'namespace' || origin === 'module') return { namespace: true, selection: false };
    const choices = nativeWorkerValues(node);
    if (choices !== undefined) {
      const arms = choices.map((choice) => scalarArm(choice, field, context, next));
      if (arms.includes(undefined)) return undefined;
      return { namespace: arms.some((arm) => arm?.namespace === true), selection: true };
    }
    const initializer = scalarInitializer(node, context.bindings);
    if (initializer === undefined)
      return scalarObject(node, field) ? { namespace: false, selection: false } : undefined;
    node = initializer;
  }
  return undefined;
}
function writeChildren(target: Node): readonly Node[] {
  if (target.type === 'ObjectPattern')
    return target.properties.map((property) =>
      property.type === 'Property' ? property.value : property.argument,
    );
  if (target.type === 'ArrayPattern') return target.elements.filter((element) => element !== null);
  if (target.type === 'AssignmentPattern') return [target.left];
  if (target.type === 'RestElement') return [target.argument];
  if (target.type === 'VariableDeclaration') return target.declarations.map((entry) => entry.id);
  return [];
}

function writtenObjects(target: Node): readonly Node[] {
  const result: Node[] = [];
  const pending = [target];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'Identifier') result.push(node);
    else if (node.type === 'MemberExpression') result.push(node.object);
    else for (const child of writeChildren(node)) pending.push(child);
  }
  return result;
}

export function workerSelectionWasMutated(
  tree: readonly Node[],
  origin: ScalarContext['origin'],
): boolean {
  return tree.some((node) => {
    let target: Node | undefined;
    if (
      node.type === 'AssignmentExpression' ||
      node.type === 'ForInStatement' ||
      node.type === 'ForOfStatement'
    )
      target = node.left;
    if (
      node.type === 'UpdateExpression' ||
      (node.type === 'UnaryExpression' && node.operator === 'delete')
    )
      target = node.argument;
    return (
      target !== undefined && writtenObjects(target).some((value) => origin(value) !== undefined)
    );
  });
}

/** A selected namespace's known scalar is safe only when every ordinary arm proves that data value. */
function scalarSelection(object: Node, key: string | undefined, context: ScalarContext): boolean {
  if (key === undefined || !SCALAR_FIELDS.has(key) || context.tree === undefined) return false;
  const arms = scalarArm(object, key, context, new Set());
  return (
    arms?.namespace === true &&
    arms.selection &&
    !workerSelectionWasMutated(context.tree, context.origin)
  );
}
export function scalarNamespaceSelection(
  member: Extract<Node, { type: 'MemberExpression' }>,
  context: ScalarContext,
): boolean {
  return scalarSelection(member.object, nativeWorkerMemberKey(member), context);
}
export function scalarWorkerBinding(
  declaration: Extract<Node, { type: 'VariableDeclarator' }>,
  name: string,
  context: ScalarContext,
): boolean {
  if (declaration.id.type !== 'ObjectPattern' || declaration.init === null) return false;
  const keys = new Set<string>();
  let field: string | undefined;
  for (const property of declaration.id.properties) {
    if (property.type !== 'Property' || property.computed || property.value.type !== 'Identifier')
      return false;
    const key = property.key.type === 'Identifier' ? property.key.name : stringOf(property.key);
    if (key === undefined || keys.has(key)) return false;
    keys.add(key);
    if (property.value.name === name && context.bindings.unmodified(property.value, name, true))
      field = key;
  }
  return scalarSelection(declaration.init, field, context);
}

function unselected(node: Node): Node | undefined {
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    const known = primitive(node.test);
    if (known === undefined) return undefined;
    return (known.truthy ? node.alternate : node.consequent) ?? undefined;
  }
  if (node.type !== 'LogicalExpression') return undefined;
  const selected = nativeWorkerValues(node);
  return selected?.length === 1 && selected[0] === node.left ? node.right : undefined;
}

function retained(tree: readonly Node[]): RetainedNodes {
  const previous = RETAINED.get(tree);
  if (previous !== undefined) return previous;
  const dead = new Set<Node>();
  for (const node of tree) {
    const branch = unselected(node);
    if (branch !== undefined) for (const unused of walk(branch)) dead.add(unused);
  }
  const nodes = tree.filter((node) => !dead.has(node));
  const result = { nodes, identities: new Set(nodes) };
  RETAINED.set(tree, result);
  return result;
}

/** Skip only impossible capability sites; discarded sequence operands are still evaluated. */
export function retainedWorkerNodes(tree: readonly Node[]): readonly Node[] {
  return retained(tree).nodes;
}

export function workerNodeMayExecute(node: Node, tree: readonly Node[]): boolean {
  return retained(tree).identities.has(node);
}
