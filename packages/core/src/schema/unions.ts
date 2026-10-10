import type { ParseContext, Payload } from './checks.ts';
import { aborted, finalizeIssue } from './issues.ts';
import { ObjectSchema } from './object.ts';
import { isObject } from './plain.ts';
import { Schema, WrapperSchema } from './schema.ts';
import type { Input, OptIn, OptOut, Output, Primitive, Shape, Typed } from './types.ts';
import { EnumSchema, ValueSchema } from './values.ts';

function optinOf(options: readonly Schema[]): OptIn {
  if (options.some((option) => option.optin === 'defaulted')) {
    return 'defaulted';
  }
  return options.some((option) => option.optin !== undefined) ? 'optional' : undefined;
}

function optoutOf(options: readonly Schema[]): OptOut {
  return options.some((option) => option.optout === 'optional') ? 'optional' : undefined;
}

/**
 * One of several schemas: the first that takes the value without an issue. If none does and just
 * one failed only on checks — the right type, the wrong length — its issues are the answer;
 * otherwise one `invalid_union` issue holds every option's.
 */
export class UnionSchema<T extends readonly Typed[] = readonly Typed[]> extends Schema<
  Output<T[number]>,
  Input<T[number]>,
  undefined,
  undefined
> {
  readonly options: T;

  constructor(options: T) {
    const members = options as unknown as readonly Schema[];
    super(undefined, optinOf(members), optoutOf(members));
    this.options = options;
  }

  parseType(payload: Payload, ctx: ParseContext): Payload {
    const options = this.options as unknown as readonly Schema[];
    const [first] = options;
    if (first !== undefined && options.length === 1) {
      return first.run(payload, ctx);
    }
    const results: Payload[] = [];
    for (const option of options) {
      const result = option.run({ value: payload.value, issues: [] }, ctx);
      if (result.issues.length === 0) {
        return result;
      }
      results.push(result);
    }
    const continuable = results.filter((result) => !aborted(result.issues));
    if (continuable.length === 1) {
      const [only] = continuable as [Payload];
      payload.value = only.value;
      return only;
    }
    payload.issues.push({
      code: 'invalid_union',
      input: payload.value,
      errors: results.map((result) => result.issues.map((issue) => finalizeIssue(issue))),
    });
    return payload;
  }
}

export function union<const T extends readonly Typed[]>(options: T): UnionSchema<T> {
  return new UnionSchema(options);
}

/** The values a field may hold, where it can hold only a few: what a discriminator is read from. */
function valuesOf(schema: Schema): readonly Primitive[] | undefined {
  if (schema instanceof ValueSchema) {
    if (schema.kind === 'null') {
      return [null];
    }
    return schema.kind === 'literal' ? schema.values : undefined;
  }
  if (schema instanceof EnumSchema) {
    return schema.values as readonly string[];
  }
  if (schema instanceof WrapperSchema) {
    const inner = valuesOf(schema.inner);
    if (inner === undefined) {
      return undefined;
    }
    if (schema.wrapping === 'default') {
      return inner;
    }
    return [...inner, schema.wrapping === 'optional' ? undefined : null];
  }
  return undefined;
}

/** Which option a discriminator's value picks; `null` where two options claim it. */
type OptionMap = Map<Primitive, Schema | null>;

function discriminatorMap(discriminator: string, options: readonly Schema[]): OptionMap {
  const map: OptionMap = new Map();
  for (const [index, option] of options.entries()) {
    const field = (option as ObjectSchema).fields[discriminator] as Schema | undefined;
    const values = field === undefined ? undefined : valuesOf(field);
    if (values === undefined || values.length === 0) {
      throw new Error(`Invalid discriminated union option at index "${String(index)}"`);
    }
    const claimed = new Set(field?.optin === undefined ? values : [...values, undefined]);
    for (const value of claimed) {
      if (!map.has(value)) {
        map.set(value, option);
      } else if (value === undefined) {
        map.set(value, null);
      } else {
        throw new Error(`Duplicate discriminator value "${String(value)}"`);
      }
    }
  }
  return map;
}

/**
 * One of several objects, picked by the value of one field they all have. A value no option
 * claims is refused with one issue at that field, listing the values that would have been taken.
 */
export class DiscriminatedUnionSchema<
  D extends string = string,
  T extends readonly Typed[] = readonly Typed[],
> extends Schema<Output<T[number]>, Input<T[number]>, undefined, undefined> {
  /** Built at the first parse, as zod builds it. */
  private map: OptionMap | undefined;
  readonly discriminator: D;
  readonly options: T;

  constructor(discriminator: D, options: T) {
    const members = options as unknown as readonly Schema[];
    super(undefined, optinOf(members), optoutOf(members));
    for (const [index, option] of members.entries()) {
      if (
        !(option instanceof ObjectSchema) ||
        !Object.hasOwn(option.fields as Shape, discriminator)
      ) {
        throw new Error(`Invalid discriminated union option at index "${String(index)}"`);
      }
    }
    this.map = undefined;
    this.discriminator = discriminator;
    this.options = options;
  }

  parseType(payload: Payload, ctx: ParseContext): Payload {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({ code: 'invalid_type', expected: 'object', input });
      return payload;
    }
    this.map ??= discriminatorMap(this.discriminator, this.options as unknown as readonly Schema[]);
    const option = this.map.get(input[this.discriminator] as Primitive);
    if (option !== undefined && option !== null) {
      return option.run(payload, ctx);
    }
    payload.issues.push({
      code: 'invalid_union',
      errors: [],
      note: 'No matching discriminator',
      discriminator: this.discriminator,
      options: [...this.map.keys()].filter((value) => this.map?.get(value) !== null),
      input,
      path: [this.discriminator],
    });
    return payload;
  }
}

export function discriminatedUnion<const D extends string, const T extends readonly Typed[]>(
  discriminator: D,
  options: T,
): DiscriminatedUnionSchema<D, T> {
  return new DiscriminatedUnionSchema(discriminator, options);
}
