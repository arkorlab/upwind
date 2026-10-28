import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import {
  declaration,
  identifier,
  propertyName,
  stringOf,
  type Visit,
} from './node-manifest-consumer-ast.ts';
import type { NodeManifestTurbopackModuleId } from './node-manifest-turbopack.ts';

const EXTERNAL_INTEROP_ARITY = 3;
const MAX_MODULE_ID_BYTES = 16_384;
const GETTER_BINDING_WIDTH = 2;
const VALUE_BINDING_WIDTH = 3;

interface ExportBinding {
  readonly name: string;
  readonly value: Node;
  readonly kind: 'getter' | 'value';
}

/** Fixed Next ModuleId is an untagged number/string; the runtime stores exact keys in a Map. */
// eslint-disable-next-line sonarjs/function-return-type -- Next.js ModuleId preserves runtime-distinct number and string Map keys.
export function turbopackModuleId(node: unknown): NodeManifestTurbopackModuleId | undefined {
  if (!isNode(node) || node.type !== 'Literal') return undefined;
  const value = node['value'];
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\0') &&
    Buffer.byteLength(value) <= MAX_MODULE_ID_BYTES
    ? value
    : undefined;
}

/** Keep runtime-distinct numeric/string keys distinct in the inspection-only module namespace. */
export function turbopackModuleSpecifier(id: NodeManifestTurbopackModuleId): string {
  return typeof id === 'number' ? `turbopack:${id}` : `turbopack:string:${JSON.stringify(id)}`;
}

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest ${reason}; refusing native publication`,
  );
}

export function defaultExportTarget(value: unknown, visit: Visit): boolean {
  if (value === undefined) return true;
  if (!isNode(value)) return false;
  if (
    value.type === 'Literal' &&
    value['value'] === null &&
    !('regex' in value) &&
    !('bigint' in value)
  )
    return true;
  if (identifier(value) && value.name === 'undefined')
    return declaration('undefined', visit.scopes) === undefined;
  const argument = value['argument'];
  return (
    value.type === 'UnaryExpression' &&
    value['operator'] === 'void' &&
    isNode(argument) &&
    argument.type === 'Literal' &&
    argument['value'] === 0
  );
}

function staticSelector(node: unknown): node is Node {
  if (identifier(node)) return node.name !== 'arguments';
  return (
    isNode(node) &&
    node.type === 'MemberExpression' &&
    identifier(node['object']) &&
    node['object'].name !== 'arguments' &&
    propertyName(node) !== undefined
  );
}

function getterOf(value: unknown): Node {
  if (
    !isNode(value) ||
    value.type !== 'ArrowFunctionExpression' ||
    value['async'] === true ||
    value['generator'] === true ||
    listOf(value, 'params').length > 0
  )
    return refuse('export getter');
  let result = value['body'];
  if (isNode(result) && result.type === 'BlockStatement') {
    const statements = listOf(result, 'body');
    const only = statements[0];
    if (statements.length !== 1 || !isNode(only) || only.type !== 'ReturnStatement')
      return refuse('export getter body');
    result = only['argument'];
  }
  return staticSelector(result) ? result : refuse('export getter expression');
}

/** Inspection only; callers must independently prove the selected value's complete semantics. */
export function singleDirectExportValue(table: unknown, exportName: string): Node | undefined {
  if (!isNode(table) || table.type !== 'ArrayExpression') return undefined;
  const entries = listOf(table, 'elements');
  const tag = entries[1];
  const value = entries[GETTER_BINDING_WIDTH];
  return entries.length === VALUE_BINDING_WIDTH &&
    stringOf(entries[0]) === exportName &&
    isNode(tag) &&
    tag.type === 'Literal' &&
    tag['value'] === 0 &&
    isNode(value)
    ? value
    : undefined;
}

/** Fixed EsmBindings use name/getter pairs or name/0/value triples, with no setters here. */
export function exportBindings(table: unknown): readonly ExportBinding[] {
  if (!isNode(table) || table.type !== 'ArrayExpression') refuse('export registration arguments');
  const entries = listOf(table, 'elements');
  const names = new Set<string>();
  const bindings: ExportBinding[] = [];
  for (let index = 0; index < entries.length;) {
    const name = stringOf(entries[index]);
    if (name === undefined || names.has(name)) refuse('export name');
    names.add(name);
    const tag = entries[index + 1];
    const direct = isNode(tag) && tag.type === 'Literal' && tag['value'] === 0;
    const value = direct ? entries[index + GETTER_BINDING_WIDTH] : getterOf(tag);
    if (!staticSelector(value)) refuse('export value expression');
    bindings.push({ name, value, kind: direct ? 'value' : 'getter' });
    index += direct ? VALUE_BINDING_WIDTH : GETTER_BINDING_WIDTH;
  }
  return bindings.length === 0 ? refuse('empty export registration') : bindings;
}

export function externalThunk(args: readonly unknown[]): Node {
  const thunk = args[1];
  if (
    (args.length !== 2 && args.length !== EXTERNAL_INTEROP_ARITY) ||
    !isNode(thunk) ||
    !['ArrowFunctionExpression', 'FunctionExpression'].includes(thunk.type) ||
    thunk['async'] === true ||
    thunk['generator'] === true ||
    listOf(thunk, 'params').length > 0 ||
    (thunk['id'] !== null && thunk['id'] !== undefined)
  )
    refuse('external require thunk');
  const flag = args[2];
  if (
    args.length === EXTERNAL_INTEROP_ARITY &&
    (!isNode(flag) || flag.type !== 'Literal' || typeof flag['value'] !== 'boolean')
  )
    refuse('external interop flag');
  const body = thunk['body'];
  if (!isNode(body)) return refuse('external thunk body');
  if (body.type !== 'BlockStatement') return body;
  const statements = listOf(body, 'body');
  const only = statements[0];
  if (
    statements.length !== 1 ||
    !isNode(only) ||
    only.type !== 'ReturnStatement' ||
    !isNode(only['argument'])
  )
    return refuse('external thunk body');
  return only['argument'];
}
