import { isNode, listOf, type Node } from './lexical-scope.ts';
import { isGlobalCompiler } from './node-jwt-compiler-sites.ts';
import {
  declaration,
  identifier,
  reference,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';

export const NODE_WS_OPTIONAL_TARGETS = ['bufferutil', 'utf-8-validate'] as const;
export type NodeWsOptionalTarget = (typeof NODE_WS_OPTIONAL_TARGETS)[number];
const MAX_NODES = 100_000;
function target(value: unknown): value is NodeWsOptionalTarget {
  return value === 'bufferutil' || value === 'utf-8-validate';
}
function literal(value: unknown, expected: string): boolean {
  return isNode(value) && value.type === 'Literal' && value['value'] === expected;
}
function outerFunction(node: Node, parents: ReadonlyMap<Node, Visit>): boolean {
  for (let at = parents.get(node)?.parent; at !== undefined; at = parents.get(at)?.parent)
    if (at.type === 'FunctionDeclaration' || at.type === 'FunctionExpression') return true;
  return false;
}
function unsafeRequire(visit: Visit, parents: ReadonlyMap<Node, Visit>): boolean {
  const { node, parent, scopes } = visit;
  if (node.type === 'WithStatement') return true;
  if (identifier(node) && node.name === 'arguments' && !outerFunction(node, parents)) return true;
  if (
    !identifier(node) ||
    node.name !== 'require' ||
    !reference(visit) ||
    declaration('require', scopes) !== undefined
  )
    return false;
  const args = parent === undefined ? [] : listOf(parent, 'arguments');
  return (
    parent?.type !== 'CallExpression' ||
    parent['callee'] !== node ||
    parent['optional'] === true ||
    args.length !== 1 ||
    !isNode(args[0]) ||
    args[0].type !== 'Literal' ||
    typeof args[0]['value'] !== 'string'
  );
}
function selectedTarget(
  { node, parent, scopes }: Visit,
  parents: ReadonlyMap<Node, Visit>,
): NodeWsOptionalTarget | undefined {
  if (
    !identifier(node) ||
    node.name !== 'eval' ||
    declaration('require', scopes) !== undefined ||
    parent?.type !== 'CallExpression' ||
    parent['callee'] !== node ||
    parent['optional'] === true ||
    listOf(parent, 'arguments').length !== 1 ||
    !literal(listOf(parent, 'arguments')[0], 'require')
  )
    return undefined;
  const call = parents.get(parent)?.parent;
  const args = call === undefined ? [] : listOf(call, 'arguments');
  const argument = args[0];
  return call?.type === 'CallExpression' &&
    call['callee'] === parent &&
    call['optional'] !== true &&
    args.length === 1 &&
    isNode(argument) &&
    argument.type === 'Literal' &&
    target(argument['value'])
    ? argument['value']
    : undefined;
}
/** Exact operation DATA only; an original-source/default-CJS/absence proof is separately required. */
export function nodeWsStaticLoaderSites(program: unknown):
  | readonly {
      readonly node: Node;
      readonly specifier: NodeWsOptionalTarget;
    }[]
  | undefined {
  if (!isNode(program)) return undefined;
  const all = visitTree(program);
  if (all.length > MAX_NODES) return undefined;
  const parents = new Map(all.map((visit) => [visit.node, visit]));
  if (all.some((visit) => unsafeRequire(visit, parents))) return undefined;
  const compilers = all.filter(
    (visit) => reference(visit) && isGlobalCompiler(visit.node, visit.scopes),
  );
  if (compilers.length !== NODE_WS_OPTIONAL_TARGETS.length) return undefined;
  const result: { readonly node: Node; readonly specifier: NodeWsOptionalTarget }[] = [];
  const seen = new Set<NodeWsOptionalTarget>();
  for (const visit of compilers) {
    const specifier = selectedTarget(visit, parents);
    if (specifier === undefined || seen.has(specifier)) return undefined;
    seen.add(specifier);
    result.push(Object.freeze({ node: visit.node, specifier }));
  }
  return Object.freeze(result);
}
