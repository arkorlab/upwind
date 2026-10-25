import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node, type Scope } from './lexical-scope.ts';
import { hostObjectOf } from './node-closure-hosts.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  type Visit,
} from './node-manifest-consumer-ast.ts';

interface PatchFlagInput {
  readonly visits: readonly Visit[];
  readonly parents: ReadonlyMap<Node, Visit>;
}
interface SymbolBinding {
  readonly name: string;
  readonly scope: Scope;
  readonly node: Node;
}
const MAX_SYMBOL_KEY_BYTES = 16_384;

function refuse(): never {
  throw new AuditError('Unproved Next.js patch-fetch boolean flag; refusing native publication');
}

function trueValue(value: unknown): boolean {
  if (!isNode(value)) return false;
  if (value.type === 'Literal') return value['value'] === true;
  const argument = value['argument'];
  return (
    value.type === 'UnaryExpression' &&
    value['operator'] === '!' &&
    isNode(argument) &&
    argument.type === 'Literal' &&
    argument['value'] === 0
  );
}

function actualGlobal(visit: Visit): boolean {
  const owner = visit.node['object'];
  return (
    identifier(owner) &&
    owner.name === 'globalThis' &&
    declaration(owner.name, visit.scopes) === undefined
  );
}

function registrySymbol(value: unknown, scopes: readonly Scope[]): value is Node {
  if (!isNode(value) || value.type !== 'CallExpression' || value['optional'] === true) return false;
  const callee = value['callee'];
  const args = listOf(value, 'arguments');
  const argument = args[0];
  return (
    isNode(callee) &&
    callee.type === 'MemberExpression' &&
    callee['computed'] !== true &&
    callee['optional'] !== true &&
    propertyName(callee) === 'for' &&
    identifier(callee['object']) &&
    callee['object'].name === 'Symbol' &&
    declaration('Symbol', scopes) === undefined &&
    args.length === 1 &&
    isNode(argument) &&
    argument.type === 'Literal' &&
    typeof argument['value'] === 'string' &&
    Buffer.byteLength(argument['value']) <= MAX_SYMBOL_KEY_BYTES
  );
}

function patchSymbol(value: unknown, scopes: readonly Scope[]): value is Node {
  return (
    registrySymbol(value, scopes) &&
    listOf(value, 'arguments').some(
      (argument) => isNode(argument) && argument['value'] === 'next-patch',
    )
  );
}

function scopeOf(name: string, scopes: readonly Scope[]): Scope | undefined {
  return scopes.findLast((scope) => scope.declared.has(name));
}

function directInitializer(binding: SymbolBinding, input: PatchFlagInput): boolean {
  const statement = input.parents.get(binding.node)?.parent;
  const container = statement === undefined ? undefined : input.parents.get(statement)?.parent;
  if (container === undefined || statement?.type !== 'VariableDeclaration') return false;
  const visit = input.parents.get(container);
  if (visit?.scopes.at(-1) === binding.scope) return true;
  const owner = visit?.parent;
  return (
    owner !== undefined &&
    ['ArrowFunctionExpression', 'FunctionDeclaration', 'FunctionExpression'].includes(owner.type) &&
    owner['body'] === container &&
    input.parents.get(owner)?.scopes.at(-1) === binding.scope
  );
}

function symbolIdentity(
  visit: Visit,
  input: PatchFlagInput,
):
  | {
      readonly call: Node;
      readonly binding?: SymbolBinding;
    }
  | undefined {
  const key = visit.node['property'];
  if (patchSymbol(key, visit.scopes)) return { call: key };
  if (!identifier(key)) return undefined;
  const scope = scopeOf(key.name, visit.scopes);
  const node = scope?.bindings.get(key.name);
  if (scope === undefined || node?.type !== 'VariableDeclarator' || !identifier(node['id']))
    return undefined;
  const initializer = node['init'];
  const declared = isNode(initializer) ? input.parents.get(initializer) : undefined;
  if (declared === undefined || !patchSymbol(initializer, declared.scopes)) return undefined;
  const binding = { name: key.name, scope, node };
  if (node.end > key.start || !directInitializer(binding, input)) refuse();
  return { call: initializer, binding };
}

function discarded(value: Node, input: PatchFlagInput): boolean {
  let current = value;
  let parent = input.parents.get(current)?.parent;
  while (parent?.type === 'SequenceExpression' && listOf(parent, 'expressions').includes(current)) {
    if (listOf(parent, 'expressions').at(-1) !== current) return true;
    current = parent;
    parent = input.parents.get(current)?.parent;
  }
  return parent?.type === 'ExpressionStatement' && parent['expression'] === current;
}

function booleanUse(member: Node, input: PatchFlagInput): boolean {
  const parent = input.parents.get(member)?.parent;
  if (parent?.type === 'AssignmentExpression')
    return (
      parent['left'] === member &&
      parent['operator'] === '=' &&
      trueValue(parent['right']) &&
      discarded(parent, input)
    );
  return (
    parent?.type === 'BinaryExpression' &&
    ['!==', '==='].includes(String(parent['operator'])) &&
    trueValue(parent['left'] === member ? parent['right'] : parent['left'])
  );
}

function assertBindingUses(
  binding: SymbolBinding,
  input: PatchFlagInput,
  members: ReadonlySet<Node>,
): void {
  for (const visit of input.visits) {
    const node = visit.node;
    if (
      !identifier(node) ||
      node.name !== binding.name ||
      scopeOf(node.name, visit.scopes) !== binding.scope
    )
      continue;
    if (visit.parent?.type === 'VariableDeclarator' && visit.key === 'id') {
      if (visit.parent !== binding.node) refuse();
      continue;
    }
    if (!reference(visit)) continue;
    if (
      visit.parent === undefined ||
      !members.has(visit.parent) ||
      visit.parent['property'] !== node
    )
      refuse();
  }
}

function writesMember(member: Node, parent: Node | undefined): boolean {
  if (parent === undefined) return false;
  if (
    ['AssignmentExpression', 'AssignmentPattern', 'ForInStatement', 'ForOfStatement'].includes(
      parent.type,
    )
  )
    return parent['left'] === member;
  if (parent.type === 'UpdateExpression') return parent['argument'] === member;
  if (parent.type === 'UnaryExpression')
    return parent['operator'] === 'delete' && parent['argument'] === member;
  return parent.type === 'ArrayPattern' || parent.type === 'RestElement';
}

function destructuredTarget(
  member: Node,
  parent: Node | undefined,
  input: PatchFlagInput,
): boolean {
  return (
    parent?.type === 'Property' &&
    parent['value'] === member &&
    input.parents.get(parent)?.parent?.type === 'ObjectPattern'
  );
}

function readonlyAsyncIterator(member: Node | undefined, input: PatchFlagInput): boolean {
  if (
    member?.type !== 'MemberExpression' ||
    member['computed'] === true ||
    member['optional'] === true ||
    propertyName(member) !== 'asyncIterator'
  )
    return false;
  const parent = input.parents.get(member)?.parent;
  if (writesMember(member, parent)) return false;
  if (parent?.type === 'MemberExpression' && parent['object'] === member) return false;
  if (parent !== undefined && parent['callee'] === member) return false;
  if (parent?.type === 'TaggedTemplateExpression' && parent['tag'] === member) return false;
  return !destructuredTarget(member, parent, input);
}

function assertSymbolUses(input: PatchFlagInput, calls: ReadonlySet<Node>): void {
  for (const visit of input.visits) {
    if (
      visit.node.type === 'MemberExpression' &&
      propertyName(visit.node) === 'Symbol' &&
      hostObjectOf(visit.node['object'], visit.scopes) === 'global'
    )
      refuse();
    if (
      !identifier(visit.node) ||
      visit.node.name !== 'Symbol' ||
      !reference(visit) ||
      declaration('Symbol', visit.scopes) !== undefined
    )
      continue;
    const member = visit.parent;
    const call = member === undefined ? undefined : input.parents.get(member)?.parent;
    if (readonlyAsyncIterator(member, input)) continue;
    if (
      call === undefined ||
      call['callee'] !== member ||
      (!calls.has(call) && !registrySymbol(call, visit.scopes))
    )
      refuse();
  }
}

/** Only the fixed registry symbol used as a write-true or strict boolean flag, never a value. */
export function nodeManifestNextPatchFlags(input: PatchFlagInput): ReadonlySet<Node> {
  const members = new Set<Node>();
  const calls = new Set<Node>();
  const bindings = new Map<Node, SymbolBinding>();
  for (const visit of input.visits) {
    if (
      visit.node.type !== 'MemberExpression' ||
      visit.node['computed'] !== true ||
      !actualGlobal(visit)
    )
      continue;
    const identity = symbolIdentity(visit, input);
    if (identity === undefined) continue;
    if (visit.node['optional'] === true || !booleanUse(visit.node, input)) refuse();
    members.add(visit.node);
    calls.add(identity.call);
    if (identity.binding !== undefined) bindings.set(identity.binding.node, identity.binding);
  }
  if (members.size === 0) return members;
  for (const binding of bindings.values()) assertBindingUses(binding, input, members);
  assertSymbolUses(input, calls);
  return members;
}
