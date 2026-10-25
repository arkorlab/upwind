import { isNode, listOf, type Node } from './lexical-scope.ts';
import {
  declaration,
  identifier,
  propertyName,
  reference,
  refuse,
  type Visit,
} from './node-manifest-consumer-ast.ts';

interface Input {
  readonly call: Node;
  readonly expected: { readonly require: string; readonly loadChunk: string };
  readonly visits: readonly Visit[];
  readonly parents: ReadonlyMap<Node, Visit>;
}
interface Callback {
  readonly root: Node;
  readonly value: Node & { readonly name: string };
  readonly alias?: Node | undefined;
  readonly expected: string;
}
function callbackValue(
  input: Input,
  kind: 'require' | 'loadChunk',
): Node & { readonly name: string } {
  const argument = listOf(input.call, 'arguments')[0];
  if (!isNode(argument)) refuse('runtime callback argument');
  const property = listOf(argument, 'properties').find(
    (value) => isNode(value) && propertyName(value) === kind,
  );
  const value = isNode(property) ? property['value'] : undefined;
  if (!identifier(value)) refuse('runtime callback binding');
  return value;
}
function aliasRoot(alias: Node | undefined, expected: string, input: Input): Node {
  const statement = alias === undefined ? undefined : input.parents.get(alias)?.parent;
  const init = alias?.['init'];
  if (
    alias?.type !== 'VariableDeclarator' ||
    !identifier(alias['id']) ||
    statement?.type !== 'VariableDeclaration' ||
    input.parents.get(statement)?.parent?.type !== 'Program' ||
    !identifier(init) ||
    init.name !== expected ||
    init.end >= input.call.start
  )
    refuse('runtime callback binding (alias)');
  return init;
}
function callback(input: Input, kind: 'require' | 'loadChunk'): Callback {
  const value = callbackValue(input, kind);
  const location = input.parents.get(value);
  if (location === undefined) refuse('runtime callback location');
  const expected = input.expected[kind];
  const alias =
    value.name === expected ? undefined : declaration(value.name, location.scopes)?.node;
  const root = value.name === expected ? value : aliasRoot(alias, expected, input);
  const rootLocation = input.parents.get(root);
  if (rootLocation === undefined || declaration(expected, rootLocation.scopes) !== undefined)
    refuse('shadowed runtime callback binding');
  return { root, value, alias, expected };
}
function assertUses(input: Input, checked: Callback): void {
  for (const visit of input.visits) {
    if (!identifier(visit.node)) continue;
    if (
      reference(visit) &&
      visit.node.name === checked.expected &&
      declaration(checked.expected, visit.scopes) === undefined &&
      visit.node !== checked.root
    )
      refuse('runtime callback escape');
    if (
      checked.alias !== undefined &&
      visit.node.name === checked.value.name &&
      declaration(checked.value.name, visit.scopes)?.node === checked.alias &&
      visit.node !== checked.value &&
      (reference(visit) || (visit.key === 'id' && visit.node !== checked.alias['id']))
    )
      refuse('runtime callback alias escape');
  }
}
/** One direct compiler callback, or its sole top-level alias, used by the actual producer call. */
export function assertNodeManifestRuntimeInputs(input: Input): void {
  for (const kind of ['require', 'loadChunk'] as const) assertUses(input, callback(input, kind));
}
