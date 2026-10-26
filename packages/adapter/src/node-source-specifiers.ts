import type { Node } from '@oxc-project/types';

import { nativeBindings, type NativeBindings } from './native-ast.ts';
import { nativeSourceAnalysis } from './native-source-parser.ts';
import { nodeSourceEnvironment } from './node-source-environment.ts';

function staticString(node: Node | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function specifierIn(node: Node, bindings: NativeBindings): string | undefined {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    bindings.lookup(node.callee, 'require') === undefined
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

type EnvironmentTruth = ReturnType<typeof nodeSourceEnvironment>;

function truthiness(node: Node, environment: EnvironmentTruth): boolean | undefined {
  return literalTruthiness(node) ?? environment(node);
}

function conditionalBranch(node: Node, environment: EnvironmentTruth): Node[] | undefined {
  if (node.type !== 'IfStatement' && node.type !== 'ConditionalExpression') return undefined;
  // Only primitive literals and the two pure, fixed Node environment reads can omit a branch.
  const truth = truthiness(node.test, environment);
  if (truth === undefined) return undefined;
  const selected = truth ? node.consequent : node.alternate;
  return selected === null ? [] : [selected];
}

function children(node: Node, environment: EnvironmentTruth): Node[] {
  const selected = conditionalBranch(node, environment);
  if (selected !== undefined) return selected;
  if (node.type === 'LogicalExpression') {
    const truth = truthiness(node.left, environment);
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
    const bindings = nativeBindings(analysis.program);
    const environment = nodeSourceEnvironment(analysis.program);
    const pending: Node[] = [analysis.program];
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      const specifier = specifierIn(node, bindings);
      if (specifier !== undefined) found.push(specifier);
      for (const child of children(node, environment).toReversed()) pending.push(child);
    }
    return found;
  } catch {
    // NFT includes source/client data too. Retained executable sources are independently audited.
    return [];
  }
}
