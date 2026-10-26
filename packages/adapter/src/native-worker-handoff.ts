import type { Node } from '@oxc-project/types';

import { AuditError } from './dependencies.ts';
import { type NativeBindings, stringOf } from './native-ast.ts';
import { nativeWorkerValues } from './native-worker-branches.ts';

const MAX_MEMBER_STEPS = 1024;
const MAX_MEMBER_DEPTH = 32;
const MAX_MEMBER_KEY = 240;
const CAPABILITY_KEYS: ReadonlySet<string> = new Set([
  'apply',
  'bind',
  'call',
  'catch',
  'constructor',
  'default',
  'finally',
  'prototype',
  'then',
  'Worker',
]);
interface HandoffContext {
  readonly bindings: NativeBindings;
  readonly origin: (node: Node) => string | undefined;
}

interface MemberSelection {
  readonly node: Node;
  readonly keys: readonly (string | undefined)[];
}

function dataKey(
  node: Extract<Node, { type: 'MemberExpression' | 'Property' }>,
): string | undefined {
  const key = node.type === 'Property' ? node.key : node.property;
  if (!node.computed && key.type === 'Identifier')
    return key.name.length <= MAX_MEMBER_KEY ? key.name : undefined;
  if (key.type !== 'Literal') return undefined;
  const value = key.value;
  let name: string | undefined;
  if (typeof value === 'string') name = value;
  else if (typeof value === 'number' && Number.isFinite(value)) name = String(value);
  return name !== undefined && name.length <= MAX_MEMBER_KEY ? name : undefined;
}

/** Select only original data nodes; accessors and callbacks are never invoked or interpreted. */
class StaticMemberValues {
  private readonly context: HandoffContext;
  private readonly pending: MemberSelection[] = [];
  private readonly seen = new Map<Node, Set<string>>();
  private readonly result: Node[] = [];
  private steps = 0;

  constructor(value: Node, keys: MemberSelection['keys'], context: HandoffContext) {
    this.context = context;
    this.add(value, keys);
  }

  private add(node: Node, keys: MemberSelection['keys']): void {
    if (keys.length > MAX_MEMBER_DEPTH || this.steps >= MAX_MEMBER_STEPS)
      throw new AuditError('Worker container static member analysis exceeds its finite bounds');
    const key = JSON.stringify(keys);
    const seen = this.seen.get(node) ?? new Set<string>();
    if (seen.has(key)) return;
    seen.add(key);
    this.seen.set(node, seen);
    this.steps += 1;
    this.pending.push({ node, keys });
  }

  private object(
    node: Extract<Node, { type: 'ObjectExpression' }>,
    keys: MemberSelection['keys'],
  ): void {
    const [key, ...remaining] = keys;
    for (const property of node.properties) {
      if (property.type === 'SpreadElement') {
        this.add(property.argument, keys);
        continue;
      }
      if (property.kind !== 'init' || property.method) continue;
      const selected = dataKey(property);
      if (selected === '__proto__' && !property.computed) this.add(property.value, keys);
      if (key === undefined || selected === undefined || key === selected)
        this.add(property.value, remaining);
    }
  }

  private expand({ node, keys }: MemberSelection): void {
    if (node.type === 'ChainExpression') {
      this.add(node.expression, keys);
      return;
    }
    const choices = nativeWorkerValues(node);
    if (choices !== undefined) {
      for (const value of choices) this.add(value, keys);
      return;
    }
    if (node.type === 'MemberExpression') {
      this.add(node.object, [dataKey(node), ...keys]);
      return;
    }
    if (node.type === 'ObjectExpression') {
      this.object(node, keys);
      return;
    }
    if (node.type === 'ArrayExpression') {
      this.array(node, keys);
      return;
    }
    const initializer = objectInitializer(node, this.context);
    if (initializer !== undefined) this.add(initializer, keys);
  }

  private array(
    node: Extract<Node, { type: 'ArrayExpression' }>,
    keys: MemberSelection['keys'],
  ): void {
    for (const value of node.elements) {
      if (value === null) continue;
      if (value.type === 'SpreadElement') this.add(value.argument, keys);
      else this.add(value, keys.slice(1));
    }
  }

  values(): readonly Node[] {
    for (let item = this.pending.pop(); item !== undefined; item = this.pending.pop()) {
      if (item.keys.length === 0) {
        this.result.push(item.node);
        continue;
      }
      const origin = this.context.origin(item.node);
      if (origin === undefined) this.expand(item);
      else if (
        origin === 'ambiguous' ||
        item.keys.some((key) => key === undefined || CAPABILITY_KEYS.has(key))
      )
        this.result.push(item.node);
    }
    return this.result;
  }
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

function containerValues(node: Node, context: HandoffContext): readonly Node[] {
  if (node.type === 'ChainExpression') return [node.expression];
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

function hasContainerCarrier(value: Node, context: HandoffContext): boolean {
  const seen = new Set<Node>();
  const pending: Node[] = [value];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    if (context.origin(node) !== undefined) return true;
    if (node.type === 'MemberExpression') {
      if (context.origin(node.object) === undefined) pending.push(node.object);
    } else pending.push(...containerValues(node, context));
  }
  return false;
}

function handoffValues(node: Node, context: HandoffContext): readonly Node[] {
  if (node.type !== 'MemberExpression') return containerValues(node, context);
  return context.origin(node.object) === undefined && hasContainerCarrier(node.object, context)
    ? new StaticMemberValues(node.object, [dataKey(node)], context).values()
    : [];
}

interface PatternSelection {
  readonly pattern: Node;
  readonly keys: MemberSelection['keys'];
}

function patternValues(pattern: Node, keys: MemberSelection['keys']): readonly PatternSelection[] {
  if (pattern.type === 'AssignmentPattern') return [{ pattern: pattern.left, keys }];
  if (pattern.type === 'RestElement')
    return [{ pattern: pattern.argument, keys: [...keys, undefined] }];
  if (pattern.type === 'ObjectPattern')
    return pattern.properties.map((property) => {
      return property.type === 'RestElement'
        ? { pattern: property, keys }
        : { pattern: property.value, keys: [...keys, dataKey(property)] };
    });
  if (pattern.type === 'ArrayPattern')
    return pattern.elements.flatMap((element, index) => {
      if (element === null) return [];
      const elementKeys = element.type === 'RestElement' ? keys : [...keys, String(index)];
      return [{ pattern: element, keys: elementKeys }];
    });
  return [];
}

function destructuredCarrier(pattern: Node, value: Node, context: HandoffContext): boolean {
  if (!hasContainerCarrier(value, context)) return false;
  const pending: PatternSelection[] = [{ pattern, keys: [] }];
  let steps = 0;
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    steps += 1;
    if (steps > MAX_MEMBER_STEPS || item.keys.length > MAX_MEMBER_DEPTH)
      throw new AuditError('Worker container static member analysis exceeds its finite bounds');
    if (item.pattern.type === 'Identifier') {
      if (
        new StaticMemberValues(value, item.keys, context)
          .values()
          .some((node) => handedOffCapability(node, context))
      )
        return true;
    } else pending.push(...patternValues(item.pattern, item.keys));
  }
  return false;
}

function transferredValue(node: Node): Node | undefined {
  if (node.type === 'YieldExpression' || node.type === 'ThrowStatement')
    return node.argument ?? undefined;
  if (node.type === 'PropertyDefinition') return node.value ?? undefined;
  return undefined;
}

function transferredWorkerCapability(node: Node, context: HandoffContext): boolean {
  if (node.type === 'CallExpression' || node.type === 'NewExpression')
    return node.arguments.some((argument) => {
      return handedOffCapability(
        argument.type === 'SpreadElement' ? argument.argument : argument,
        context,
      );
    });
  if (node.type === 'TaggedTemplateExpression')
    return node.quasi.expressions.some((value) => handedOffCapability(value, context));
  const value = transferredValue(node);
  if (value !== undefined) return handedOffCapability(value, context);
  return (
    node.type === 'VariableDeclarator' &&
    (node.id.type === 'ObjectPattern' || node.id.type === 'ArrayPattern') &&
    node.init !== null &&
    destructuredCarrier(node.id, node.init, context)
  );
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
  if (transferredWorkerCapability(node, context)) return true;
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
