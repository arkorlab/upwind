import { isNode, listOf, type Node } from './lexical-scope.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  visitTree,
  type Visit,
} from './node-manifest-consumer-ast.ts';

const MAX_NODES = 100_000;
const LOADERS = new Set(['_linkedBinding', 'binding', 'dlopen', 'getBuiltinModule', 'mainModule']);
type Parents = ReadonlyMap<Node, Node | undefined>;

function literal(value: unknown, expected: string): boolean {
  return isNode(value) && value.type === 'Literal' && value['value'] === expected;
}
function member(value: unknown, name: string): value is Node {
  return (
    isNode(value) &&
    value.type === 'MemberExpression' &&
    value['computed'] !== true &&
    value['optional'] !== true &&
    propertyName(value) === name
  );
}
/** `<local>.kStringMaxLength`, of `local` where it is given. */
function maxLengthOf(value: unknown, local?: string): string | undefined {
  if (!member(value, 'kStringMaxLength')) return undefined;
  const object = value['object'];
  if (!identifier(object) || (local !== undefined && object.name !== local)) return undefined;
  return object.name;
}
/** A reference to one of the global `names`, which no local declares. */
function globalReference(visit: Visit, names: readonly string[]): boolean {
  const { node, scopes } = visit;
  return (
    identifier(node) &&
    names.includes(node.name) &&
    reference(visit) &&
    declaration(node.name, scopes) === undefined
  );
}
/** Every read of a loader member of the global `process`, computed reads included. */
function loaderReads(visits: readonly Visit[]): readonly Visit[] {
  return visits.filter((visit) => {
    const parent = visit.parent;
    return (
      globalReference(visit, ['process']) &&
      parent?.type === 'MemberExpression' &&
      parent['object'] === visit.node &&
      (parent['computed'] === true || LOADERS.has(propertyName(parent) ?? ''))
    );
  });
}
/** `process.binding("buffer")`, called once with that literal alone. */
function bufferBinding(binding: Node, parents: Parents): Node | undefined {
  const call = parents.get(binding);
  if (call?.type !== 'CallExpression' || call['callee'] !== binding || call['optional'] === true)
    return undefined;
  const args = listOf(call, 'arguments');
  return args.length === 1 && literal(args[0], 'buffer') ? call : undefined;
}
/** `<local>.kStringMaxLength = <call>.kStringMaxLength`, and the local it assigns. */
function maxLengthAssignment(
  call: Node,
  parents: Parents,
): { readonly assignment: Node; readonly local: string } | undefined {
  const read = parents.get(call);
  if (read?.['object'] !== call || !member(read, 'kStringMaxLength')) return undefined;
  const assignment = parents.get(read);
  if (
    assignment?.type !== 'AssignmentExpression' ||
    assignment['operator'] !== '=' ||
    assignment['right'] !== read
  )
    return undefined;
  const local = maxLengthOf(assignment['left']);
  return local === undefined ? undefined : { assignment, local };
}
/** The assignment alone in a `try` block, with an empty `catch` and no `finally`. */
function attemptOf(assignment: Node, parents: Parents): Node | undefined {
  const statement = parents.get(assignment);
  const block = statement === undefined ? undefined : parents.get(statement);
  const attempt = block === undefined ? undefined : parents.get(block);
  if (
    statement?.type !== 'ExpressionStatement' ||
    block?.type !== 'BlockStatement' ||
    listOf(block, 'body').length !== 1 ||
    attempt?.type !== 'TryStatement' ||
    attempt['block'] !== block ||
    attempt['finalizer'] !== null
  )
    return undefined;
  const handler = attempt['handler'];
  const body = isNode(handler) ? handler['body'] : undefined;
  return isNode(body) && listOf(body, 'body').length === 0 ? attempt : undefined;
}
/** That `try` alone under `if (!<local>.kStringMaxLength)`, with no `else`. */
function guarded(attempt: Node, local: string, parents: Parents): boolean {
  let condition = parents.get(attempt);
  if (condition?.type === 'BlockStatement' && listOf(condition, 'body').length === 1)
    condition = parents.get(condition);
  if (condition?.type !== 'IfStatement' || condition['alternate'] !== null) return false;
  const test = condition['test'];
  return (
    isNode(test) &&
    test.type === 'UnaryExpression' &&
    test['operator'] === '!' &&
    maxLengthOf(test['argument'], local) === local
  );
}

/**
 * The one Node loader read in Next.js 16.4.4's fast-jwt bundle, from the copy of safer-buffer it
 * compiles in: `if (!o.kStringMaxLength) { try { o.kStringMaxLength =
 * process.binding("buffer").kStringMaxLength } catch (e) {} }`, where `o` copies the fields of
 * `buffer`. Node.js 24 and 26 export `kStringMaxLength` from `buffer`, so the read never runs.
 *
 * Shape DATA only: the `process.binding` member, where it is the bundle's only loader read and no
 * code compiler is named at all. It grants nothing without the private whole-source proof.
 */
export function nodeFastJwtBindingSite(program: unknown): Node | undefined {
  if (!isNode(program)) return undefined;
  const visits = visitTree(program);
  if (visits.length > MAX_NODES) return undefined;
  if (visits.some((visit) => globalReference(visit, ['eval', 'Function']))) return undefined;
  const parents: Parents = new Map(visits.map((visit) => [visit.node, visit.parent]));
  const reads = loaderReads(visits);
  const process = reads[0]?.node;
  const binding = process === undefined ? undefined : parents.get(process);
  if (reads.length !== 1 || !member(binding, 'binding')) return undefined;
  const call = bufferBinding(binding, parents);
  const write = call === undefined ? undefined : maxLengthAssignment(call, parents);
  const attempt = write === undefined ? undefined : attemptOf(write.assignment, parents);
  return attempt !== undefined && write !== undefined && guarded(attempt, write.local, parents)
    ? binding
    : undefined;
}
