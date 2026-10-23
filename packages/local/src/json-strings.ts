import type { Expression, TemplateLiteral } from '@oxc-project/types';

type Primitive = string | number | boolean | bigint | null | undefined;
interface KnownPrimitive {
  readonly value: Primitive;
}
type Values = ReadonlyMap<Expression, KnownPrimitive>;
const MIN_INT32 = -2_147_483_648;
const MAX_INT32 = 2_147_483_647;

/** Match the old parser's conservative number-to-string folding without application coercion. */
function primitiveString(value: Primitive): string | undefined {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    (!Number.isSafeInteger(value) || value < MIN_INT32 || value > MAX_INT32)
  ) {
    return undefined;
  }
  return String(value);
}

function literalValue(node: Extract<Expression, { type: 'Literal' }>): KnownPrimitive | undefined {
  if ('regex' in node) return undefined;
  // The old parser leaves radix-prefixed bigint stringification unresolved.
  if ('bigint' in node && node.bigint.length > 1 && node.bigint.startsWith('0')) return undefined;
  return { value: node.value };
}

/** Unary string coercion was limited to empty strings and canonical int32 decimal strings. */
function primitiveNumber(value: Primitive): number | undefined {
  if (typeof value === 'bigint') return undefined;
  const number = Number(value);
  if (
    typeof value === 'string' &&
    value !== '' &&
    (!Number.isSafeInteger(number) ||
      number < MIN_INT32 ||
      number > MAX_INT32 ||
      String(number) !== value)
  ) {
    return undefined;
  }
  return number;
}

function unaryValue(
  node: Extract<Expression, { type: 'UnaryExpression' }>,
  values: Values,
): KnownPrimitive | undefined {
  const argument = values.get(node.argument);
  if (argument === undefined) return undefined;
  if (node.operator === 'void') return { value: undefined };
  if (node.operator === '!') {
    const truthy = Boolean(argument.value);
    return { value: !truthy };
  }
  if (node.operator !== '+' && node.operator !== '-') return undefined;
  const number = primitiveNumber(argument.value);
  if (number === undefined) return undefined;
  return { value: node.operator === '+' ? number : -number };
}

/** Numeric-only addition stays unresolved, as in the old non-minifying JavaScript probe. */
function additionValue(
  node: Extract<Expression, { type: 'BinaryExpression' }>,
  values: Values,
): KnownPrimitive | undefined {
  if (node.operator !== '+') return undefined;
  const left = values.get(node.left);
  const right = values.get(node.right);
  if (left === undefined || right === undefined) return undefined;
  if (typeof left.value !== 'string' && typeof right.value !== 'string') return undefined;
  const prefix = primitiveString(left.value);
  const suffix = primitiveString(right.value);
  return prefix === undefined || suffix === undefined ? undefined : { value: `${prefix}${suffix}` };
}

function templateValue(node: TemplateLiteral, values: Values): KnownPrimitive | undefined {
  const parts: string[] = [];
  for (const [index, quasi] of node.quasis.entries()) {
    const cooked = quasi.value.cooked;
    if (cooked === null) return undefined;
    parts.push(cooked);
    const expression = node.expressions[index];
    if (expression === undefined) continue;
    const known = values.get(expression);
    if (known === undefined) return undefined;
    const value = primitiveString(known.value);
    if (value === undefined) return undefined;
    parts.push(value);
  }
  return { value: parts.join('') };
}

function expressionValue(node: Expression, values: Values): KnownPrimitive | undefined {
  if (node.type === 'Literal') return literalValue(node);
  if (node.type === 'UnaryExpression') return unaryValue(node, values);
  if (node.type === 'BinaryExpression') return additionValue(node, values);
  if (node.type === 'TemplateLiteral') return templateValue(node, values);
  return undefined;
}

function valueChildren(node: Expression): Expression[] {
  if (node.type === 'UnaryExpression') return [node.argument];
  if (node.type === 'BinaryExpression' && node.operator === '+') return [node.left, node.right];
  return node.type === 'TemplateLiteral' ? node.expressions : [];
}

/** Evaluate only supported parsed primitive syntax, using a stack rather than source-depth recursion. */
export function constantStringOf(expression: Expression | null | undefined): string | undefined {
  if (expression === null || expression === undefined) return undefined;
  const values = new Map<Expression, KnownPrimitive>();
  const nodes: Expression[] = [];
  const pending = [expression];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    nodes.push(node);
    for (const child of valueChildren(node)) pending.push(child);
  }
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node === undefined) continue;
    const value = expressionValue(node, values);
    if (value !== undefined) values.set(node, value);
  }
  const result = values.get(expression)?.value;
  return typeof result === 'string' ? result : undefined;
}
