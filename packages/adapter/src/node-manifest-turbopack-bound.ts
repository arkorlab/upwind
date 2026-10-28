import { AuditError } from './dependencies.ts';
import { listOf, type Node, type Scope } from './lexical-scope.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  type Visit,
} from './node-manifest-consumer-ast.ts';

// next@16.4.3 app_page_entry.rs injects the bound require/load callbacks into app-page.
// Fixed source: 29bbeab09981148ade186e8599ecdede15abc281, blob 50301447550e0e6d77d571ec0e80ed5721c3582f.
export const TURBOPACK_BOUND_PREFIX = '__upwind_turbopack_bound_';
const KINDS = { r: 'require', l: 'loadChunk' } as const;
interface BoundInput {
  readonly call: Node;
  readonly receiver: Node;
  readonly kind: 'require' | 'loadChunk';
  readonly identifier: string;
}
interface Input {
  readonly member: Node;
  readonly name: 'r' | 'l';
  readonly visit: Visit;
  readonly visits: readonly Visit[];
  readonly parents: ReadonlyMap<Node, Visit>;
  readonly body: Node;
  readonly context: { readonly name: string; readonly scope: Scope };
}
function refuse(): never {
  throw new AuditError(
    'Unproved Next.js Turbopack manifest bound context identity; refusing native publication',
  );
}
function boundCall(input: Input): Node | undefined {
  const bind = input.parents.get(input.member)?.parent;
  const call = bind === undefined ? undefined : input.parents.get(bind)?.parent;
  return bind?.type === 'MemberExpression' &&
    bind['object'] === input.member &&
    bind['optional'] !== true &&
    propertyName(bind) === 'bind' &&
    call?.type === 'CallExpression' &&
    call['optional'] !== true &&
    call['callee'] === bind
    ? call
    : undefined;
}
function propertyInput(property: Node | undefined, value: Node, input: Input): boolean {
  return (
    property?.type === 'Property' &&
    property['value'] === value &&
    property['computed'] !== true &&
    property['method'] !== true &&
    propertyName(property) === KINDS[input.name]
  );
}
function soleAliasUse(owner: Node, call: Node, input: Input): boolean {
  const id = owner['id'];
  if (!identifier(id) || ['exports', 'module', 'require'].includes(id.name)) return false;
  const uses = input.visits.filter((visit) => {
    return (
      identifier(visit.node) &&
      visit.node.name === id.name &&
      (reference(visit) || (visit.key === 'id' && visit.node !== id)) &&
      declaration(id.name, visit.scopes)?.node === owner
    );
  });
  const use = uses[0];
  if (
    use === undefined ||
    uses.length !== 1 ||
    use.node.start <= call.end ||
    !propertyInput(use.parent, use.node, input)
  )
    return false;
  const object = use.parent === undefined ? undefined : input.parents.get(use.parent)?.parent;
  const consumer = object === undefined ? undefined : input.parents.get(object)?.parent;
  if (
    object?.type !== 'ObjectExpression' ||
    consumer?.type !== 'CallExpression' ||
    consumer['optional'] === true
  )
    return false;
  const args = listOf(consumer, 'arguments');
  return args.length === 1 && args[0] === object;
}
function aliasInput(owner: Node | undefined, call: Node, input: Input): boolean {
  const statement = owner === undefined ? undefined : input.parents.get(owner)?.parent;
  return (
    owner?.type === 'VariableDeclarator' &&
    owner['init'] === call &&
    statement?.type === 'VariableDeclaration' &&
    input.parents.get(statement)?.parent === input.body &&
    soleAliasUse(owner, call, input)
  );
}
function receiverOf(call: Node, input: Input): Node {
  const args = listOf(call, 'arguments');
  const receiver = args[0];
  if (!identifier(receiver) || receiver.name !== input.context.name || args.length !== 1)
    return refuse();
  const scope = input.visit.scopes.findLast((candidate) => candidate.declared.has(receiver.name));
  if (
    scope !== input.context.scope ||
    declaration(receiver.name, input.visit.scopes)?.node !== undefined
  )
    return refuse();
  return receiver;
}
/** Aliases carry an obligation: only a fresh, strict AppPage consumer can discharge it. */
export function turbopackBoundRuntimeInput(input: Input): BoundInput | undefined {
  const call = boundCall(input);
  if (call === undefined) return undefined;
  const owner = input.parents.get(call)?.parent;
  if (!propertyInput(owner, call, input) && !aliasInput(owner, call, input)) return undefined;
  return Object.freeze({
    call,
    receiver: receiverOf(call, input),
    kind: KINDS[input.name],
    identifier: `${TURBOPACK_BOUND_PREFIX}${input.name}`,
  });
}
