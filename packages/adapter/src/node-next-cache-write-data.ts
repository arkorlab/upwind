import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { identifier, visitTree, type Visit } from './node-manifest-consumer-ast.ts';

const SLOT = '__incrementalCache';
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression']);

interface Binding {
  readonly scope: Scope;
  readonly node: Node | undefined;
}
interface LocalDeclaration {
  readonly name: string;
  readonly scope: Scope;
  readonly node: Node;
}

function binding(name: string, scopes: readonly Scope[]): Binding | undefined {
  for (const scope of scopes.toReversed()) {
    if (scope.declared.has(name)) return { scope, node: scope.bindings.get(name) };
  }
  return undefined;
}

function binds(pattern: unknown, name: string): boolean {
  const pending = [pattern];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!isNode(node)) continue;
    if (identifier(node) && node.name === name) return true;
    switch (node.type) {
      case 'ArrayPattern': {
        pending.push(...listOf(node, 'elements'));
        break;
      }
      case 'ObjectPattern': {
        pending.push(...listOf(node, 'properties'));
        break;
      }
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
      default:
    }
  }
  return false;
}

function directWrite(parent: Node, child: Node): boolean | undefined {
  if (parent.type === 'AssignmentExpression') return parent['left'] === child;
  if (parent.type === 'UpdateExpression') return parent['argument'] === child;
  if (parent.type === 'UnaryExpression') return parent['operator'] === 'delete';
  if (parent.type === 'ForInStatement' || parent.type === 'ForOfStatement')
    return parent['left'] === child;
  return undefined;
}

function written(node: Node, parents: ReadonlyMap<Node, Visit>): boolean {
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
    if (parent.type === 'Property' && parent['value'] !== current) return false;
    if (parent.type === 'AssignmentPattern' && parent['left'] !== current) return false;
    if (
      !['ArrayPattern', 'AssignmentPattern', 'ObjectPattern', 'Property', 'RestElement'].includes(
        parent.type,
      )
    )
      return false;
    current = parent;
  }
  return false;
}

function cacheRoot(visit: Visit): Node | undefined {
  const { node, scopes } = visit;
  const left = node['left'];
  if (node.type !== 'AssignmentExpression' || node['operator'] !== '=' || !isNode(left))
    return undefined;
  const root = left['object'];
  const property = left['property'];
  return left.type === 'MemberExpression' &&
    left['optional'] !== true &&
    left['computed'] !== true &&
    identifier(root) &&
    root.name === 'globalThis' &&
    binding(root.name, scopes) === undefined &&
    identifier(property) &&
    property.name === SLOT
    ? root
    : undefined;
}

function parameterBinding(visit: Visit, name: string, owner: Scope): boolean {
  const node = visit.node;
  return (
    FUNCTIONS.has(node.type) &&
    visit.scopes.at(-1) === owner &&
    (listOf(node, 'params').some((param) => binds(param, name)) ||
      (node.type === 'FunctionExpression' && binds(node['id'], name)))
  );
}

function declaresHere(visit: Visit, name: string, owner: Scope): boolean {
  const node = visit.node;
  if (node.type === 'VariableDeclarator')
    return binds(node['id'], name) && binding(name, visit.scopes)?.scope === owner;
  if (!['ClassDeclaration', 'FunctionDeclaration'].includes(node.type) || !binds(node['id'], name))
    return false;
  const scopes = node.type === 'FunctionDeclaration' ? visit.scopes.slice(0, -1) : visit.scopes;
  return binding(name, scopes)?.scope === owner;
}

function declarations(name: string, owner: Scope, visits: readonly Visit[]): number | undefined {
  let count = 0;
  for (const visit of visits) {
    if (parameterBinding(visit, name, owner)) return undefined;
    if (declaresHere(visit, name, owner)) count += 1;
  }
  return count;
}

function sameScopes(left: readonly Scope[], right: readonly Scope[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function localDeclaration(
  assignment: Visit,
  parents: ReadonlyMap<Node, Visit>,
): LocalDeclaration | undefined {
  const right = assignment.node['right'];
  if (!identifier(right)) return undefined;
  const found = binding(right.name, assignment.scopes);
  const node = found?.node;
  if (
    node?.type !== 'VariableDeclarator' ||
    !identifier(node['id']) ||
    node['id'].name !== right.name
  )
    return undefined;
  const own = parents.get(node);
  if (own?.parent?.type !== 'VariableDeclaration' || !sameScopes(own.scopes, assignment.scopes))
    return undefined;
  return found === undefined ? undefined : { name: right.name, scope: found.scope, node };
}

function constructedInitializer(node: Node): boolean {
  const init = node['init'];
  return (
    isNode(init) &&
    init.type === 'NewExpression' &&
    init['optional'] !== true &&
    isNode(init['callee']) &&
    Array.isArray(init['arguments'])
  );
}

function localInstance(
  assignment: Visit,
  visits: readonly Visit[],
  parents: ReadonlyMap<Node, Visit>,
): boolean {
  const local = localDeclaration(assignment, parents);
  if (local === undefined) return false;
  if (
    !constructedInitializer(local.node) ||
    !Number.isSafeInteger(local.node.end) ||
    !Number.isSafeInteger(assignment.node.start) ||
    local.node.end > assignment.node.start ||
    declarations(local.name, local.scope, visits) !== 1
  )
    return false;
  return visits.every((visit) => {
    if (!identifier(visit.node) || visit.node.name !== local.name) return true;
    return (
      binding(local.name, visit.scopes)?.scope !== local.scope || !written(visit.node, parents)
    );
  });
}

/** Original AST facts only. These nodes confer no source, graph or execution authority. */
export function nodeNextCacheWriteData(
  program: unknown,
): { readonly qualification: 'UNQUALIFIED DATA'; readonly roots: ReadonlySet<Node> } | undefined {
  if (!isNode(program) || program.type !== 'Program') return undefined;
  const visits = visitTree(program);
  if (visits.some((visit) => visit.node.type === 'WithStatement')) return undefined;
  const parents = new Map(visits.map((visit) => [visit.node, visit]));
  const candidates = visits.filter((visit) => cacheRoot(visit) !== undefined);
  if (candidates.length !== 1) return undefined;
  const candidate = candidates[0];
  if (candidate === undefined) return undefined;
  const root = cacheRoot(candidate);
  const writes = visits.filter((visit) => {
    return (
      identifier(visit.node) &&
      visit.node.name === 'globalThis' &&
      binding(visit.node.name, visit.scopes) === undefined &&
      written(visit.node, parents)
    );
  });
  if (
    root === undefined ||
    writes.length !== 1 ||
    writes[0]?.node !== root ||
    !localInstance(candidate, visits, parents)
  )
    return undefined;
  return Object.freeze({ qualification: 'UNQUALIFIED DATA', roots: new Set([root]) });
}
