import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { identifier, propertyName, type Visit } from './node-manifest-consumer-ast.ts';
import { turbopackModuleId, turbopackModuleSpecifier } from './node-manifest-turbopack-values.ts';
import type { NodeManifestTurbopackImport } from './node-manifest-turbopack.ts';

interface UnboundRequireInput {
  readonly mode: 'strict' | 'dependencies';
  readonly parents: ReadonlyMap<Node, Visit>;
  readonly context: { readonly name: string; readonly scope: Scope };
}
const PATTERNS: ReadonlySet<string> = new Set([
  'ArrayPattern',
  'AssignmentPattern',
  'ObjectPattern',
  'Property',
  'RestElement',
]);

export function escapeContext(name: string | undefined, parent: Node | undefined): never {
  const label = name !== undefined && /^[a-zA-Z]$/u.test(name) ? name : 'other';
  throw new AuditError(
    `Unproved Next.js Turbopack manifest context method escape (${label}; ${parent?.type ?? 'missing'}); refusing native publication`,
  );
}

function ownsContext(value: unknown, visit: Visit, input: UnboundRequireInput): boolean {
  if (!identifier(value) || value.name !== input.context.name) return false;
  const scope = visit.scopes.findLast((candidate) => candidate.declared.has(value.name));
  return scope === input.context.scope && !scope.bindings.has(value.name);
}

function literalZero(node: unknown): boolean {
  return (
    isNode(node) &&
    node.type === 'Literal' &&
    typeof node['value'] === 'number' &&
    node['value'] === 0
  );
}

function isWritten(node: Node, input: UnboundRequireInput): boolean {
  let current = node;
  for (
    let parent = input.parents.get(current)?.parent;
    parent !== undefined;
    parent = input.parents.get(current)?.parent
  ) {
    if (parent.type === 'AssignmentExpression') return parent['left'] === current;
    if (parent.type === 'UpdateExpression') return parent['argument'] === current;
    if (parent.type === 'ForOfStatement' || parent.type === 'ForInStatement')
      return parent['left'] === current;
    if (!PATTERNS.has(parent.type) || (parent.type === 'Property' && parent['value'] !== current))
      return false;
    current = parent;
  }
  return false;
}

function contextWasWritten(input: UnboundRequireInput): boolean {
  for (const visit of input.parents.values()) {
    if (ownsContext(visit.node, visit, input) && isWritten(visit.node, input)) return true;
  }
  return false;
}

function ownRequireMember(visit: Visit, input: UnboundRequireInput): boolean {
  const member = visit.node;
  return (
    member.type === 'MemberExpression' &&
    member['optional'] !== true &&
    member['computed'] !== true &&
    propertyName(member) === 'r' &&
    ownsContext(member['object'], visit, input)
  );
}

/** A conservative dependency only: losing the runtime receiver is never a claimed execution fix. */
export function unboundTurbopackRequire(
  visit: Visit,
  input: UnboundRequireInput,
):
  | {
      readonly call: Node;
      readonly dependency: NodeManifestTurbopackImport;
    }
  | undefined {
  const member = visit.node;
  if (input.mode !== 'dependencies' || !ownRequireMember(visit, input)) return undefined;
  const sequence = visit.parent;
  const expressions =
    sequence?.type === 'SequenceExpression' ? listOf(sequence, 'expressions') : [];
  if (
    sequence === undefined ||
    expressions.length !== 2 ||
    !literalZero(expressions[0]) ||
    expressions[1] !== member
  )
    return undefined;
  const call = input.parents.get(sequence)?.parent;
  if (
    call?.type !== 'CallExpression' ||
    call['callee'] !== sequence ||
    call['optional'] === true ||
    listOf(call, 'arguments').length !== 1
  )
    return undefined;
  const id = turbopackModuleId(listOf(call, 'arguments')[0]);
  return id === undefined || contextWasWritten(input)
    ? undefined
    : Object.freeze({
        call,
        dependency: Object.freeze({
          kind: 'require',
          specifier: turbopackModuleSpecifier(id),
          targetId: id,
        }),
      });
}
