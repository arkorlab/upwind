import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { hostObjectOf, hostPropertyName, type AssignedNodeHosts } from './node-closure-hosts.ts';
import { declaration, identifier, reference, visitTree } from './node-manifest-consumer-ast.ts';

const MAX_NODES = 100_000;

/** Existing closure classification, shared without changing its ordinary refusal rules. */
export function isGlobalCompiler(
  node: Node,
  scopes: readonly Scope[],
  assigned?: AssignedNodeHosts,
): boolean {
  if (identifier(node))
    return ['eval', 'Function'].includes(node.name) && declaration(node.name, scopes) === undefined;
  if (
    node.type !== 'MemberExpression' ||
    hostObjectOf(node['object'], scopes, new Set(), assigned) !== 'global'
  )
    return false;
  return ['eval', 'Function'].includes(hostPropertyName(node) ?? '');
}

function literal(value: unknown, expected: string): boolean {
  return isNode(value) && value.type === 'Literal' && value['value'] === expected;
}

/** Shape DATA only. This never grants a compiler exception without the private whole-source proof. */
export function nodeJwtGlobalRecoverySite(program: unknown): Node | undefined {
  if (!isNode(program)) return undefined;
  const visits = visitTree(program);
  if (visits.length > MAX_NODES) return undefined;
  const parents = new Map(visits.map((visit) => [visit.node, visit.parent]));
  const compilers = visits.filter((visit) => {
    return (
      identifier(visit.node) &&
      ['eval', 'Function'].includes(visit.node.name) &&
      reference(visit) &&
      declaration(visit.node.name, visit.scopes) === undefined
    );
  });
  const compiler = compilers[0]?.node;
  if (compilers.length !== 1 || !identifier(compiler) || compiler.name !== 'Function')
    return undefined;
  const create = parents.get(compiler);
  const invoke = create === undefined ? undefined : parents.get(create);
  return create?.type === 'CallExpression' &&
    create['callee'] === compiler &&
    create['optional'] !== true &&
    listOf(create, 'arguments').length === 1 &&
    literal(listOf(create, 'arguments')[0], 'return this') &&
    invoke?.type === 'CallExpression' &&
    invoke['callee'] === create &&
    invoke['optional'] !== true &&
    listOf(invoke, 'arguments').length === 0
    ? compiler
    : undefined;
}

/** Every acquisition of this actual edge is a literal host require, never an ESM load role. */
export function nodeJwtRequireOnly(code: string, specifier: string): boolean {
  const program: unknown = parseAst(code, { sourceType: 'commonjs' });
  if (!isNode(program)) return false;
  const visits = visitTree(program);
  if (visits.length > MAX_NODES) return false;
  let found = false;
  for (const { node, scopes } of visits) {
    if (
      node.type === 'ImportExpression' ||
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration'
    )
      return false;
    if (
      node.type !== 'CallExpression' ||
      !identifier(node['callee']) ||
      node['callee'].name !== 'require' ||
      declaration('require', scopes) !== undefined
    )
      continue;
    const args = listOf(node, 'arguments');
    // An unknown loader operand could reach this file too; it is not an unrelated safe edge.
    if (node['optional'] === true || args.length !== 1 || !isNode(args[0])) return false;
    const value = args[0];
    if (value.type !== 'Literal' || typeof value['value'] !== 'string') return false;
    if (value['value'] === specifier) found = true;
  }
  return found;
}
