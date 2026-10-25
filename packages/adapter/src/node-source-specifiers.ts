import type { Node } from '@oxc-project/types';

import { nativeSourceAnalysis } from './native-source-parser.ts';

function staticString(node: Node | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function specifierIn(node: Node): string | undefined {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require'
  )
    return staticString(node.arguments[0]);
  if (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration') &&
    node.source !== null
  )
    return staticString(node.source);
  return node.type === 'ImportExpression' ? staticString(node.source) : undefined;
}

function nodeValue(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function literalTruthiness(node: Node): boolean | undefined {
  if (node.type !== 'Literal' || 'regex' in node) return undefined;
  const value = node.value;
  // Some ESTree consumers represent BigInt values separately; do not confuse those with null.
  if (typeof value !== 'bigint' && 'bigint' in node) return undefined;
  return value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
    ? Boolean(value)
    : undefined;
}

function conditionalBranch(node: Node): Node[] | undefined {
  if (node.type !== 'IfStatement' && node.type !== 'ConditionalExpression') return undefined;
  // Only primitive literals have a known truth value and no condition side effects here.
  const truth = literalTruthiness(node.test);
  if (truth === undefined) return undefined;
  const selected = truth ? node.consequent : node.alternate;
  return selected === null ? [] : [selected];
}

function children(node: Node): Node[] {
  const selected = conditionalBranch(node);
  if (selected !== undefined) return selected;
  if (node.type === 'LogicalExpression') {
    const truth = literalTruthiness(node.left);
    if ((truth === false && node.operator === '&&') || (truth === true && node.operator === '||'))
      return [node.left];
  }
  const found: Node[] = [];
  for (const value of Object.values(node)) {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of values) if (nodeValue(child)) found.push(child);
  }
  return found;
}

/** Physical alias discovery omits only statically impossible branches; closure audit is separate. */
export function originalNodeSpecifiers(file: string, bytes: Uint8Array | undefined): string[] {
  if (!/\.[cm]?[jt]s$/u.test(file)) return [];
  try {
    const found: string[] = [];
    const analysis = nativeSourceAnalysis(new TextDecoder().decode(bytes), file);
    const pending: Node[] = [analysis.program];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const specifier = specifierIn(node);
      if (specifier !== undefined) found.push(specifier);
      for (const child of children(node).toReversed()) pending.push(child);
    }
    return found;
  } catch {
    // NFT includes source/client data too. Retained executable sources are independently audited.
    return [];
  }
}
