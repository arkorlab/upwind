import { isNode, type Node, type Scope } from './lexical-scope.ts';

export interface NodeCompilerMetadataVisit {
  readonly node: Node;
  readonly parent: Node | undefined;
  readonly key: string | undefined;
  readonly scopes: readonly Scope[];
}

/** A key or binding name is not a reference to the global or namespace it spells. */
export function nodeClosureReference({ parent, key }: NodeCompilerMetadataVisit): boolean {
  if (parent === undefined) return true;
  if (parent.type.startsWith('Import')) return false;
  if (key === 'id' && parent.type === 'VariableDeclarator') return false;
  if (key === 'params' || (key === 'id' && parent.type.endsWith('Declaration'))) return false;
  if (
    (key === 'property' && parent.type === 'MemberExpression') ||
    (key === 'key' && (parent.type === 'Property' || parent.type === 'MethodDefinition'))
  )
    return parent['computed'] === true;
  return true;
}
function dot(visit: NodeCompilerMetadataVisit | undefined, child: Node, name: string): boolean {
  const node = visit?.node;
  const property = node?.['property'];
  return (
    node?.type === 'MemberExpression' &&
    node['object'] === child &&
    node['computed'] !== true &&
    node['optional'] !== true &&
    isNode(property) &&
    property.type === 'Identifier' &&
    property['name'] === name
  );
}
function underWith(node: Node, parents: ReadonlyMap<Node, NodeCompilerMetadataVisit>): boolean {
  let parent = parents.get(node)?.parent;
  while (parent !== undefined) {
    if (parent.type === 'WithStatement') return true;
    parent = parents.get(parent)?.parent;
  }
  return false;
}

/**
 * Function.prototype.bind is an ordinary method value, not the Function constructor.
 * TC39 20.2.3.2 creates a BoundFunction when invoked; it does not compile source strings.
 * Initially recognize only an exact simple binding initializer. No module or hash exception.
 */
export function nodeCompilerMetadataSites(
  visits: readonly NodeCompilerMetadataVisit[],
): ReadonlySet<Node> {
  const parents = new Map(visits.map((visit) => [visit.node, visit]));
  const sites = new Set<Node>();
  for (const visit of visits) {
    const node = visit.node;
    if (
      node.type !== 'Identifier' ||
      node['name'] !== 'Function' ||
      visit.scopes.some((scope) => scope.declared.has('Function'))
    )
      continue;
    const prototype = visit.parent;
    if (prototype === undefined || !dot(parents.get(prototype), node, 'prototype')) continue;
    const bind = parents.get(prototype)?.parent;
    if (bind === undefined || !dot(parents.get(bind), prototype, 'bind')) continue;
    const declaration = parents.get(bind)?.parent;
    const id = declaration?.['id'];
    if (
      declaration?.type !== 'VariableDeclarator' ||
      declaration['init'] !== bind ||
      !isNode(id) ||
      id.type !== 'Identifier' ||
      underWith(node, parents)
    )
      continue;
    sites.add(node);
  }
  return sites;
}
