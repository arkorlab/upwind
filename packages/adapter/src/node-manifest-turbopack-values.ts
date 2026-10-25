import { AuditError } from './dependencies.ts';
import { isNode, listOf, type Node } from './lexical-scope.ts';
import { identifier, propertyName } from './node-manifest-consumer-ast.ts';

const EXTERNAL_INTEROP_ARITY = 3;

function refuse(reason: string): never {
  throw new AuditError(
    `Unproved Next.js Turbopack manifest ${reason}; refusing native publication`,
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

export function getterOf(value: unknown): Node {
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
