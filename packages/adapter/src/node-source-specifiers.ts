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

export interface NodeSourceSpecifier {
  readonly specifier: string;
  readonly kind: 'require' | 'import';
}

function sourceSpecifier(
  node: Node | undefined,
  kind: NodeSourceSpecifier['kind'],
): NodeSourceSpecifier | undefined {
  const specifier = staticString(node);
  return specifier === undefined ? undefined : { specifier, kind };
}

function specifierIn(node: Node, bindings: NativeBindings): NodeSourceSpecifier | undefined {
  if (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'require' &&
    bindings.lookup(node.callee, 'require') === undefined
  )
    return sourceSpecifier(node.arguments[0], 'require');
  if (
    (node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration') &&
    node.source !== null
  )
    return sourceSpecifier(node.source, 'import');
  return node.type === 'ImportExpression' ? sourceSpecifier(node.source, 'import') : undefined;
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
interface Visit {
  readonly node: Node;
  readonly alternative: boolean;
}
export interface NodeSpecifierInventory {
  readonly required: readonly NodeSourceSpecifier[];
  /** Non-authoritative layout hints only; these never extend the traced source closure. */
  readonly alternatives: readonly NodeSourceSpecifier[];
}

function visits(nodes: readonly Node[], alternative: boolean): Visit[] {
  return nodes.map((node) => ({ node, alternative }));
}

function conditionalBranch(visit: Visit, environment: EnvironmentTruth): Visit[] | undefined {
  const { node, alternative } = visit;
  if (node.type !== 'IfStatement' && node.type !== 'ConditionalExpression') return undefined;
  const literal = literalTruthiness(node.test);
  const truth = literal ?? environment(node.test);
  if (truth === undefined) return undefined;
  const selected = truth ? node.consequent : node.alternate;
  const found = selected === null ? [] : visits([selected], alternative);
  const other = truth ? node.alternate : node.consequent;
  // Literal-dead code stays dead. Only a fixed-environment omission supplies layout hints.
  if (literal === undefined && other !== null) found.push({ node: other, alternative: true });
  return found;
}

function logicalBranch(visit: Visit, environment: EnvironmentTruth): Visit[] | undefined {
  const { node, alternative } = visit;
  if (node.type !== 'LogicalExpression') return undefined;
  const literal = literalTruthiness(node.left);
  const truth = literal ?? environment(node.left);
  if ((truth === false && node.operator === '&&') || (truth === true && node.operator === '||')) {
    const found = visits([node.left], alternative);
    if (literal === undefined) found.push({ node: node.right, alternative: true });
    return found;
  }
  return undefined;
}

function children(visit: Visit, environment: EnvironmentTruth): Visit[] {
  const { node, alternative } = visit;
  const selected = conditionalBranch(visit, environment) ?? logicalBranch(visit, environment);
  if (selected !== undefined) return selected;
  const found: Node[] = [];
  for (const value of Object.values(node)) {
    const values: unknown[] = Array.isArray(value) ? value : [value];
    for (const child of values) if (nodeValue(child)) found.push(child);
  }
  return visits(found, alternative);
}

/** Physical alias discovery omits only statically impossible branches; closure audit is separate. */
export function originalNodeSpecifierInventory(
  file: string,
  bytes: Uint8Array | undefined,
): NodeSpecifierInventory {
  if (!/\.[cm]?[jt]s$/u.test(file)) return { required: [], alternatives: [] };
  try {
    const required: NodeSourceSpecifier[] = [];
    const alternatives: NodeSourceSpecifier[] = [];
    const analysis = nativeSourceAnalysis(new TextDecoder().decode(bytes), file);
    const bindings = nativeBindings(analysis.program);
    const environment = nodeSourceEnvironment(analysis.program);
    const pending: Visit[] = [{ node: analysis.program, alternative: false }];
    for (let visit = pending.pop(); visit !== undefined; visit = pending.pop()) {
      const { node, alternative } = visit;
      const specifier = specifierIn(node, bindings);
      if (specifier !== undefined) (alternative ? alternatives : required).push(specifier);
      for (const child of children(visit, environment).toReversed()) pending.push(child);
    }
    return { required, alternatives };
  } catch {
    // NFT includes source/client data too. Retained executable sources are independently audited.
    return { required: [], alternatives: [] };
  }
}

/** Default production dependency discovery remains strict and excludes alternative-only hints. */
export function originalNodeSpecifiers(file: string, bytes: Uint8Array | undefined): string[] {
  return originalNodeSpecifierInventory(file, bytes).required.map((load) => load.specifier);
}
