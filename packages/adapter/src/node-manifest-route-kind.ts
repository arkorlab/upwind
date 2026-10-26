import { parseAst } from 'rolldown/parseAst';

import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import { inspectExportBindings } from './node-manifest-export-probe.ts';
import { reviewedRouteKindInitializer } from './node-manifest-route-kind-value.ts';
import type { NodeManifestTurbopackGraphFactory } from './node-manifest-turbopack-graph.ts';
import {
  defaultExportTarget,
  singleDirectExportValue,
  turbopackModuleId,
} from './node-manifest-turbopack-values.ts';
import { projectNodeManifestTurbopackFactory } from './node-manifest-turbopack.ts';

// next@16.4.3 dist/server/route-kind.js, SHA256 4dc92760c2e4925613034896faa04c52daaf7a4420d7bcbd6de5214b55d84fea.
export interface NodeManifestRouteKindProof {
  readonly kind: 'reviewed RouteKind member';
}
export interface NodeManifestRouteKindInput {
  readonly owner: { readonly identity: symbol };
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly exportName: string;
}
interface StoredProof {
  readonly owner: NodeManifestRouteKindInput['owner'];
  readonly factory: NodeManifestTurbopackGraphFactory;
  readonly projection: NodeManifestTurbopackGraphFactory['projection'];
  readonly original: NodeManifestTurbopackGraphFactory['projection']['original'];
  readonly exportName: string;
  readonly fingerprint: string;
}
const PROOFS = new WeakMap<NodeManifestRouteKindProof, StoredProof>();
const EXPORT_METHODS: ReadonlySet<string> = new Set(['n', 's', 'v']);
const SCALAR_FIELDS: ReadonlySet<string> = new Set([
  'APP_PAGE',
  'APP_ROUTE',
  'IMAGE',
  'PAGES',
  'PAGES_API',
]);

function parsed(code: string): Node | undefined {
  const value: unknown = parseAst(code);
  return isNode(value) ? value : undefined;
}

function bindingScope(visit: Visit, name: string): Scope | undefined {
  return visit.scopes.findLast((scope) => scope.declared.has(name));
}

function contextCall(call: Node, factory: Node, visits: ReadonlyMap<Node, Visit>): boolean {
  const member = call['callee'];
  const context = listOf(factory, 'params')[0];
  if (
    call.type !== 'CallExpression' ||
    call['optional'] === true ||
    !isNode(member) ||
    member.type !== 'MemberExpression' ||
    member['computed'] === true ||
    member['optional'] === true ||
    !EXPORT_METHODS.has(propertyName(member) ?? '') ||
    !identifier(context) ||
    !identifier(member['object']) ||
    member['object'].name !== context.name
  )
    return false;
  const factoryScope = visits.get(factory)?.scopes.at(-1);
  const visit = visits.get(member);
  return (
    visit !== undefined &&
    bindingScope(visit, context.name) === factoryScope &&
    factoryScope?.bindings.has(context.name) === false
  );
}

function selectedVariable(
  value: Node,
  body: Node,
  visits: ReadonlyMap<Node, Visit>,
): Node | undefined {
  if (!identifier(value)) return undefined;
  const bound = visits.get(value);
  const variable = bound === undefined ? undefined : declaration(value.name, bound.scopes)?.node;
  const statement = variable === undefined ? undefined : visits.get(variable)?.parent;
  return variable?.type === 'VariableDeclarator' &&
    identifier(variable['id']) &&
    isNode(variable['init']) &&
    statement?.type === 'VariableDeclaration' &&
    ['const', 'let', 'var'].includes(String(statement['kind'])) &&
    visits.get(statement)?.parent === body
    ? variable
    : undefined;
}

function unconditional(call: Node, body: Node, visits: ReadonlyMap<Node, Visit>): boolean {
  let expression = call;
  let parent = visits.get(expression)?.parent;
  while (
    parent?.type === 'SequenceExpression' &&
    listOf(parent, 'expressions').includes(expression)
  ) {
    expression = parent;
    parent = visits.get(expression)?.parent;
  }
  return parent?.type === 'ExpressionStatement' && visits.get(parent)?.parent === body;
}

function exportValue(
  input: NodeManifestRouteKindInput,
  visit: Visit,
  body: Node,
  visits: ReadonlyMap<Node, Visit>,
): Node | undefined {
  const args = listOf(visit.node, 'arguments');
  if (args.length === 0 || args.length > 2) return undefined;
  const id = turbopackModuleId(args[1]);
  if (
    (id === undefined && !defaultExportTarget(args[1], visit)) ||
    (id !== undefined && id !== input.factory.projection.moduleId) ||
    !unconditional(visit.node, body, visits)
  )
    return undefined;
  const direct = singleDirectExportValue(args[0], input.exportName);
  if (direct !== undefined && !identifier(direct)) return undefined;
  const binding = inspectExportBindings(args[0])?.find((entry) => entry.name === input.exportName);
  if (binding === undefined) return undefined;
  const variable = selectedVariable(binding.value, body, visits);
  return variable !== undefined && (binding.kind === 'getter' || variable.end < visit.node.start)
    ? binding.value
    : undefined;
}

function selectedValue(
  input: NodeManifestRouteKindInput,
  factory: Node,
  visits: ReadonlyMap<Node, Visit>,
): Node | undefined {
  const body = factory['body'];
  if (!isNode(body)) return undefined;
  const calls = [...visits.values()].filter((visit) => {
    if (!contextCall(visit.node, factory, visits)) return false;
    const target = listOf(visit.node, 'arguments')[1];
    return (
      defaultExportTarget(target, visit) ||
      turbopackModuleId(target) === input.factory.projection.moduleId
    );
  });
  const only = calls[0];
  const member = only?.node['callee'];
  if (only === undefined || calls.length !== 1 || !isNode(member) || propertyName(member) !== 's')
    return undefined;
  return exportValue(input, only, body, visits);
}

function commonJsUse(factory: Node, visits: ReadonlyMap<Node, Visit>): boolean {
  const scope = visits.get(factory)?.scopes.at(-1);
  const parameters = listOf(factory, 'params').slice(1).filter(identifier);
  for (const visit of visits.values()) {
    const node = visit.node;
    if (
      node.start < factory.start ||
      node.end > factory.end ||
      !identifier(node) ||
      !reference(visit)
    )
      continue;
    const bound = bindingScope(visit, node.name);
    if (
      (bound === scope && parameters.some((param) => param.name === node.name)) ||
      (bound === undefined && ['exports', 'module'].includes(node.name))
    )
      return true;
  }
  return false;
}

function extraDeclaration(visit: Visit): boolean {
  return (
    (visit.parent?.type === 'VariableDeclarator' && visit.key === 'id') ||
    (visit.parent?.type === 'FunctionDeclaration' && visit.key === 'id') ||
    (visit.parent?.type === 'ClassDeclaration' && visit.key === 'id')
  );
}

function targetParent(value: Node, parent: Node, visits: ReadonlyMap<Node, Visit>): boolean {
  if (parent.type === 'MemberExpression') return parent['object'] === value;
  if (parent.type === 'AssignmentPattern') return parent['left'] === value;
  if (parent.type === 'RestElement') return parent['argument'] === value;
  if (parent.type === 'Property')
    return parent['value'] === value && visits.get(parent)?.parent?.type === 'ObjectPattern';
  if (['ArrayPattern', 'ObjectPattern'].includes(parent.type)) return true;
  if (parent.type === 'SequenceExpression') return listOf(parent, 'expressions').at(-1) === value;
  return ['ConditionalExpression', 'LogicalExpression'].includes(parent.type);
}

function writeTarget(member: Node, visits: ReadonlyMap<Node, Visit>): boolean {
  let value = member;
  for (
    let parent = visits.get(value)?.parent;
    parent !== undefined;
    parent = visits.get(value)?.parent
  ) {
    if (
      (parent.type === 'AssignmentExpression' ||
        ['ForInStatement', 'ForOfStatement'].includes(parent.type)) &&
      parent['left'] === value
    )
      return true;
    if (
      (parent.type === 'UpdateExpression' ||
        (parent.type === 'UnaryExpression' && parent['operator'] === 'delete')) &&
      parent['argument'] === value
    )
      return true;
    if (!targetParent(value, parent, visits)) return false;
    value = parent;
  }
  return false;
}

function scalarField(member: Node): string | undefined {
  const property = member['property'];
  if (member['computed'] === true)
    return isNode(property) && property.type === 'Literal' && typeof property['value'] === 'string'
      ? property['value']
      : undefined;
  return identifier(property) ? property.name : undefined;
}

function scalarRead(visit: Visit, variable: Node, visits: ReadonlyMap<Node, Visit>): boolean {
  const member = visit.parent;
  if (
    visit.key !== 'object' ||
    member?.type !== 'MemberExpression' ||
    member['optional'] === true ||
    member.start <= variable.end
  )
    return false;
  const key = scalarField(member);
  return key !== undefined && SCALAR_FIELDS.has(key) && !writeTarget(member, visits);
}

function closedBinding(
  selected: Node & { readonly name: string },
  variable: Node,
  visits: ReadonlyMap<Node, Visit>,
): boolean {
  const own = visits.get(selected);
  const scope = own === undefined ? undefined : bindingScope(own, selected.name);
  if (scope === undefined) return false;
  for (const visit of visits.values()) {
    const node = visit.node;
    if (
      node === selected ||
      node === variable['id'] ||
      !identifier(node) ||
      node.name !== selected.name ||
      bindingScope(visit, node.name) !== scope
    )
      continue;
    if ((reference(visit) && !scalarRead(visit, variable, visits)) || extraDeclaration(visit))
      return false;
  }
  return true;
}

function reviewed(input: NodeManifestRouteKindInput): boolean {
  const supplied = input.factory.projection;
  const fresh = projectNodeManifestTurbopackFactory(
    supplied.original,
    supplied.moduleId,
    supplied.mode,
  );
  if (
    JSON.stringify(fresh) !== JSON.stringify(supplied) ||
    !fresh.factory.ids.includes(fresh.moduleId)
  )
    return false;
  const program = parsed(fresh.original.code);
  if (program === undefined) return false;
  const all = visitTree(program);
  const visits = new Map(all.map((visit) => [visit.node, visit]));
  const factories = all.filter(
    (visit) => visit.node.start === fresh.factory.start && visit.node.end === fresh.factory.end,
  );
  const factory = factories[0]?.node;
  if (factory === undefined || factories.length !== 1 || commonJsUse(factory, visits)) return false;
  const selected = selectedValue(input, factory, visits);
  if (!identifier(selected)) return false;
  const visit = visits.get(selected);
  const variable = visit === undefined ? undefined : declaration(selected.name, visit.scopes)?.node;
  const initializer = variable?.['init'];
  return (
    variable !== undefined &&
    isNode(initializer) &&
    closedBinding(selected, variable, visits) &&
    isNode(factory['body']) &&
    reviewedRouteKindInitializer(initializer, { body: factory['body'], visits })
  );
}

/** A selected enum member grants only template inspection identity, never loader authority. */
export function certifyNodeManifestRouteKind(
  input: NodeManifestRouteKindInput,
): NodeManifestRouteKindProof | undefined {
  if (!reviewed(input)) return undefined;
  const proof: NodeManifestRouteKindProof = Object.freeze({ kind: 'reviewed RouteKind member' });
  PROOFS.set(proof, {
    owner: input.owner,
    factory: input.factory,
    projection: input.factory.projection,
    original: input.factory.projection.original,
    exportName: input.exportName,
    fingerprint: JSON.stringify(input.factory),
  });
  return proof;
}

/** Fresh source, selected-ID, lexical export and mint-time pointer checks are mandatory. */
export function nodeManifestRouteKindMember(
  proof: NodeManifestRouteKindProof,
  input: NodeManifestRouteKindInput,
): 'RouteKind' | undefined {
  const stored = PROOFS.get(proof);
  if (
    stored?.owner !== input.owner ||
    stored.factory !== input.factory ||
    stored.projection !== input.factory.projection ||
    stored.original !== input.factory.projection.original ||
    stored.exportName !== input.exportName ||
    stored.fingerprint !== JSON.stringify(input.factory) ||
    !reviewed(input)
  )
    return undefined;
  return 'RouteKind';
}
