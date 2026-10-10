import type { Payload } from './checks.ts';
import { Schema } from './schema.ts';
import type { Primitive } from './types.ts';

type ValueKind = 'boolean' | 'literal' | 'null' | 'unknown';

/** `boolean()`, `null()`, `unknown()` and `literal()`: a schema for one type, or a few values. */
export class ValueSchema<Out = unknown> extends Schema<Out, Out, undefined, undefined> {
  readonly kind: ValueKind;
  /** A literal's values, as they were given; what a discriminated union reads. */
  readonly values: readonly Primitive[] | undefined;
  readonly accepted: ReadonlySet<unknown> | undefined;

  constructor(kind: ValueKind, values?: readonly Primitive[]) {
    super();
    this.kind = kind;
    this.values = values;
    this.accepted = values === undefined ? undefined : new Set<unknown>(values);
  }

  parseType(payload: Payload): Payload {
    const input = payload.value;
    switch (this.kind) {
      case 'unknown': {
        return payload;
      }
      case 'boolean': {
        if (typeof input !== 'boolean') {
          payload.issues.push({ expected: 'boolean', code: 'invalid_type', input });
        }
        return payload;
      }
      case 'null': {
        if (input !== null) {
          payload.issues.push({ expected: 'null', code: 'invalid_type', input });
        }
        return payload;
      }
      case 'literal': {
        if (this.accepted?.has(input) !== true) {
          payload.issues.push({ code: 'invalid_value', values: this.values, input });
        }
        return payload;
      }
    }
  }
}

export function boolean(): ValueSchema<boolean> {
  return new ValueSchema<boolean>('boolean');
}

export function nullValue(): ValueSchema<null> {
  return new ValueSchema<null>('null');
}

export function unknown(): ValueSchema {
  return new ValueSchema('unknown');
}

export function literal<const T extends readonly Primitive[]>(value: T): ValueSchema<T[number]>;
export function literal<const T extends Primitive>(value: T): ValueSchema<T>;
export function literal(value: Primitive | readonly Primitive[]): ValueSchema {
  // A copy, so that what is accepted and what an issue lists cannot come apart if the list changes.
  return new ValueSchema('literal', isList(value) ? [...value] : [value]);
}

function isList(value: Primitive | readonly Primitive[]): value is readonly Primitive[] {
  return Array.isArray(value);
}

/**
 * One of a list of strings. Its values stand in the order an object gives its keys — integer-like
 * strings first — since zod keeps them as an object's keys, and an issue lists them that way.
 */
export class EnumSchema<T extends string = string> extends Schema<T, T, undefined, undefined> {
  readonly values: readonly T[];
  readonly accepted: ReadonlySet<unknown>;

  constructor(values: readonly T[]) {
    super();
    const ordered = Object.values(
      Object.fromEntries(values.map((value) => [value, value])),
    ) as readonly T[];
    this.values = ordered;
    this.accepted = new Set<unknown>(ordered);
  }

  get options(): T[] {
    return [...this.values];
  }

  parseType(payload: Payload): Payload {
    const input = payload.value;
    if (!this.accepted.has(input)) {
      payload.issues.push({ code: 'invalid_value', values: this.values, input });
    }
    return payload;
  }
}

export function enumOf<const T extends readonly string[]>(values: T): EnumSchema<T[number]> {
  return new EnumSchema<T[number]>(values);
}
