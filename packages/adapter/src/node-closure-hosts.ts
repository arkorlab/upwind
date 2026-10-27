import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import type { NodeClosureOrigin } from './node-closure-assigned-origins.ts';
import { nodeClosureReference } from './node-compiler-metadata.ts';

const COMMON_JS_HOST = 'cjs-module';
type HostObject = 'global' | typeof COMMON_JS_HOST;
export type AssignedNodeHosts = ReadonlyMap<Node, 'global'>;
const NO_ASSIGNED_HOSTS: AssignedNodeHosts = new Map();
const NO_METADATA_ROOTS: ReadonlySet<Node> = new Set();
interface HostVisit {
  readonly node: Node;
  readonly scopes: readonly Scope[];
  readonly parent: Node | undefined;
  readonly key: string | undefined;
}
type AssignedHostRejectionReason = 'optional' | 'computed' | 'loader' | 'write' | 'global-escape';
export interface AssignedNodeHostsAnalysis {
  readonly assigned: AssignedNodeHosts;
  readonly rejection:
    | { readonly visit: HostVisit; readonly reason: AssignedHostRejectionReason }
    | undefined;
  readonly diagnostic: string;
}

function namedHost(name: unknown): HostObject | undefined {
  if (name === 'globalThis' || name === 'global') return 'global';
  return name === 'module' ? COMMON_JS_HOST : undefined;
}

function aliasedHost(
  value: Node,
  scopes: readonly Scope[],
  seen: Set<Node>,
  assigned: AssignedNodeHosts,
): HostObject | undefined {
  const name = value['name'];
  if (typeof name !== 'string') return undefined;
  for (let at = scopes.length - 1; at >= 0; at -= 1) {
    const scope = scopes[at];
    if (scope?.declared.has(name) === true)
      return hostObjectOf(scope.bindings.get(name), scopes.slice(0, at + 1), seen, assigned);
  }
  return namedHost(name);
}

export function hostPropertyName(value: Node): string | undefined {
  const property = value['property'] ?? value['key'];
  if (!isNode(property)) return undefined;
  const name =
    value['computed'] !== true && property.type === 'Identifier'
      ? property['name']
      : property['value'];
  if (typeof name === 'string') return name;
  if (property.type !== 'TemplateLiteral' || listOf(property, 'expressions').length > 0)
    return undefined;
  const first = listOf(property, 'quasis')[0];
  const data = isNode(first) ? first['value'] : undefined;
  return typeof data === 'object' &&
    data !== null &&
    'cooked' in data &&
    typeof data.cooked === 'string'
    ? data.cooked
    : undefined;
}

function hostMember(value: Node, owner: HostObject | undefined): HostObject | undefined {
  const member = hostPropertyName(value);
  if (owner === 'global') return namedHost(member);
  return owner === COMMON_JS_HOST && member === 'parent' ? owner : undefined;
}

/** Only unshadowed host objects and their lexical aliases; ordinary objects stay ordinary. */
export function hostObjectOf(
  value: unknown,
  scopes: readonly Scope[],
  seen = new Set<Node>(),
  assigned: AssignedNodeHosts = NO_ASSIGNED_HOSTS,
): HostObject | undefined {
  let current = value;
  while (isNode(current) && !seen.has(current)) {
    seen.add(current);
    if (assigned.has(current)) return 'global';
    if (current.type === 'VariableDeclarator') {
      current = current['init'];
      continue;
    }
    if (current.type === 'Identifier') return aliasedHost(current, scopes, seen, assigned);
    if (current.type !== 'MemberExpression') return undefined;
    const owner = hostObjectOf(current['object'], scopes, seen, assigned);
    return hostMember(current, owner);
  }
  return undefined;
}

/** The existing CommonJS/global member mapping, shared with the closure traversal. */
export function nodeHostMemberOrigin(
  value: Node,
  scopes: readonly Scope[],
  member: string | undefined,
  assigned?: AssignedNodeHosts,
): NodeClosureOrigin | undefined {
  const owner = hostObjectOf(value['object'], scopes, new Set(), assigned);
  if (owner === 'global' && member === 'process') return { builtin: 'process' };
  if (owner !== 'cjs-module') return undefined;
  if (member === 'constructor') return { builtin: 'module', member: 'Module' };
  if (member === 'require' || member === 'load') return { builtin: 'module', member: 'load' };
  return member === undefined ? { builtin: 'module', member: '*' } : undefined;
}

export function nodeHostBinding(
  name: string,
  scopes: readonly Scope[],
): { scope: Scope; node: Node | undefined; scopes: readonly Scope[] } | undefined {
  for (let at = scopes.length - 1; at >= 0; at -= 1) {
    const scope = scopes[at];
    if (scope?.declared.has(name) === true) {
      const node = scope.bindings.get(name);
      return { scope, node, scopes: scopes.slice(0, at + 1) };
    }
  }
  return undefined;
}

function directWrite(parent: Node, value: Node): boolean | undefined {
  if (parent.type === 'AssignmentExpression') return parent['left'] === value;
  if (parent.type === 'UpdateExpression') return parent['argument'] === value;
  if (parent.type === 'UnaryExpression') return parent['operator'] === 'delete';
  if (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement')
    return parent['left'] === value;
  return undefined;
}

export function nodeHostIdentifier(
  value: unknown,
  name?: string,
): value is Node & { readonly type: 'Identifier'; readonly name: string } {
  return (
    isNode(value) &&
    value.type === 'Identifier' &&
    typeof value['name'] === 'string' &&
    (name === undefined || value['name'] === name)
  );
}

function writeTarget(node: Node, parents: ReadonlyMap<Node, HostVisit>): boolean {
  let value = node;
  for (
    let parent = parents.get(value)?.parent;
    parent !== undefined;
    parent = parents.get(value)?.parent
  ) {
    if (parent.type === 'MemberExpression' && parent['object'] === value) {
      value = parent;
      continue;
    }
    const write = directWrite(parent, value);
    if (write !== undefined) return write;
    if (parent.type === 'Property' && parent['value'] !== value) return false;
    if (parent.type === 'AssignmentPattern' && parent['left'] !== value) return false;
    if (
      !['ArrayPattern', 'AssignmentPattern', 'ObjectPattern', 'Property', 'RestElement'].includes(
        parent.type,
      )
    )
      return false;
    value = parent;
  }
  return false;
}

function unsupportedAliasScope(node: Node, parents: ReadonlyMap<Node, HostVisit>): boolean {
  let current = node;
  for (
    let parent = parents.get(node)?.parent;
    parent !== undefined;
    parent = parents.get(parent)?.parent
  ) {
    if (parent.type === 'WithStatement') return true;
    // Body vars and default parameters have distinct environments; do not infer across them.
    if (listOf(parent, 'params').includes(current)) return true;
    current = parent;
  }
  return false;
}

function boundNames(value: unknown): string[] {
  const names: string[] = [];
  const pending = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!isNode(node)) continue;
    if (nodeHostIdentifier(node)) {
      names.push(node.name);
      continue;
    }
    switch (node.type) {
      case 'Property': {
        pending.push(node['value']);
        break;
      }
      case 'RestElement': {
        pending.push(node['argument']);
        break;
      }
      case 'AssignmentPattern': {
        pending.push(node['left']);
        break;
      }
      case 'ObjectPattern': {
        pending.push(...listOf(node, 'properties'));
        break;
      }
      case 'ArrayPattern': {
        pending.push(...listOf(node, 'elements'));
        break;
      }
      default:
    }
  }
  return names;
}

function plainBinding(
  name: string,
  owner: Scope,
  declaration: Node,
  visits: readonly HostVisit[],
): boolean {
  let declarations = 0;
  for (const visit of visits) {
    const node = visit.node;
    if (
      node.type === 'VariableDeclarator' &&
      boundNames(node['id']).includes(name) &&
      nodeHostBinding(name, visit.scopes)?.scope === owner
    )
      declarations += 1;
    if (
      visit.scopes.at(-1) !== owner ||
      !['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(node.type)
    )
      continue;
    if (
      listOf(node, 'params')
        .flatMap((param) => boundNames(param))
        .includes(name) ||
      (node.type === 'FunctionExpression' &&
        nodeHostIdentifier(node['id']) &&
        node['id'].name === name)
    )
      return false;
  }
  return declarations === 1 && (declaration['init'] === null || declaration['init'] === undefined);
}

function assignmentTarget(
  visit: HostVisit,
  visits: readonly HostVisit[],
  parents: ReadonlyMap<Node, HostVisit>,
): { declaration: Node; scope: Scope; left: Node & { readonly name: string } } | undefined {
  const { node, scopes } = visit;
  const left = node['left'];
  const right = node['right'];
  if (
    node.type !== 'AssignmentExpression' ||
    node['operator'] !== '=' ||
    !nodeHostIdentifier(left) ||
    !nodeHostIdentifier(right) ||
    right.name !== 'globalThis' ||
    nodeHostBinding(right.name, scopes) !== undefined ||
    unsupportedAliasScope(node, parents)
  )
    return undefined;
  const target = nodeHostBinding(left.name, scopes);
  const declaration = target?.node;
  const statement = declaration === undefined ? undefined : parents.get(declaration)?.parent;
  if (
    target === undefined ||
    declaration?.type !== 'VariableDeclarator' ||
    !nodeHostIdentifier(declaration['id']) ||
    declaration['id'].name !== left.name ||
    statement?.type !== 'VariableDeclaration' ||
    !['let', 'var'].includes(String(statement['kind'])) ||
    !plainBinding(left.name, target.scope, declaration, visits)
  )
    return undefined;
  return { declaration, scope: target.scope, left };
}

/** Per-parse provenance, never a source rewrite or a grant of a global operation. */
export function analyzeAssignedNodeHosts(
  visits: readonly HostVisit[],
  metadataRoots: ReadonlySet<Node> = NO_METADATA_ROOTS,
): AssignedNodeHostsAnalysis {
  const parents = new Map(visits.map((visit) => [visit.node, visit]));
  const assigned = new Map<Node, 'global'>();
  for (const visit of visits) {
    const target = assignmentTarget(visit, visits, parents);
    if (target === undefined) continue;
    const writes = visits.filter((other) => {
      const value = other.node;
      return (
        nodeHostIdentifier(value) &&
        writeTarget(value, parents) &&
        ((value.name === target.left.name &&
          nodeHostBinding(value.name, other.scopes)?.scope === target.scope) ||
          (value.name === 'globalThis' &&
            nodeHostBinding(value.name, other.scopes) === undefined &&
            !metadataRoots.has(value)))
      );
    });
    if (writes.length !== 1 || writes[0]?.node !== target.left) continue;
    assigned.set(target.declaration, 'global');
    assigned.set(visit.node, 'global');
  }
  for (const visit of visits) {
    const reason = assignedHostRejection(visit, assigned, parents);
    if (reason !== undefined)
      return {
        assigned: NO_ASSIGNED_HOSTS,
        rejection: { visit, reason },
        diagnostic: rejectedHostDiagnostic(visit.node, reason),
      };
  }
  return {
    assigned,
    rejection: undefined,
    diagnostic:
      assigned.size === 0
        ? 'no eligible single globalThis assignment'
        : 'outside accepted globalThis assignment provenance',
  };
}

/** Compatibility API: diagnosis does not change the all-or-nothing provenance map. */
export function assignedNodeHosts(visits: readonly HostVisit[]): AssignedNodeHosts {
  return analyzeAssignedNodeHosts(visits).assigned;
}

function rejectedHostDiagnostic(node: Node, reason: AssignedHostRejectionReason): string {
  const type = ['AssignmentExpression', 'Identifier', 'MemberExpression'].includes(node.type)
    ? node.type
    : 'node';
  const range =
    Number.isSafeInteger(node.start) &&
    node.start >= 0 &&
    Number.isSafeInteger(node.end) &&
    node.end >= node.start
      ? ` at ${node.start}:${node.end}`
      : '';
  return `assigned global ${reason} (${type}${range})`;
}

function permittedAssignedValue(visit: HostVisit, assigned: AssignedNodeHosts): boolean {
  const { node, parent, key } = visit;
  if (parent === undefined) return false;
  if (parent.type === 'AssignmentExpression') return key === 'left' && assigned.has(parent);
  if (parent.type === 'MemberExpression') return key === 'object';
  if (parent.type === 'VariableDeclarator')
    return key === 'init' && !nodeHostIdentifier(parent['id']);
  if (parent.type === 'ExpressionStatement') return node.type === 'AssignmentExpression';
  if (parent.type === 'BinaryExpression')
    return ['!=', '!==', '==', '==='].includes(String(parent['operator']));
  return (
    parent.type === 'UnaryExpression' &&
    ['!', 'typeof', 'void'].includes(String(parent['operator']))
  );
}

function unsafeAssignedMemberReason(
  node: Node,
  scopes: readonly Scope[],
  assigned: AssignedNodeHosts,
  parents: ReadonlyMap<Node, HostVisit>,
): AssignedHostRejectionReason | undefined {
  if (
    node.type !== 'MemberExpression' ||
    hostObjectOf(node['object'], scopes, new Set(), assigned) !== 'global' ||
    hostObjectOf(node['object'], scopes) === 'global'
  )
    return undefined;
  if (node['optional'] === true) return 'optional';
  if (hostPropertyName(node) === undefined) return 'computed';
  if (hostPropertyName(node) === 'require') return 'loader';
  return writeTarget(node, parents) ? 'write' : undefined;
}

/** Assignment-derived hosts may be inspected, but cannot escape or introduce an opaque loader. */
function assignedHostRejection(
  visit: HostVisit,
  assigned: AssignedNodeHosts,
  parents: ReadonlyMap<Node, HostVisit>,
): AssignedHostRejectionReason | undefined {
  const { node, scopes } = visit;
  if (assigned.size === 0) return undefined;
  const member = unsafeAssignedMemberReason(node, scopes, assigned, parents);
  if (member !== undefined) return member;
  if (
    !nodeClosureReference(visit) ||
    !['AssignmentExpression', 'Identifier', 'MemberExpression'].includes(node.type) ||
    hostObjectOf(node, scopes, new Set(), assigned) !== 'global' ||
    hostObjectOf(node, scopes) === 'global'
  )
    return undefined;
  return permittedAssignedValue(visit, assigned) ? undefined : 'global-escape';
}

export function isCommonJsHost(value: unknown, scopes: readonly Scope[]): boolean {
  return hostObjectOf(value, scopes) === COMMON_JS_HOST;
}
