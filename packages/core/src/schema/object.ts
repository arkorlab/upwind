import type { ParseContext, Payload } from './checks.ts';
import { aborted, prefixIssues } from './issues.ts';
import { isObject } from './plain.ts';
import { Schema } from './schema.ts';
import type {
  Extend,
  ObjectInput,
  ObjectOutput,
  OptIn,
  OptOut,
  Shape,
  UnknownKeys,
} from './types.ts';

/** Where a field's result goes: its key, and whether it may be absent going in and coming out. */
interface Slot {
  readonly key: string;
  readonly optin: OptIn;
  readonly optout: OptOut;
}

/** A field of the shape, with the schema that parses it. */
interface Field extends Slot {
  readonly schema: Schema;
}

/** A field's result written into the object being built, as zod writes it. */
function settle(
  result: Payload,
  final: Payload,
  input: Record<PropertyKey, unknown>,
  slot: Slot,
): void {
  const { key } = slot;
  // eslint-disable-next-line unicorn/no-computed-property-existence-check -- presence is `in`, inherited keys included, as zod decides it.
  const present = key in input;
  const optionalOut = slot.optout === 'optional';
  // A field that may be absent and is absent is not judged: whatever its schema said of the missing
  // value, a refinement's issue included, is dropped, as zod drops it.
  if (!present && optionalOut && slot.optin === 'optional') {
    return;
  }
  if (result.issues.length > 0) {
    if (!present && optionalOut && slot.optin !== undefined) {
      return;
    }
    final.issues.push(...prefixIssues(key, result.issues));
  }
  if (!present && slot.optin === undefined) {
    if (result.issues.length === 0) {
      final.issues.push({
        code: 'invalid_type',
        expected: 'nonoptional',
        input: undefined,
        path: [key],
      });
    }
    return;
  }
  const output = final.value as Record<string, unknown>;
  if (result.value !== undefined) {
    output[key] = result.value;
  } else if (present || (!optionalOut && slot.optin === 'defaulted')) {
    output[key] = undefined;
  }
}

function fieldsOf(fields: Shape): readonly Field[] {
  return Object.entries(fields).map(([key, typed]) => {
    const schema = typed as Schema;
    return { key, schema, optin: schema.optin, optout: schema.optout };
  });
}

/**
 * An object with the given fields. Unknown keys are dropped (`object`), refused (`strictObject`),
 * or kept as they are (`looseObject`). What is returned is a new object, its keys in the shape's
 * order; a field that is optional and absent stays absent.
 */
export class ObjectSchema<
  S extends Shape = Shape,
  M extends UnknownKeys = UnknownKeys,
> extends Schema<ObjectOutput<S, M>, ObjectInput<S, M>, undefined, undefined> {
  /**
   * The shape as this schema reads it: a copy of the one it was given, made when first needed, and
   * then the only one every parse, `shape` and every schema derived from this one read — so a later
   * change to the object it was given changes nothing here, as with zod.
   */
  private copied: S | undefined;
  /** The fields in the order they are parsed, made at the first parse rather than at construction. */
  private slots: readonly Field[] | undefined;
  private readonly given: S;
  readonly unknownKeys: M;

  constructor(fields: S, unknownKeys: M) {
    super();
    this.copied = undefined;
    this.slots = undefined;
    this.given = fields;
    this.unknownKeys = unknownKeys;
  }

  /** Keys the shape does not name, own or inherited, as a strict or loose object takes them. */
  private unknown(
    input: Record<PropertyKey, unknown>,
    payload: Payload,
    ctx: ParseContext,
  ): Payload {
    const unrecognized: string[] = [];
    let seen = 0;
    for (const key in input) {
      // A key the shape names is not unknown. Skipped before the early stop below is asked,
      // which cannot change what is found: the stop only waits for the next unknown key.
      if (Object.hasOwn(this.shape, key)) {
        continue;
      }
      if (ctx.abortEarly && payload.issues.length !== seen) {
        if (aborted(payload.issues, seen)) {
          break;
        }
        seen = payload.issues.length;
      }
      if (this.unknownKeys === 'strict') {
        unrecognized.push(key);
      } else if (key !== '__proto__') {
        settle({ value: input[key], issues: [] }, payload, input, {
          key,
          optin: undefined,
          optout: undefined,
        });
      }
    }
    if (unrecognized.length > 0) {
      payload.issues.push({ code: 'unrecognized_keys', keys: unrecognized, input, continue: true });
    }
    return payload;
  }

  get shape(): S {
    this.copied ??= { ...this.given };
    return this.copied;
  }

  parseType(payload: Payload, ctx: ParseContext): Payload {
    const input = payload.value;
    if (!isObject(input)) {
      payload.issues.push({ expected: 'object', code: 'invalid_type', input });
      return payload;
    }
    payload.value = {};
    this.slots ??= fieldsOf(this.shape);
    let seen = payload.issues.length;
    for (const field of this.slots) {
      if (ctx.abortEarly && payload.issues.length !== seen) {
        if (aborted(payload.issues, seen)) {
          break;
        }
        seen = payload.issues.length;
      }
      // A field named `__proto__` is never parsed or written, as zod never parses one: no object
      // built here could carry it as a key of its own.
      if (field.key !== '__proto__') {
        settle(
          field.schema.run({ value: input[field.key], issues: [] }, ctx),
          payload,
          input,
          field,
        );
      }
    }
    return this.unknownKeys === 'strip' ? payload : this.unknown(input, payload, ctx);
  }

  /** The same object with these fields added, or laid over the ones of the same name. */
  extend<const U extends Shape>(fields: U): ObjectSchema<Extend<S, U>, M> {
    if (this.checks.length > 0) {
      for (const key of Object.keys(fields)) {
        if (Object.hasOwn(this.shape, key)) {
          throw new Error('Cannot overwrite keys on object schemas containing refinements.');
        }
      }
    }
    const merged: Extend<S, U> = { ...this.shape, ...fields };
    const copy = new ObjectSchema(merged, this.unknownKeys);
    return this.checks.length === 0 ? copy : copy.withChecks(this.checks);
  }

  /** The same object without the fields named. Refinements of the object do not come along. */
  omit<const K extends keyof S & string>(
    mask: Readonly<Record<K, true>>,
  ): ObjectSchema<Omit<S, K>, M> {
    if (this.checks.length > 0) {
      throw new Error('.omit() cannot be used on object schemas containing refinements');
    }
    const fields: Record<string, unknown> = { ...this.shape };
    for (const key of Object.keys(mask)) {
      if (!Object.hasOwn(this.shape, key)) {
        throw new Error(`Unrecognized key: "${key}"`);
      }
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the keys are the mask's, checked above.
      delete fields[key];
    }
    return new ObjectSchema(fields as Omit<S, K>, this.unknownKeys);
  }

  /** The same object, refusing keys its shape does not name. */
  strict(): ObjectSchema<S, 'strict'> {
    const copy = new ObjectSchema(this.shape, 'strict');
    return this.checks.length === 0 ? copy : copy.withChecks(this.checks);
  }
}

export function object<const S extends Shape>(fields: S): ObjectSchema<S, 'strip'> {
  return new ObjectSchema(fields, 'strip');
}

export function strictObject<const S extends Shape>(fields: S): ObjectSchema<S, 'strict'> {
  return new ObjectSchema(fields, 'strict');
}

export function looseObject<const S extends Shape>(fields: S): ObjectSchema<S, 'loose'> {
  return new ObjectSchema(fields, 'loose');
}
