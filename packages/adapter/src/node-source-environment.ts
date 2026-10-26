import type { Node } from '@oxc-project/types';

import { nativeBindings, stringOf, walk, type NativeBindings } from './native-ast.ts';

interface KnownValue {
  readonly value: unknown;
  readonly environment: boolean;
}
const MAX_CONDITION_DEPTH = 8;

function memberKey(node: Extract<Node, { type: 'MemberExpression' }>): string | undefined {
  if (node.computed) return stringOf(node.property);
  return node.property.type === 'Identifier' ? node.property.name : undefined;
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function parentsOf(nodes: readonly Node[]): ReadonlyMap<Node, Node> {
  const parents = new Map<Node, Node>();
  for (const parent of nodes) {
    for (const value of Object.values(parent)) {
      const children: unknown[] = Array.isArray(value) ? value : [value];
      for (const child of children) if (isNode(child)) parents.set(child, parent);
    }
  }
  return parents;
}

function isReference(node: Node, parent: Node | undefined): boolean {
  if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
    return false;
  return parent?.type !== 'Property' || parent.key !== node || parent.computed || parent.shorthand;
}

function isEnvironmentRead(node: Node, parents: ReadonlyMap<Node, Node>): boolean {
  const env = parents.get(node);
  const field = env === undefined ? undefined : parents.get(env);
  return (
    env?.type === 'MemberExpression' &&
    env.object === node &&
    !env.optional &&
    memberKey(env) === 'env' &&
    field?.type === 'MemberExpression' &&
    field.object === env &&
    !field.optional &&
    memberKey(field) !== undefined
  );
}

function processImport(node: Node, bindings: NativeBindings): boolean {
  if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression')
    return ['node:process', 'process'].includes(stringOf(node.source) ?? '');
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    bindings.lookup(node.callee, 'require') === undefined &&
    ['node:process', 'process'].includes(stringOf(node.arguments[0]) ?? '')
  );
}

function isStableEnvironment(nodes: readonly Node[], bindings: NativeBindings): boolean {
  const parents = parentsOf(nodes);
  for (const node of nodes) {
    if (processImport(node, bindings)) return false;
    if (
      node.type === 'MemberExpression' &&
      memberKey(node) === 'process' &&
      node.object.type === 'Identifier' &&
      node.object.name === 'globalThis' &&
      bindings.lookup(node.object, 'globalThis') === undefined
    )
      return false;
    if (
      node.type !== 'Identifier' ||
      node.name !== 'process' ||
      bindings.lookup(node, 'process') !== undefined ||
      !isReference(node, parents.get(node))
    )
      continue;
    // A process/env object alias or handoff can mutate the fixed values without a direct write.
    if (!bindings.unmodified(node, 'process', true) || !isEnvironmentRead(node, parents))
      return false;
  }
  return true;
}

function environmentValue(node: Node, bindings: NativeBindings): string | undefined {
  if (node.type !== 'MemberExpression' || node.optional) return undefined;
  const env = node.object;
  if (
    env.type !== 'MemberExpression' ||
    env.optional ||
    memberKey(env) !== 'env' ||
    env.object.type !== 'Identifier' ||
    env.object.name !== 'process' ||
    bindings.lookup(env.object, 'process') !== undefined
  )
    return undefined;
  const key = memberKey(node);
  if (key === 'NODE_ENV') return 'production';
  return key === 'NEXT_RUNTIME' ? 'nodejs' : undefined;
}

function knownValue(node: Node, bindings: NativeBindings, depth = 0): KnownValue | undefined {
  if (depth > MAX_CONDITION_DEPTH) return undefined;
  const environment = environmentValue(node, bindings);
  if (environment !== undefined) return { environment: true, value: environment };
  if (node.type === 'Literal' && !('regex' in node) && !('bigint' in node))
    return { environment: false, value: node.value };
  if (node.type === 'UnaryExpression' && node.operator === '!') {
    const argument = knownValue(node.argument, bindings, depth + 1);
    if (argument?.environment !== true) return undefined;
    const truthy = Boolean(argument.value);
    return { environment: true, value: !truthy };
  }
  if (node.type !== 'BinaryExpression' || (node.operator !== '===' && node.operator !== '!=='))
    return undefined;
  const left = knownValue(node.left, bindings, depth + 1);
  const right = knownValue(node.right, bindings, depth + 1);
  if (left === undefined || right === undefined || (!left.environment && !right.environment))
    return undefined;
  const equal = left.value === right.value;
  return { environment: true, value: node.operator === '===' ? equal : !equal };
}

/** Same two fixed Node proof defines, applied only to pure, source-stable condition inspection. */
export function nodeSourceEnvironment(program: Node): (node: Node) => boolean | undefined {
  const bindings = nativeBindings(program);
  const stable = isStableEnvironment(walk(program), bindings);
  return (node) => {
    const value = stable ? knownValue(node, bindings) : undefined;
    return value?.environment === true ? Boolean(value.value) : undefined;
  };
}
