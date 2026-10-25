import type { Node } from '@oxc-project/types';

import { walk } from './native-ast.ts';

interface RetainedNodes {
  readonly nodes: readonly Node[];
  readonly identities: ReadonlySet<Node>;
}
const RETAINED = new WeakMap<readonly Node[], RetainedNodes>();

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
