import * as s from '../../../core/src/schema/index.ts';

/**
 * What it takes to hold core's validator to zod's answers: the values to ask a schema, made from
 * the schema itself, and its answer to each written out as text, so that two answers compare as
 * strings — what it returned, byte for byte and key for key, or what it reported, issue for issue.
 */

/** A schema as both validators answer it. */
export interface Answering {
  safeParse: (value: unknown) => {
    readonly success: boolean;
    readonly data?: unknown;
    readonly error?: { readonly issues: unknown };
  };
  validate: (value: unknown) => boolean;
}

/** Of each kind of value, how many go into what a schema is asked. */
const MAX_CANDIDATES = 14;
const VALID_STRINGS = 6;
const VALID_NUMBERS = 5;
/** Below this, a schema is asked only for an absent value and `null`. */
const MAX_DEPTH = 6;
const MAX_MUTATION_DEPTH = 5;
/** Of the values made from one starting value, how many are asked. */
const MAX_INPUTS = 6000;

const HEX = 64;
const STRINGS: readonly unknown[] = [
  '',
  ' ',
  'a',
  'A',
  'abc',
  'x'.repeat(HEX),
  '0'.repeat(HEX),
  'f'.repeat(HEX),
  'F'.repeat(HEX),
  '/',
  '/a',
  '/a/b',
  '//x',
  '/[slug]',
  '/_next/static/x.js',
  'app',
  'app-1',
  `dpl_${'a'.repeat(24)}`,
  'x-test',
  'Content-Type',
  'text/html',
  'br',
  '2026-10-10T08:20:02Z',
  '2026-10-10T08:20:02.123Z',
  '2026-10-10T08:20Z',
  '2026-02-29T00:00:00Z',
  '2024-02-29T00:00:00Z',
  'https://example.com',
  ' https://example.com/\n',
  'not a url',
  'segment:x',
  'segment:',
  '0 * * * *',
  '*/5 * * * *',
  'default',
  '__proto__',
  '../x',
  'a\u{0}b',
  '😀',
  '\u{D800}',
  '1',
  'true',
  'null',
  'ab\ncd',
];
const NUMBERS: readonly unknown[] = [
  0,
  -0,
  1,
  -1,
  1.5,
  100,
  599,
  2 ** 31,
  2 ** 53,
  2 ** 53 - 1,
  -(2 ** 53),
  NaN,
  Infinity,
  -Infinity,
];

/** A class instance: an object to an object schema, not one to a record. */
class Instance {
  readonly a = 1;
}

/** `instanceof`, narrowing a generic class to its constraints rather than to `any`. */
function isA<T extends s.Schema>(
  schema: s.Schema,
  kind: abstract new (...args: never[]) => T,
): schema is T {
  return schema instanceof kind;
}

function accepts(schema: s.Schema, value: unknown): boolean {
  return schema.safeParse(value).success;
}

function take(values: readonly unknown[]): unknown[] {
  return values.slice(0, MAX_CANDIDATES);
}

/** Valid values first, then invalid ones, each up to its count. */
function sorted(schema: s.Schema, values: readonly unknown[], valid: number): unknown[] {
  const accepted = values.filter((value) => accepts(schema, value));
  const refused = values.filter((value) => !accepted.includes(value));
  return [...accepted.slice(0, valid), ...refused.slice(0, MAX_CANDIDATES - valid)];
}

/** Values either side of each length a string's checks name. */
function lengthsAround(schema: s.Schema): string[] {
  return schema.checks.flatMap((check) => {
    if (check.kind === 'starts_with') {
      return [`${check.prefix}x`, check.prefix, check.prefix.slice(1)];
    }
    if (check.kind !== 'greater_than' && check.kind !== 'less_than' && 'value' in check) {
      const at = check.value;
      return ['a'.repeat(Math.max(0, at - 1)), 'a'.repeat(at), 'a'.repeat(at + 1)];
    }
    return [];
  });
}

function numbersAround(schema: s.NumberSchema): number[] {
  const half = 0.5;
  return schema.checks.flatMap((check) =>
    'value' in check ? [check.value - 1, check.value, check.value + 1, check.value + half] : [],
  );
}

function valueCandidates(schema: s.ValueSchema): unknown[] {
  switch (schema.kind) {
    case 'literal': {
      return take([...(schema.values ?? []), 'nope', 0, null, undefined, true]);
    }
    case 'boolean': {
      return [true, false, 0, 'true', null, undefined];
    }
    case 'null': {
      return [null, undefined, 0, 'null'];
    }
    case 'unknown': {
      return [undefined, null, 1, 'x', {}];
    }
  }
}

function arrayCandidates(schema: s.ArraySchema, depth: number): unknown[] {
  const element = schema.element as unknown as s.Schema;
  const options = candidates(element, depth + 1);
  const good = options.find((value) => accepts(element, value));
  const one = good === undefined ? [] : [good];
  const list: unknown[] = [[], one, [...one, ...one], options.slice(0, 3), 'x', null, {}];
  for (const check of schema.checks) {
    if (good !== undefined && 'value' in check) {
      list.push(Array.from({ length: check.value + 1 }, () => good));
    }
  }
  return take(list);
}

function recordCandidates(schema: s.RecordSchema, depth: number): unknown[] {
  const keys = sorted(schema.key, [...lengthsAround(schema.key), ...STRINGS], VALID_STRINGS);
  const value = schema.value as unknown as s.Schema;
  const values = candidates(value, depth + 1);
  const goodKey = keys.find((key) => typeof key === 'string' && accepts(schema.key, key));
  const goodValue = values.find((option) => accepts(value, option));
  const list: unknown[] = [{}, [], new Instance(), null, 'x'];
  if (typeof goodKey === 'string') {
    list.push(
      { [goodKey]: goodValue },
      ...values.slice(0, 4).map((option) => ({ [goodKey]: option })),
    );
  }
  for (const key of keys.slice(0, 4)) {
    if (typeof key === 'string') {
      list.push({ [key]: goodValue });
    }
  }
  return take(list);
}

/** An object with each field set to a value it takes, where one was found. */
function baseOf(schema: s.ObjectSchema, depth: number): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  for (const [key, typed] of Object.entries(schema.shape)) {
    const field = typed as unknown as s.Schema;
    const options = candidates(field, depth + 1);
    base[key] = options.find((value) => accepts(field, value)) ?? options[0];
  }
  return base;
}

/** Values to ask `schema`: some it takes and some it refuses, of every kind it could be handed. */
function candidates(schema: s.Schema, depth = 0): unknown[] {
  if (schema instanceof s.WrapperSchema) {
    const nullable = schema.wrapping === 'nullable';
    return take([nullable ? null : undefined, ...candidates(schema.inner, depth), nullable ? undefined : null]);
  }
  if (schema instanceof s.StringSchema) {
    return sorted(schema, [...lengthsAround(schema), ...STRINGS, 1, null, undefined, []], VALID_STRINGS);
  }
  if (isA(schema, s.NumberSchema)) {
    return sorted(schema, [...numbersAround(schema), ...NUMBERS, '1', null, undefined, true], VALID_NUMBERS);
  }
  if (schema instanceof s.TemplateLiteralSchema) {
    return ['segment:x', 'segment:', 'segmentx', '', 1];
  }
  if (schema instanceof s.EnumSchema) {
    return take([...(schema.values as readonly unknown[]), 'nope', 1, null]);
  }
  if (schema instanceof s.ValueSchema) {
    return valueCandidates(schema);
  }
  if (depth > MAX_DEPTH) {
    return [undefined, null];
  }
  if (isA(schema, s.ArraySchema)) {
    return arrayCandidates(schema, depth);
  }
  if (isA(schema, s.RecordSchema)) {
    return recordCandidates(schema, depth);
  }
  if (isA(schema, s.ObjectSchema)) {
    const base = baseOf(schema, depth);
    return take([base, null, [], 'x', { ...base, extra: 1 }, new Instance(), Object.create(null)]);
  }
  if (schema instanceof s.UnionSchema || schema instanceof s.DiscriminatedUnionSchema) {
    const options = schema.options as unknown as readonly s.Schema[];
    return take(options.flatMap((option) => candidates(option, depth + 1).slice(0, 4)));
  }
  return [undefined];
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `base` with one field left out, set to `undefined`, or replaced, a field at a time, at any depth. */
function* objectMutations(
  schema: s.ObjectSchema,
  base: Record<string, unknown>,
  depth: number,
): Generator {
  for (const [key, typed] of Object.entries(schema.shape)) {
    const field = typed as unknown as s.Schema;
    yield Object.fromEntries(Object.entries(base).filter(([name]) => name !== key));
    yield { ...base, [key]: undefined };
    const replacements = candidates(field, depth + 1);
    for (const candidate of replacements) {
      yield { ...base, [key]: candidate };
    }
    const changed = mutations(field, base[key], depth + 1);
    for (const nested of changed) {
      yield { ...base, [key]: nested };
    }
  }
  yield { ...base, unknownKey: 'x' };
}

function* listMutations(schema: s.ArraySchema, base: readonly unknown[], depth: number): Generator {
  const [first, ...rest] = base;
  const changed = mutations(schema.element as unknown as s.Schema, first, depth + 1);
  for (const nested of changed) {
    yield [nested, ...rest];
  }
}

function* recordMutations(
  schema: s.RecordSchema,
  base: Record<string, unknown>,
  depth: number,
): Generator {
  const [first] = Object.keys(base);
  if (first === undefined) {
    return;
  }
  const changed = mutations(schema.value as unknown as s.Schema, base[first], depth + 1);
  for (const nested of changed) {
    yield { ...base, [first]: nested };
  }
}

function* containerMutations(schema: s.Schema, base: unknown, depth: number): Generator {
  if (isA(schema, s.ArraySchema) && Array.isArray(base) && base.length > 0) {
    yield* listMutations(schema, base as unknown[], depth);
  } else if (isA(schema, s.RecordSchema) && isRecordLike(base)) {
    yield* recordMutations(schema, base, depth);
  } else if (schema instanceof s.UnionSchema || schema instanceof s.DiscriminatedUnionSchema) {
    const options = schema.options as unknown as readonly s.Schema[];
    for (const option of options) {
      yield* mutations(option, candidates(option, depth + 1)[0], depth + 1);
    }
  }
}

/** `base`, then every value made from it by changing one thing in it. */
function* mutations(schema: s.Schema, base: unknown, depth = 0): Generator {
  yield base;
  if (depth > MAX_MUTATION_DEPTH) {
    return;
  }
  const inner = schema instanceof s.WrapperSchema ? schema.inner : schema;
  if (isA(inner, s.ObjectSchema) && isRecordLike(base)) {
    yield* objectMutations(inner, base, depth);
  } else {
    yield* containerMutations(inner, base, depth);
  }
}

/**
 * What `schema` is asked: values of its own making, and each value in `starts` with one thing in
 * it changed at a time. Up to `MAX_INPUTS` of each start.
 */
export function inputsFor(schema: s.Schema, starts: readonly unknown[] = []): unknown[] {
  const from = candidates(schema).slice(0, VALID_STRINGS);
  from.push(...starts);
  const inputs: unknown[] = [];
  for (const start of from) {
    let count = 0;
    for (const value of mutations(schema, start)) {
      count += 1;
      if (count > MAX_INPUTS) {
        break;
      }
      inputs.push(value);
    }
  }
  return inputs;
}

/** JSON, with what JSON cannot say marked rather than lost: `undefined`, `-0`, `NaN`, infinities. */
function encode(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === undefined) {
      return '«undefined»';
    }
    if (typeof inner === 'number' && (Object.is(inner, -0) || !Number.isFinite(inner))) {
      return `«${Object.is(inner, -0) ? '-0' : String(inner)}»`;
    }
    if (typeof inner === 'bigint' || typeof inner === 'symbol') {
      return `«${String(inner)}»`;
    }
    return inner;
  });
}

function caught(run: () => unknown): string {
  try {
    return String(run());
  } catch (error) {
    return `throws ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** A schema's whole answer to one value: `safeParse`'s, and `validate`'s beside it. */
export function outcome(schema: Answering, value: unknown): string {
  const valid = caught(() => schema.validate(value));
  return caught(() => {
    const result = schema.safeParse(value);
    return result.success
      ? `ok ${encode(result.data)} | validate=${valid}`
      : `fail ${encode(result.error?.issues)} | validate=${valid}`;
  });
}
