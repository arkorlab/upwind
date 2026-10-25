import { AuditError } from './dependencies.ts';
import { isNode, type Node, type Scope } from './lexical-scope.ts';
import { hostObjectOf } from './node-closure-hosts.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  type Visit,
} from './node-manifest-consumer-ast.ts';

const CLEAR_SLOT = '__next__clear_chunk_cache__';
const METADATA_OPERATORS: ReadonlySet<string> = new Set(['!', 'typeof', 'void']);
const IMPLICIT_RECEIVERS: ReadonlySet<string> = new Set([
  'MetaProperty',
  'Super',
  'ThisExpression',
]);

interface ContextBinding {
  readonly name: string;
  readonly scope: Scope;
}
interface ClearProjectionInput {
  readonly body: Node;
  readonly visits: readonly Visit[];
  readonly parents: ReadonlyMap<Node, Visit>;
  readonly context: ContextBinding;
}
export interface NodeManifestClearProjection {
  readonly assignment: Node;
  readonly members: readonly Node[];
  readonly references: readonly Node[];
}

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack chunk-cache hook ${reason}; refusing native publication`,
  );
}

function ownContext(value: unknown, visit: Visit, context: ContextBinding): value is Node {
  if (!identifier(value) || value.name !== context.name) return false;
  const scope = visit.scopes.findLast((candidate) => candidate.declared.has(context.name));
  return scope === context.scope && !scope.bindings.has(context.name);
}

function contextMember(node: Node, visit: Visit, context: ContextBinding, name: string): boolean {
  return (
    node.type === 'MemberExpression' &&
    node['optional'] !== true &&
    node['computed'] !== true &&
    propertyName(node) === name &&
    ownContext(node['object'], visit, context)
  );
}

function globalReceiver(node: unknown, visit: Visit, context: ContextBinding): node is Node {
  return (
    isNode(node) &&
    ((identifier(node) &&
      node.name === 'globalThis' &&
      declaration('globalThis', visit.scopes) === undefined) ||
      contextMember(node, visit, context, 'g'))
  );
}

function clearAssignment(visit: Visit, input: ClearProjectionInput): Node {
  const assignment = visit.parent;
  const target = assignment?.['left'];
  const statement = assignment === undefined ? undefined : input.parents.get(assignment)?.parent;
  if (
    assignment?.type !== 'AssignmentExpression' ||
    assignment['operator'] !== '=' ||
    assignment['right'] !== visit.node ||
    !isNode(target) ||
    target.type !== 'MemberExpression' ||
    target['optional'] === true ||
    target['computed'] === true ||
    propertyName(target) !== CLEAR_SLOT ||
    !globalReceiver(target['object'], visit, input.context) ||
    declaration('globalThis', visit.scopes) !== undefined ||
    statement?.type !== 'ExpressionStatement' ||
    input.parents.get(statement)?.parent !== input.body
  )
    refuse('is not the standalone fixed global assignment');
  return assignment;
}

function globalNamespace(visit: Visit, context: ContextBinding): boolean {
  return (
    hostObjectOf(visit.node, visit.scopes) === 'global' ||
    contextMember(visit.node, visit, context, 'g')
  );
}

function assertNamespaceUse(visit: Visit, assignment: Node): void {
  const parent = visit.parent;
  if (parent?.type === 'UnaryExpression' && METADATA_OPERATORS.has(String(parent['operator'])))
    return;
  if (
    parent?.type !== 'MemberExpression' ||
    parent['object'] !== visit.node ||
    parent['computed'] === true ||
    parent['optional'] === true ||
    propertyName(parent) === undefined
  )
    refuse('global namespace alias, reflection or dynamic access');
  if (propertyName(parent) === CLEAR_SLOT && parent !== assignment['left'])
    refuse('global slot read or mutation');
}

function assertSlotUses(input: ClearProjectionInput, assignment: Node): void {
  for (const visit of input.visits) {
    const node = visit.node;
    if (!reference(visit)) continue;
    if (
      IMPLICIT_RECEIVERS.has(node.type) ||
      (identifier(node) &&
        node.name === 'arguments' &&
        declaration('arguments', visit.scopes) === undefined)
    )
      refuse('implicit receiver or metadata escape');
    if (
      identifier(node) &&
      node.name === CLEAR_SLOT &&
      declaration(CLEAR_SLOT, visit.scopes) === undefined
    )
      refuse('implicit global slot read');
    if (globalNamespace(visit, input.context)) assertNamespaceUse(visit, assignment);
  }
}

/** The pinned entry-base producer only publishes a cache-clearing hook, never a module loader. */
export function nodeManifestClearProjection(
  input: ClearProjectionInput,
): NodeManifestClearProjection | undefined {
  const members = input.visits.filter((visit) =>
    contextMember(visit.node, visit, input.context, 'C'),
  );
  if (members.length === 0) return undefined;
  if (members.length !== 1) refuse('multiple context hook uses');
  const visit = members[0];
  if (visit === undefined) return refuse('missing context hook');
  const assignment = clearAssignment(visit, input);
  assertSlotUses(input, assignment);
  const target = assignment['left'];
  const receiver = isNode(target) ? target['object'] : undefined;
  const handled = [visit.node];
  const references = [visit.node['object']];
  if (isNode(receiver) && contextMember(receiver, visit, input.context, 'g')) {
    handled.push(receiver);
    references.push(receiver['object']);
  }
  if (references.some((node) => !isNode(node))) refuse('missing context reference');
  return Object.freeze({
    assignment,
    members: Object.freeze(handled),
    references: Object.freeze(references.filter((node) => isNode(node))),
  });
}
