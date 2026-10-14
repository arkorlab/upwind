import { Schema } from '@stayingupwind/core/schema';

/**
 * A value from outside the host, checked against its schema at a cost that stays near the size of
 * what was sent.
 *
 * `safeParse` does not stop at the first thing wrong: it goes through the whole value and records
 * an issue for every element and every field that fails. A body that repeats `{}` through an array
 * of objects costs an issue for each field each of them lacks: 256 KiB of it against the cache
 * commit's schema was measured building about 220 MiB of them in an isolate that runs zod as the
 * Workers runtime does, uncompiled, before a spread of them overran the stack — past the 128 MB an
 * isolate holds, from a body the size of a small image. `.max()` on the array does not help: zod
 * measures an array only once every element has been checked. `validate` runs the same checks,
 * stops at the first element or field that fails outright, and answers only whether one did — a
 * tenth of a mebibyte for the same body. So a long value is asked `validate` first, and parsed only
 * once it has passed. A schema of core's validator (`@stayingupwind/core/schema`) is taken here as
 * well as zod's: its `safeParse` and `validate` answer as zod's do.
 *
 * Asked twice, a value that passes runs every check, default and refinement of the schema twice.
 * One of core's validator is asked once instead: a run as `validate` runs, which stops only at a
 * failure, went through the whole of a value that has none, and made what `safeParse` would have.
 * zod has no such run to ask for, so one of zod's is asked both, and has to be a schema whose
 * checks answer the same each time they are run.
 *
 * `validate` is not a bound of its own. zod's walks a record to its end, and either goes on past a
 * check that lets parsing go on — a string too short, a pattern not matched — as `safeParse` does;
 * what those cost is held only by how far the body was read.
 */

const KIB = 1024;
const LISTED_KIB = 4;
/**
 * The longest body a refusal lists the issues of. What the list costs grows with the body: a
 * commit whose outputs are `{}`, each lacking eight fields, was measured at 11 MiB for 4 KiB, half
 * what `JSON.parse` of a mebibyte of `[{},{},…]` costs on its own (22 MiB). A body written by hand
 * and got wrong comes nowhere near it.
 */
export const MAX_LISTED_BYTES = LISTED_KIB * KIB;

/** What the refusal of a longer body says in place of its issues. */
export const UNLISTED_MISMATCH = `the body does not match the schema; a body past ${MAX_LISTED_BYTES} bytes is refused without its issues`;

/** One thing a schema found wrong, as zod's errors and core's validator's both list it. */
export interface ReportedIssue {
  readonly code: string;
  readonly path: PropertyKey[];
  readonly message: string;
}

/** What a refused value comes back with: what was wrong with it, issue by issue. */
export interface ParseFailure {
  readonly issues: readonly ReportedIssue[];
}

/**
 * A schema as this file asks one: `validate` and `safeParse`, which zod's schemas and core's
 * validator's (`@stayingupwind/core/schema`) both answer, and answer alike.
 */
export interface CheckingSchema<T> {
  validate: (value: unknown) => boolean;
  safeParse: (
    value: unknown,
  ) =>
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: ParseFailure };
}

/** What `safeParse` answers, save that a refusal may come without its issues. */
export type BoundedParse<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: ParseFailure | undefined };

const UNLISTED = { success: false, error: undefined } as const;
/** How `validate` runs one of core's schemas: stopping at the first thing that fails outright. */
const AS_VALIDATED = { abortEarly: true } as const;

/**
 * `value` as `schema` parses it, asked of `validate` first: a value it refuses is refused without
 * an issue listed, however long it is. For a caller that never says what was wrong.
 */
export function safeParseValidated<T>(schema: CheckingSchema<T>, value: unknown): BoundedParse<T> {
  if (schema instanceof Schema) {
    const run = schema.run({ value, issues: [] }, AS_VALIDATED);
    return run.issues.length === 0 ? { success: true, data: run.value as T } : UNLISTED;
  }
  if (!schema.validate(value)) {
    return UNLISTED;
  }
  // The same checks, run to the end this time for the value they make; one that passed them once
  // passes them again, and a schema that answered otherwise is refused the same way.
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed : UNLISTED;
}

/**
 * `value` as `schema` parses it: what `safeParse` answers for a body of up to `MAX_LISTED_BYTES`,
 * whose issues are cheap to list, and for a longer one what `safeParseValidated` answers.
 */
export function safeParseBounded<T>(
  schema: CheckingSchema<T>,
  value: unknown,
  /** How long the body was, in bytes or in UTF-16 code units: its structure is ASCII either way. */
  length: number,
): BoundedParse<T> {
  return length <= MAX_LISTED_BYTES ? schema.safeParse(value) : safeParseValidated(schema, value);
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_OBJECT = 0x7b;
const OPEN_ARRAY = 0x5b;
/** The bytes that open a value or separate two, outside a string. */
const COUNTED: ReadonlySet<number> = new Set([COMMA, OPEN_ARRAY, OPEN_OBJECT]);

/**
 * Whether JSON text holds no more than `limit` values, counted without parsing it: every object and
 * array it opens and every comma between members or elements, outside its strings.
 *
 * What `JSON.parse` makes of a body is the body's to decide, and far more than its bytes: 22 MiB of
 * heap for a mebibyte of `[{},{},…]`. Its strings cost about what they weigh, so a body of long
 * strings is cheap to parse however long it is; what costs is a body of many small values. This
 * holds that down before the parse, at the price of one pass over the bytes. Text that is not JSON
 * is not judged: the parse that follows refuses it.
 */
export function jsonValuesWithin(bytes: Uint8Array, limit: number): boolean {
  let inString = false;
  let escaped = false;
  let values = 0;
  for (const byte of bytes) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (byte === BACKSLASH) {
        escaped = true;
      } else if (byte === QUOTE) {
        inString = false;
      }
    } else if (byte === QUOTE) {
      inString = true;
    } else if (COUNTED.has(byte)) {
      values += 1;
      if (values > limit) {
        return false;
      }
    }
  }
  return true;
}
