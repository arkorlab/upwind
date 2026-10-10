import type { ParseContext, Payload } from './checks.ts';
import { aborted, finalizeIssue, prefixIssues } from './issues.ts';
import { isPlainObject } from './plain.ts';
import { messageOf, type RefineParams, Schema } from './schema.ts';
import type { StringSchema } from './strings.ts';
import type { Input, Output, Typed } from './types.ts';

/** A list, each element parsed by `element`; what is returned is a new array. */
export class ArraySchema<E extends Typed = Typed> extends Schema<
  Output<E>[],
  Input<E>[],
  undefined,
  undefined
> {
  readonly element: E;

  constructor(element: E) {
    super();
    this.element = element;
  }

  parseType(payload: Payload, ctx: ParseContext): Payload {
    const input = payload.value;
    if (!Array.isArray(input)) {
      payload.issues.push({ expected: 'array', code: 'invalid_type', input });
      return payload;
    }
    const elements = input as readonly unknown[];
    const element = this.element as unknown as Schema;
    const output: unknown[] = [];
    payload.value = output;
    for (const [index, item] of elements.entries()) {
      const result = element.run({ value: item, issues: [] }, ctx);
      if (result.issues.length > 0) {
        payload.issues.push(...prefixIssues(index, result.issues));
      }
      output.push(result.value);
      if (ctx.abortEarly && result.issues.length > 0 && aborted(result.issues)) {
        break;
      }
    }
    return payload;
  }

  /** At least `minimum` elements. */
  min(minimum: number, params?: string | RefineParams): this {
    return this.withCheck({ kind: 'min_length', value: minimum, message: messageOf(params) });
  }

  /** At most `maximum` elements. */
  max(maximum: number, params?: string | RefineParams): this {
    return this.withCheck({ kind: 'max_length', value: maximum, message: messageOf(params) });
  }

  /** Exactly `length` elements. */
  length(length: number, params?: string | RefineParams): this {
    return this.withCheck({ kind: 'length_equals', value: length, message: messageOf(params) });
  }
}

export function array<const E extends Typed>(element: E): ArraySchema<E> {
  return new ArraySchema(element);
}

/**
 * An object used as a map: every own enumerable key parsed by `key`, its value by `value`. Only a
 * plain object is one — not an array, a class instance or a `Map`.
 *
 * Keys are strings here, as every record of this package's is. zod retries a key that looks like a
 * number as that number when the key schema refuses it, which a string schema refuses as well, so
 * the retry is not made.
 */
export class RecordSchema<
  K extends StringSchema = StringSchema,
  V extends Typed = Typed,
> extends Schema<Record<Output<K>, Output<V>>, Record<Input<K>, Input<V>>, undefined, undefined> {
  readonly key: K;
  readonly value: V;

  constructor(key: K, value: V) {
    super();
    this.key = key;
    this.value = value;
  }

  /** One entry parsed into the record being built; whether `validate` stops after it. */
  private entry(
    key: string | symbol,
    input: Record<PropertyKey, unknown>,
    payload: Payload,
    ctx: ParseContext,
  ): boolean {
    const keyResult = this.key.run({ value: key, issues: [] }, ctx);
    if (keyResult.issues.length > 0) {
      payload.issues.push({
        code: 'invalid_key',
        origin: 'record',
        issues: keyResult.issues.map((issue) => finalizeIssue(issue)),
        input: key,
        path: [key],
      });
      // `validate` stops here, as it does in a list or an object. zod's records go on, which only
      // costs more: the answer is already no.
      return ctx.abortEarly;
    }
    const outKey = keyResult.value as PropertyKey;
    if (outKey === '__proto__') {
      return false;
    }
    const value = this.value as unknown as Schema;
    const result = value.run({ value: input[key], issues: [] }, ctx);
    if (result.issues.length > 0) {
      payload.issues.push(...prefixIssues(key, result.issues));
    }
    (payload.value as Record<PropertyKey, unknown>)[outKey] = result.value;
    return ctx.abortEarly && result.issues.length > 0 && aborted(result.issues);
  }

  parseType(payload: Payload, ctx: ParseContext): Payload {
    const input = payload.value;
    if (!isPlainObject(input)) {
      payload.issues.push({ expected: 'record', code: 'invalid_type', input });
      return payload;
    }
    payload.value = {};
    for (const key of Reflect.ownKeys(input)) {
      if (key === '__proto__' || !Object.prototype.propertyIsEnumerable.call(input, key)) {
        continue;
      }
      if (this.entry(key, input, payload, ctx)) {
        break;
      }
    }
    return payload;
  }
}

export function record<const K extends StringSchema, const V extends Typed>(
  key: K,
  value: V,
): RecordSchema<K, V> {
  return new RecordSchema(key, value);
}
