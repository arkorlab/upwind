import { parseAst } from 'rolldown/parseAst';

import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { hostObjectOf, hostPropertyName } from './node-closure-hosts.ts';
import {
  declaration,
  identifier,
  reference,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';

const GLOBAL_AUTHORITIES: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'eval',
  'Function',
  'global',
  'globalThis',
  'process',
  'prototype',
]);
const PATTERNS: ReadonlySet<string> = new Set([
  'ArrayPattern',
  'AssignmentPattern',
  'ObjectPattern',
  'Property',
  'RestElement',
]);
const METADATA_OPERATORS: ReadonlySet<string> = new Set(['!', 'typeof', 'void']);
const DYNAMIC_GLOBAL_ACCESS = 'dynamic or optional global access';
const GLOBAL_SLOT = '_globalThis';
const MODULE_MARKER_ARGUMENTS = 3;
const RECEIVER_META: ReadonlySet<string> = new Set([
  '__proto__',
  'arguments',
  'callee',
  'caller',
  'constructor',
  'prototype',
]);
const FUNCTION_NODES: ReadonlySet<string> = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest ${reason}; refusing native publication`,
  );
}

function unsafeGlobalPattern(pattern: Node): boolean {
  if (pattern.type !== 'ObjectPattern') return true;
  return listOf(pattern, 'properties').some((property) => {
    if (!isNode(property) || property.type !== 'Property') return true;
    const key = hostPropertyName(property);
    const value = property['value'];
    return (
      key === undefined ||
      GLOBAL_AUTHORITIES.has(key) ||
      (!identifier(value) &&
        (!isNode(value) || value.type !== 'AssignmentPattern' || !identifier(value['left'])))
    );
  });
}

/** Destructuring must not hide a known global compiler or loader namespace from its later uses. */
export function globalPatternRefusal(node: Node, scopes: readonly Scope[]): string | undefined {
  const pattern = node.type === 'VariableDeclarator' ? node['id'] : node['left'];
  const value = node.type === 'VariableDeclarator' ? node['init'] : node['right'];
  if (
    !['AssignmentExpression', 'VariableDeclarator'].includes(node.type) ||
    !isNode(pattern) ||
    !['ArrayPattern', 'ObjectPattern'].includes(pattern.type) ||
    hostObjectOf(value, scopes) !== 'global'
  )
    return undefined;
  return unsafeGlobalPattern(pattern)
    ? 'an unproved global compiler or loader destructuring'
    : undefined;
}

function directWrite(parent: Node, current: Node): boolean | undefined {
  if (parent.type === 'AssignmentExpression') return parent['left'] === current;
  if (parent.type === 'UpdateExpression') return parent['argument'] === current;
  if (parent.type === 'UnaryExpression') return parent['operator'] === 'delete';
  if (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement')
    return parent['left'] === current;
  return undefined;
}

function containsTarget(parent: Node, current: Node): boolean {
  if (!PATTERNS.has(parent.type)) return false;
  if (parent.type === 'Property') return parent['value'] === current;
  return parent.type !== 'AssignmentPattern' || parent['left'] === current;
}

function writeTarget(node: Node, parents: ReadonlyMap<Node, Visit>): boolean {
  let current = node;
  for (
    let parent = parents.get(current)?.parent;
    parent !== undefined;
    parent = parents.get(current)?.parent
  ) {
    if (parent.type === 'MemberExpression' && parent['object'] === current) {
      current = parent;
      continue;
    }
    const direct = directWrite(parent, current);
    if (direct !== undefined) return direct;
    if (!containsTarget(parent, current)) return false;
    current = parent;
  }
  return false;
}

/** This inspection replacement must bind to the actual global, not a factory or class local. */
export function assertGlobalContextRead(
  member: Node,
  visit: Visit,
  parents: ReadonlyMap<Node, Visit>,
): void {
  if (declaration('globalThis', visit.scopes) !== undefined)
    refuse('shadowed inspection globalThis');
  if (writeTarget(member, parents)) refuse('global context write');
  let current = member;
  for (
    let parent = parents.get(current)?.parent;
    parent?.type === 'MemberExpression' && parent['object'] === current;
    parent = parents.get(current)?.parent
  ) {
    if (parent['optional'] === true || hostPropertyName(parent) === undefined)
      refuse(DYNAMIC_GLOBAL_ACCESS);
    current = parent;
  }
  const parent = parents.get(current)?.parent;
  if (
    parent?.type === 'CallExpression' &&
    parent['callee'] === current &&
    parent['optional'] === true
  )
    refuse(DYNAMIC_GLOBAL_ACCESS);
}

function globalRoot(node: Node, scopes: readonly Scope[]): boolean {
  let current = node;
  while (current.type === 'MemberExpression') {
    const owner = current['object'];
    if (!isNode(owner)) return false;
    current = owner;
  }
  return hostObjectOf(current, scopes) === 'global';
}

function globalTypeof(value: unknown, scopes: readonly Scope[]): boolean {
  return (
    isNode(value) &&
    value.type === 'UnaryExpression' &&
    value['operator'] === 'typeof' &&
    identifier(value['argument']) &&
    value['argument'].name === 'globalThis' &&
    declaration('globalThis', scopes) === undefined
  );
}

function objectTypeLiteral(value: unknown): boolean {
  return isNode(value) && value.type === 'Literal' && value['value'] === 'object';
}

function fallbackPredicate(value: unknown, scopes: readonly Scope[]): boolean {
  if (
    !isNode(value) ||
    value.type !== 'BinaryExpression' ||
    !['==', '==='].includes(String(value['operator']))
  )
    return false;
  const left = value['left'];
  const right = value['right'];
  // Both operands are strings, so == and === have the same result in exactly this grammar.
  return (
    (globalTypeof(left, scopes) && objectTypeLiteral(right)) ||
    (objectTypeLiteral(left) && globalTypeof(right, scopes))
  );
}

function fallbackAssignment(visit: Visit, parents: ReadonlyMap<Node, Visit>): Node | undefined {
  const conditional = visit.node;
  if (
    conditional.type !== 'ConditionalExpression' ||
    !fallbackPredicate(conditional['test'], visit.scopes)
  )
    return undefined;
  if (
    hostObjectOf(conditional['consequent'], visit.scopes) !== 'global' ||
    hostObjectOf(conditional['alternate'], visit.scopes) !== 'global'
  )
    return undefined;
  const assignment = parents.get(conditional)?.parent;
  const target = assignment?.['left'];
  return assignment?.type === 'AssignmentExpression' &&
    assignment['operator'] === '=' &&
    assignment['right'] === conditional &&
    isNode(target) &&
    target.type === 'MemberExpression' &&
    target['optional'] !== true &&
    hostPropertyName(target) === GLOBAL_SLOT &&
    identifier(target['object'])
    ? assignment
    : undefined;
}

function bindingScope(name: string, scopes: readonly Scope[]): Scope | undefined {
  return scopes.findLast((scope) => scope.declared.has(name));
}

function zero(value: unknown, operator: string): boolean {
  if (!isNode(value) || value.type !== 'UnaryExpression' || value['operator'] !== operator)
    return false;
  const argument = value['argument'];
  return isNode(argument) && argument.type === 'Literal' && argument['value'] === 0;
}

function markerDescriptor(value: unknown): boolean {
  if (!isNode(value) || value.type !== 'ObjectExpression') return false;
  const properties = listOf(value, 'properties');
  const property = properties[0];
  if (
    properties.length !== 1 ||
    !isNode(property) ||
    property.type !== 'Property' ||
    property['kind'] !== 'init' ||
    property['method'] === true ||
    hostPropertyName(property) !== 'value'
  )
    return false;
  const result = property['value'];
  return (
    (isNode(result) && result.type === 'Literal' && result['value'] === true) || zero(result, '!')
  );
}

function moduleMarker(call: Node, receiver: Node, scopes: readonly Scope[]): boolean {
  const callee = call['callee'];
  const args = listOf(call, 'arguments');
  const key = args[1];
  return (
    call.type === 'CallExpression' &&
    call['optional'] !== true &&
    isNode(callee) &&
    callee.type === 'MemberExpression' &&
    callee['optional'] !== true &&
    identifier(callee['object']) &&
    callee['object'].name === 'Object' &&
    declaration('Object', scopes) === undefined &&
    hostPropertyName(callee) === 'defineProperty' &&
    args.length === MODULE_MARKER_ARGUMENTS &&
    args[0] === receiver &&
    isNode(key) &&
    key.type === 'Literal' &&
    key['value'] === '__esModule' &&
    markerDescriptor(args[2])
  );
}

interface GlobalSlot {
  readonly scope: Scope;
  readonly name: string;
  readonly declaration: Node | undefined;
  readonly fallback: Node;
  initializer?: Node;
}

/** This producer's exported slot is opaque: no same-binding read or receiver handoff is proved. */
class GlobalSlots {
  private readonly parents: ReadonlyMap<Node, Visit>;
  private readonly slots = new Map<Scope, Map<string, GlobalSlot>>();
  private readonly assignments = new Set<Node>();

  constructor(visits: readonly Visit[], parents: ReadonlyMap<Node, Visit>) {
    this.parents = parents;
    const owners = new Map<Scope, Node>();
    for (const visit of visits) {
      const scope = visit.scopes.at(-1);
      if (scope !== undefined && !owners.has(scope)) owners.set(scope, visit.node);
    }
    for (const visit of visits) this.capture(visit, owners);
  }

  private localReceiver(name: string, scope: Scope, owners: ReadonlyMap<Scope, Node>): boolean {
    const owner = owners.get(scope);
    const binding = scope.bindings.get(name);
    if (
      owner !== undefined &&
      FUNCTION_NODES.has(owner.type) &&
      listOf(owner, 'params').some((param) => identifier(param) && param.name === name)
    )
      return binding === undefined;
    if (binding?.type !== 'VariableDeclarator' || !identifier(binding['id'])) return false;
    const value = binding['init'];
    return (
      isNode(value) && value.type === 'ObjectExpression' && listOf(value, 'properties').length === 0
    );
  }

  private capture(visit: Visit, owners: ReadonlyMap<Scope, Node>): void {
    const assignment = fallbackAssignment(visit, this.parents);
    const target = assignment?.['left'];
    const receiver = isNode(target) ? target['object'] : undefined;
    if (assignment === undefined || !identifier(receiver)) return;
    const scope = bindingScope(receiver.name, visit.scopes);
    if (scope === undefined || !this.localReceiver(receiver.name, scope, owners)) return;
    const named = this.slots.get(scope) ?? new Map<string, GlobalSlot>();
    if (named.has(receiver.name)) refuse('multiple stored global initializers');
    named.set(receiver.name, {
      scope,
      name: receiver.name,
      declaration: scope.bindings.get(receiver.name),
      fallback: assignment,
    });
    this.slots.set(scope, named);
    this.assignments.add(assignment);
  }

  private initializer(member: Node, slot: GlobalSlot): boolean {
    const assignment = this.parents.get(member)?.parent;
    if (assignment === slot.fallback) return true;
    if (
      assignment?.type !== 'AssignmentExpression' ||
      assignment['operator'] !== '=' ||
      assignment['left'] !== member ||
      !zero(assignment['right'], 'void') ||
      assignment.end >= slot.fallback.start
    )
      return false;
    if (slot.initializer !== undefined && slot.initializer !== assignment)
      refuse('multiple stored global zero initializers');
    slot.initializer = assignment;
    return true;
  }

  private implicitAlias(visit: Visit): boolean {
    const { node, scopes } = visit;
    const implicit =
      node.type === 'ThisExpression' ||
      (identifier(node) && node.name === 'arguments' && reference(visit)) ||
      (node.type === 'MemberExpression' && RECEIVER_META.has(hostPropertyName(node) ?? ''));
    return implicit && scopes.some((scope) => this.slots.has(scope));
  }

  fallback(visit: Visit): boolean {
    const conditional = visit.parent;
    const assignment =
      conditional === undefined ? undefined : this.parents.get(conditional)?.parent;
    return (
      conditional?.type === 'ConditionalExpression' &&
      assignment !== undefined &&
      this.assignments.has(assignment)
    );
  }

  assert(visit: Visit): void {
    if (this.implicitAlias(visit)) refuse('unproved stored global receiver alias');
    const { node, scopes, parent } = visit;
    if (!identifier(node)) return;
    const scope = bindingScope(node.name, scopes);
    const slot = scope === undefined ? undefined : this.slots.get(scope)?.get(node.name);
    if (slot === undefined) return;
    if (
      parent?.type === 'VariableDeclarator' &&
      parent['id'] === node &&
      parent !== slot.declaration
    )
      refuse('stored global receiver rebinding');
    if (!reference(visit)) return;
    if (
      parent?.type === 'MemberExpression' &&
      parent['object'] === node &&
      parent['optional'] !== true &&
      hostPropertyName(parent) === GLOBAL_SLOT &&
      this.initializer(parent, slot)
    )
      return;
    if (parent?.type === 'CallExpression' && moduleMarker(parent, node, scopes)) return;
    refuse('stored global slot read or receiver escape');
  }
}

function permittedGlobalValue(visit: Visit, slots: GlobalSlots): boolean {
  const parent = visit.parent;
  if (parent?.type === 'MemberExpression' && visit.key === 'object') return true;
  if (parent?.type === 'VariableDeclarator' && visit.key === 'init') return true;
  if (parent?.type === 'UnaryExpression') return METADATA_OPERATORS.has(String(parent['operator']));
  if (parent?.type === 'BinaryExpression')
    return ['!==', '==='].includes(String(parent['operator']));
  return slots.fallback(visit);
}

function assertGlobalVisit(
  visit: Visit,
  parents: ReadonlyMap<Node, Visit>,
  slots: GlobalSlots,
): void {
  const { node, scopes } = visit;
  if (node.type === 'MemberExpression' && globalRoot(node, scopes)) {
    if (node['optional'] === true || hostPropertyName(node) === undefined)
      refuse(DYNAMIC_GLOBAL_ACCESS);
    if (writeTarget(node, parents)) refuse('global context write');
  }
  if (
    node.type === 'CallExpression' &&
    node['optional'] === true &&
    isNode(node['callee']) &&
    globalRoot(node['callee'], scopes)
  )
    refuse(DYNAMIC_GLOBAL_ACCESS);
  if (
    ['Identifier', 'MemberExpression'].includes(node.type) &&
    reference(visit) &&
    hostObjectOf(node, scopes) === 'global' &&
    !permittedGlobalValue(visit, slots)
  )
    refuse('global namespace escape');
}

/** An inert arrow preserves factory-body return syntax without adding a named inspection binding. */
export function normalizedGlobalInspection(code: string): string {
  const wrapped = `(()=>{\n${code}\n});`;
  const program: unknown = parseAst(wrapped);
  if (!isNode(program)) refuse('global inspection parser');
  const visits = visitTree(program);
  const parents = new Map(visits.map((visit) => [visit.node, visit]));
  const slots = new GlobalSlots(visits, parents);
  for (const visit of visits) {
    slots.assert(visit);
    assertGlobalVisit(visit, parents, slots);
  }
  return wrapped;
}
