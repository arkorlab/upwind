import { isNode, listOf, type Node } from './lexical-scope.ts';

export type NodeClosureBuiltin = 'child_process' | 'module' | 'process' | 'vm';
export interface NodeClosureOrigin {
  readonly builtin: NodeClosureBuiltin;
  readonly member?: string;
}

/** Conservative value-arm taint for an already proved assignment host, never an operation grant. */
export function assignedNodeChoiceOrigin(
  node: Node,
  originOf: (value: unknown) => NodeClosureOrigin | undefined,
): NodeClosureOrigin | undefined {
  const choices =
    node.type === 'ConditionalExpression'
      ? [node['consequent'], node['alternate']]
      : [node['left'], node['right']];
  const known = choices.map((choice) => originOf(choice)).filter((choice) => choice !== undefined);
  const first = known[0];
  return first === undefined ||
    known.every((choice) => choice.builtin === first.builtin && choice.member === first.member)
    ? first
    : { builtin: first.builtin, member: '*' };
}

/** Original namespace aliases remain tracked; process value arms also retain their taint. */
export function nodeNamespaceAliasUse(
  visit: { readonly parent: Node | undefined; readonly key: string | undefined },
  process: boolean,
): boolean {
  return (
    (visit.parent?.type === 'VariableDeclarator' &&
      visit.key === 'init' &&
      (!process || processMetadataPattern(visit.parent['id']))) ||
    (visit.parent?.type === 'MemberExpression' && visit.key === 'object') ||
    (process &&
      visit.parent?.type === 'UnaryExpression' &&
      visit.parent['operator'] === 'typeof' &&
      visit.key === 'argument') ||
    (process && ['ConditionalExpression', 'LogicalExpression'].includes(visit.parent?.type ?? ''))
  );
}

function processMetadataPattern(pattern: unknown): boolean {
  if (!isNode(pattern) || pattern.type !== 'ObjectPattern') return false;
  return listOf(pattern, 'properties').every((property) => {
    if (
      !isNode(property) ||
      property.type !== 'Property' ||
      property['computed'] === true ||
      property['kind'] !== 'init'
    )
      return false;
    const key = property['key'];
    const value = property['value'];
    return (
      isNode(key) &&
      key.type === 'Identifier' &&
      ['env', 'stdout'].includes(String(key['name'])) &&
      isNode(value) &&
      value.type === 'Identifier'
    );
  });
}
