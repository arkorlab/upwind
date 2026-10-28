import { isNode, listOf, type Node } from './lexical-scope.ts';
import { stringOf } from './node-manifest-consumer-ast.ts';

const MAX_SEQUENCE_DEPTH = 32;
const MAX_LITERALS = 64;
const MAX_NODES = 128;
type Primitive = string | number | boolean | null;
interface Budget {
  nodes: number;
  literals: number;
}

function primitive(node: Node): Primitive | undefined {
  if (node.type !== 'Literal' || 'regex' in node || 'bigint' in node) return undefined;
  const value = node['value'];
  return value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
    ? value
    : undefined;
}

function literal(node: Node, budget: Budget): Primitive | undefined {
  budget.nodes += 1;
  budget.literals += 1;
  return budget.nodes > MAX_NODES || budget.literals > MAX_LITERALS ? undefined : primitive(node);
}

function sequence(original: Node, budget: Budget): Primitive | undefined {
  const pending = [{ node: original, depth: 0 }];
  let value: Primitive | undefined;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, depth } = next;
    if (node.type !== 'SequenceExpression') {
      value = literal(node, budget);
      if (value === undefined) return undefined;
      continue;
    }
    budget.nodes += 1;
    const terms = listOf(node, 'expressions');
    if (
      budget.nodes > MAX_NODES ||
      depth >= MAX_SEQUENCE_DEPTH ||
      terms.length < 2 ||
      terms.length > MAX_LITERALS
    )
      return undefined;
    for (const term of terms.toReversed()) {
      if (!isNode(term)) return undefined;
      pending.push({ node: term, depth: depth + 1 });
    }
  }
  return value;
}

/** Finite constructor DATA only; neither marker strings nor this result certify a source. */
export function nodeManifestPagesConstructorString(
  name: string,
  original: Node | undefined,
): string | undefined {
  if (original === undefined || (name !== 'distDir' && name !== 'relativeProjectDir'))
    return undefined;
  const budget: Budget = { nodes: 0, literals: 0 };
  let selected = original;
  const fallback = original.type === 'LogicalExpression';
  if (fallback) {
    budget.nodes += 1;
    const left = original['left'];
    const right = original['right'];
    if (
      original['operator'] !== '||' ||
      !isNode(left) ||
      !isNode(right) ||
      literal(right, budget) !== ''
    )
      return undefined;
    selected = left;
  }
  const value = sequence(selected, budget);
  if (value === undefined) return undefined;
  if (fallback && (value === null || value === false || value === 0 || value === '')) return '';
  return typeof value === 'string' ? value : undefined;
}

/** Preserve the existing direct-string path for every router; compound forms are Pages-only. */
export function nodeManifestConstructorString(
  kind: string,
  name: string | undefined,
  value: Node | undefined,
): boolean {
  if (name !== 'distDir' && name !== 'relativeProjectDir') return false;
  return (
    stringOf(value) !== undefined ||
    (kind === 'pages' && nodeManifestPagesConstructorString(name, value) !== undefined)
  );
}
