import type { Node } from '@oxc-project/types';

import { parseNativeSource } from './native-source-parser.ts';

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

function conditionalBranch(node: Node): Node[] | undefined {
  // Literal boolean branches have no condition side effects and cannot load the other branch.
  if (
    (node.type === 'IfStatement' || node.type === 'ConditionalExpression') &&
    node.test.type === 'Literal' &&
    typeof node.test.value === 'boolean'
  ) {
    const selected = node.test.value ? node.consequent : node.alternate;
    return selected === null ? [] : [selected];
  }
  return undefined;
}

function children(node: Node): Node[] {
  const selected = conditionalBranch(node);
  if (selected !== undefined) return selected;
  if (
    node.type === 'LogicalExpression' &&
    node.left.type === 'Literal' &&
    ((node.operator === '&&' && node.left.value === false) ||
      (node.operator === '||' && node.left.value === true))
  )
    return [node.left];
  const found: Node[] = [];
  for (const value of Object.values(node)) {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of values) if (nodeValue(child)) found.push(child);
  }
  return found;
}

/** Physical alias discovery omits only statically impossible branches; closure audit is separate. */
export function originalNodeSpecifiers(file: string, bytes: Uint8Array | undefined): string[] {
  if (!/\.[cm]?js$/u.test(file)) return [];
  try {
    const found: string[] = [];
    const pending: Node[] = [parseNativeSource(new TextDecoder().decode(bytes), file)];
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
