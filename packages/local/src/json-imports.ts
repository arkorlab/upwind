import type { Expression, Node, PropertyKey } from '@oxc-project/types';
import { parseSync } from 'rolldown/utils';

import { constantStringOf as stringOf } from './json-strings.ts';

type ModuleRequestKind =
  | 'ImportDeclaration'
  | 'ExportNamedDeclaration'
  | 'ExportAllDeclaration'
  | 'ImportExpression';
type ModuleRequest = Extract<Node, { type: ModuleRequestKind }>;

function nameOf(key: PropertyKey, computed: boolean): string | undefined {
  if (!computed && key.type === 'Identifier') {
    return key.name;
  }
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}

/** A statically named, ordinary data property; later properties can replace an earlier one. */
function propertyOf(object: Expression | null | undefined, name: string): Expression | undefined {
  if (object?.type !== 'ObjectExpression') {
    return undefined;
  }
  let value: Expression | undefined;
  for (const property of object.properties) {
    if (property.type === 'SpreadElement') {
      value = undefined;
      continue;
    }
    const key = nameOf(property.key, property.computed);
    if (key === undefined) {
      value = undefined;
    } else if (key === name) {
      value = property.kind === 'init' && !property.method ? property.value : undefined;
    }
  }
  return value;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
  );
}

function isModuleRequest(node: Node): node is ModuleRequest {
  return [
    'ExportAllDeclaration',
    'ExportNamedDeclaration',
    'ImportDeclaration',
    'ImportExpression',
  ].includes(node.type);
}

/** One module request, where this syntax node carries the JSON type. */
function jsonImportsIn(node: Node): string[] {
  if (!isModuleRequest(node)) {
    return [];
  }
  switch (node.type) {
    case 'ImportDeclaration':
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration': {
      const json = node.attributes.some(
        (attribute) => nameOf(attribute.key, false) === 'type' && attribute.value.value === 'json',
      );
      return json && node.source !== null ? [node.source.value] : [];
    }
    case 'ImportExpression': {
      const attributes = propertyOf(node.options, 'with') ?? propertyOf(node.options, 'assert');
      return stringOf(propertyOf(attributes, 'type')) === 'json'
        ? importSpecifiersOf(node.source)
        : [];
    }
  }
}

/** The old parser records every string leaf of a conditional import argument. */
function importSpecifiersOf(source: Expression): string[] {
  const imports: string[] = [];
  const pending = [source];
  while (pending.length > 0) {
    const expression = pending.pop();
    if (expression === undefined) break;
    if (expression.type === 'ConditionalExpression') {
      pending.push(expression.alternate, expression.consequent);
    } else {
      const specifier = stringOf(expression);
      if (specifier !== undefined) imports.push(specifier);
    }
  }
  return imports;
}

interface ConstantFacts {
  readonly truthy: boolean | undefined;
  readonly nullish: boolean | undefined;
}

type Facts = ReadonlyMap<Node, ConstantFacts>;
const BIGINT_ZERO = 0n;
const TRUTHY: ConstantFacts = { truthy: true, nullish: false };
const FALSY: ConstantFacts = { truthy: false, nullish: false };
const NULLISH: ConstantFacts = { truthy: false, nullish: true };
const NONNULL: ConstantFacts = { truthy: undefined, nullish: false };

/** Read literal metadata only: RegExp's serialized value may be null, but its result is truthy. */
function literalFacts(node: Extract<Node, { type: 'Literal' }>): ConstantFacts {
  if ('regex' in node) return TRUTHY;
  if ('bigint' in node) return BigInt(node.bigint) === BIGINT_ZERO ? FALSY : TRUTHY;
  if (node.value === null) return NULLISH;
  const truthy = Boolean(node.value);
  return truthy ? TRUTHY : FALSY;
}

function takesLogicalRight(
  node: Extract<Node, { type: 'LogicalExpression' }>,
  left: ConstantFacts | undefined,
): boolean | undefined {
  if (left === undefined) return undefined;
  switch (node.operator) {
    case '??': {
      return left.nullish;
    }
    case '&&': {
      return left.truthy;
    }
    case '||': {
      return left.truthy === undefined ? undefined : !left.truthy;
    }
  }
}

function logicalFacts(
  node: Extract<Node, { type: 'LogicalExpression' }>,
  facts: Facts,
): ConstantFacts | undefined {
  const left = facts.get(node.left);
  const takeRight = takesLogicalRight(node, left);
  if (takeRight !== undefined) return takeRight ? facts.get(node.right) : left;
  const right = facts.get(node.right);
  if (node.operator === '||' && right?.truthy === true) {
    return { truthy: true, nullish: undefined };
  }
  if (node.operator === '&&' && right?.truthy === false) {
    return { truthy: false, nullish: undefined };
  }
  return undefined;
}

/** Coerce only parsed primitive literals; an identifier or object may run application code. */
function numericUnaryFacts(node: Extract<Node, { type: 'UnaryExpression' }>): ConstantFacts {
  const argument = node.argument;
  if (argument.type !== 'Literal' || 'regex' in argument) return NONNULL;
  if ('bigint' in argument) {
    if (node.operator !== '-') return NONNULL;
    return BigInt(argument.bigint) === BIGINT_ZERO ? FALSY : TRUTHY;
  }
  const value = Number(argument.value);
  return value ? TRUTHY : FALSY;
}

function unaryFacts(node: Extract<Node, { type: 'UnaryExpression' }>, facts: Facts): ConstantFacts {
  if (node.operator === 'void') return NULLISH;
  if (node.operator === 'typeof') return TRUTHY;
  if (node.operator === '+' || node.operator === '-') return numericUnaryFacts(node);
  const truthy = facts.get(node.argument)?.truthy;
  if (truthy !== undefined && node.operator === '!') return truthy ? FALSY : TRUTHY;
  return NONNULL;
}

/** Never resolve identifiers or call application code to decide whether a branch is dead. */
function constantFacts(node: Node, facts: Facts): ConstantFacts | undefined {
  if (node.type === 'Literal') return literalFacts(node);
  if (node.type === 'UnaryExpression') return unaryFacts(node, facts);
  if (node.type === 'BinaryExpression' || node.type === 'UpdateExpression') return NONNULL;
  if (node.type === 'SequenceExpression') {
    const last = node.expressions.at(-1);
    return last === undefined ? undefined : facts.get(last);
  }
  if (node.type === 'ConditionalExpression') {
    const truthy = facts.get(node.test)?.truthy;
    if (truthy === undefined) return undefined;
    return facts.get(truthy ? node.consequent : node.alternate);
  }
  if (node.type === 'LogicalExpression') return logicalFacts(node, facts);
  return [
    'ArrayExpression',
    'ArrowFunctionExpression',
    'ClassExpression',
    'FunctionExpression',
    'ObjectExpression',
  ].includes(node.type)
    ? TRUTHY
    : undefined;
}

/** Cache bottom-up facts with an explicit stack, independent of source nesting depth. */
function factsOf(program: Node): Facts {
  const facts = new Map<Node, ConstantFacts>();
  const nodes: Node[] = [];
  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    nodes.push(node);
    for (const child of childrenOf(node)) pending.push(child);
  }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const known = constantFacts(node, facts);
    if (known !== undefined) facts.set(node, known);
  }
  return facts;
}

/** Keep tests/left operands: their imports still execute even if their result is known. */
function reachableChildren(node: Node, facts: Facts): Node[] {
  if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
    const truthy = facts.get(node.test)?.truthy;
    if (truthy !== undefined) {
      const selected = truthy ? node.consequent : node.alternate;
      return selected === null ? [node.test] : [node.test, selected];
    }
  }
  if (
    node.type === 'LogicalExpression' &&
    takesLogicalRight(node, facts.get(node.left)) === false
  ) {
    return [node.left];
  }
  return childrenOf(node);
}

function childrenOf(node: Node): Node[] {
  const children: Node[] = [];
  for (const [key, child] of Object.entries(node)) {
    if (key === 'parent') {
      continue;
    }
    const candidates: unknown[] = Array.isArray(child) ? child : [child];
    for (const candidate of candidates) {
      if (isNode(candidate)) {
        children.push(candidate);
      }
    }
  }
  return children;
}

/**
 * Only real imports and re-exports carrying the JSON type, including the older `assert` spelling.
 * Invalid JavaScript is left to the runtime to judge, as it was by the previous bundler.
 */
export function jsonImportsOf(name: string, source: string): string[] {
  try {
    const parsed = parseSync(name, source, {
      lang: 'js',
      sourceType: 'unambiguous',
      preserveParens: false,
    });
    if (parsed.errors.some((error) => error.severity === 'Error')) {
      return [];
    }
    const imports: string[] = [];
    const facts = factsOf(parsed.program);
    const pending: Node[] = [parsed.program];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node === undefined) {
        break;
      }
      for (const specifier of jsonImportsIn(node)) imports.push(specifier);
      for (const child of reachableChildren(node, facts).toReversed()) {
        pending.push(child);
      }
    }
    return imports;
  } catch {
    return [];
  }
}
