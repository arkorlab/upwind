import type { Node } from '@oxc-project/types';

import type { NativeBindings } from './native-ast.ts';

interface ScalarArrayContext {
  readonly tree: readonly Node[];
  readonly bindings: NativeBindings;
  readonly namespace: (node: Node) => boolean;
}

function scalarKey(node: Extract<Node, { type: 'MemberExpression' }>): boolean {
  if (node.optional) return false;
  const key = node.property;
  let value: string | undefined;
  if (node.computed) {
    if (key.type === 'Literal' && typeof key.value === 'string') value = key.value;
  } else if (key.type === 'Identifier') value = key.name;
  return value === 'isMainThread' || value === 'threadId';
}

function scalarCallback(node: Node, context: ScalarArrayContext): boolean {
  if (
    node.type !== 'ArrowFunctionExpression' ||
    node.async ||
    !node.expression ||
    node.params.length !== 1
  )
    return false;
  const parameter = node.params[0];
  const body = node.body;
  return (
    parameter?.type === 'Identifier' &&
    body.type === 'MemberExpression' &&
    body.object.type === 'Identifier' &&
    body.object.name === parameter.name &&
    context.bindings.lookup(body.object, parameter.name) === null &&
    context.bindings.unmodified(body.object, parameter.name, true) &&
    scalarKey(body)
  );
}

/** Worker stub namespaces already support scalar reads and direct namespace returns. */
export function workerScalarNamespaceArray(node: Node, context: ScalarArrayContext): boolean {
  if (
    node.type !== 'ArrayExpression' ||
    node.elements.length === 0 ||
    node.elements.some(
      (element) =>
        element === null || element.type === 'SpreadElement' || !context.namespace(element),
    )
  )
    return false;
  const member = context.tree.find((candidate) => {
    return (
      candidate.type === 'MemberExpression' &&
      candidate.object === node &&
      !candidate.computed &&
      !candidate.optional &&
      candidate.property.type === 'Identifier' &&
      candidate.property.name === 'map'
    );
  });
  if (member === undefined) return false;
  const call = context.tree.find(
    (candidate) => candidate.type === 'CallExpression' && candidate.callee === member,
  );
  const callback = call?.type === 'CallExpression' ? call.arguments[0] : undefined;
  return (
    call?.type === 'CallExpression' &&
    !call.optional &&
    call.arguments.length === 1 &&
    callback !== undefined &&
    callback.type !== 'SpreadElement' &&
    scalarCallback(callback, context)
  );
}
