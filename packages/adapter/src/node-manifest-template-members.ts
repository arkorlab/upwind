import { isNode, type Node } from './lexical-scope.ts';
import { identifier, propertyName, visitTree } from './node-manifest-consumer-ast.ts';

const TEMPLATE_MEMBERS: ReadonlySet<string> = new Set([
  'APP_ROUTE',
  'AppRouteRouteModule',
  'default',
  'getHandler',
  'hoist',
  'PAGES',
  'PAGES_API',
  'PagesAPIRouteModule',
  'PagesRouteModule',
  'RouteKind',
]);

/** A literal export read only; callers still authenticate its original namespace binding. */
export function nodeManifestTemplateMemberKey(node: Node): string | undefined {
  if (node.type !== 'MemberExpression' || node['optional'] === true || !identifier(node['object']))
    return undefined;
  if (node['computed'] !== true) return propertyName(node);
  const key = node['property'];
  return isNode(key) &&
    key.type === 'Literal' &&
    !('regex' in key) &&
    !('bigint' in key) &&
    typeof key['value'] === 'string'
    ? key['value']
    : undefined;
}

/** Finite fixed-template selector DATA; compact helper exports need their separate opaque proof. */
export function nodeManifestTemplateMemberName(node: Node): string | undefined {
  const key = nodeManifestTemplateMemberKey(node);
  return key !== undefined && TEMPLATE_MEMBERS.has(key) ? key : undefined;
}

export function nodeManifestTemplateConstructors(program: Node, name: string): readonly Node[] {
  return visitTree(program).flatMap((visit) => {
    const callee = visit.node['callee'];
    return visit.node.type === 'NewExpression' &&
      isNode(callee) &&
      callee.type === 'MemberExpression' &&
      (propertyName(callee) ?? nodeManifestTemplateMemberKey(callee)) === name
      ? [visit.node]
      : [];
  });
}
