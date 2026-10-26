import type { Node } from '@oxc-project/types';

import { type NativeBindings, stringOf } from './native-ast.ts';
import { nativeWorkerValues } from './native-worker-branches.ts';

interface HandoffContext {
  readonly bindings: NativeBindings;
  readonly origin: (node: Node) => string | undefined;
}

function exportedPattern(pattern: Node, context: HandoffContext): boolean {
  let value = pattern;
  while (value.type === 'AssignmentPattern' || value.type === 'RestElement')
    value = value.type === 'AssignmentPattern' ? value.left : value.argument;
  if (value.type === 'Identifier') return handedOffCapability(value, context);
  if (value.type === 'ArrayPattern')
    return value.elements.some((element) => element !== null && exportedPattern(element, context));
  if (value.type === 'ObjectPattern')
    return value.properties.some((property) =>
      exportedPattern(property.type === 'Property' ? property.value : property.argument, context),
    );
  return false;
}

function objectInitializer(value: Node, context: HandoffContext): Node | undefined {
  if (value.type !== 'Identifier') return undefined;
  const declaration = context.bindings.lookup(value, value.name);
  if (
    declaration?.type !== 'VariableDeclarator' ||
    declaration.init === null ||
    declaration.id.type !== 'Identifier'
  )
    return undefined;
  return declaration.init;
}

function handoffValues(node: Node, context: HandoffContext): readonly Node[] {
  const choices = nativeWorkerValues(node);
  if (choices !== undefined) return choices;
  if (node.type === 'ArrayExpression')
    return node.elements.flatMap((element) =>
      element === null ? [] : [element.type === 'SpreadElement' ? element.argument : element],
    );
  if (node.type === 'ObjectExpression')
    return node.properties.map((property) =>
      property.type === 'Property' ? property.value : property.argument,
    );
  const initializer = objectInitializer(node, context);
  return initializer === undefined ? [] : [initializer];
}

function handedOffCapability(value: Node, context: HandoffContext): boolean {
  const seen = new Set<Node>();
  const pending: Node[] = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    if (context.origin(node) !== undefined) return true;
    const values = handoffValues(node, context);
    pending.push(...values);
  }
  return false;
}

function returnedContainerCapability(node: Node, context: HandoffContext): boolean {
  let value: Node | undefined;
  if (node.type === 'ReturnStatement') value = node.argument ?? undefined;
  if (node.type === 'ArrowFunctionExpression' && node.expression) value = node.body;
  // Direct origins retain the existing target-specific namespace return rules.
  return (
    value !== undefined &&
    context.origin(value) === undefined &&
    handedOffCapability(value, context)
  );
}

export function exportedWorkerCapability(
  node: Node,
  context: HandoffContext,
  workerModules: ReadonlySet<string>,
): boolean {
  if (returnedContainerCapability(node, context)) return true;
  // An array can expose a constructor by index or iteration without a scalar origin.
  if (node.type === 'ArrayExpression') return handedOffCapability(node, context);
  if (node.type === 'ExportAllDeclaration') return workerModules.has(stringOf(node.source) ?? '');
  if (node.type === 'ExportDefaultDeclaration')
    return handedOffCapability(node.declaration, context);
  if (node.type === 'AssignmentExpression' || node.type === 'AssignmentPattern')
    return handedOffCapability(node.right, context);
  if (node.type !== 'ExportNamedDeclaration') return false;
  if (node.source !== null) {
    if (!workerModules.has(stringOf(node.source) ?? '')) return false;
    return node.specifiers.some((specifier) => {
      const name =
        specifier.local.type === 'Identifier' ? specifier.local.name : stringOf(specifier.local);
      return name === 'Worker' || name === 'default';
    });
  }
  const declared = node.declaration;
  if (
    declared?.type === 'VariableDeclaration' &&
    declared.declarations.some((item) => exportedPattern(item.id, context))
  )
    return true;
  return node.specifiers.some((specifier) => handedOffCapability(specifier.local, context));
}
