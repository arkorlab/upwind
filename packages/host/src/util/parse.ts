import { Schema } from '@stayingupwind/core/schema';

/**
 * A value from outside the host, checked against its schema at a cost that stays near the size of
 * what was sent.
 *
 * Core schemas stop at the first refused child or check, including continuable failures, and
 * return the parsed value from that same run on success. Even a tiny body can otherwise expand
 * into thousands of issues, so collecting every issue is never appropriate for these boundaries.
 *
 * Legacy zod schemas expose no equivalent one-pass operation here. A longer body is first asked
 * whether it validates, then parsed only after it passes; its checks must give the same answer
 * on both runs. Their small-body diagnostics are bounded by the response renderer as well.
 */

const KIB = 1024;
const LISTED_KIB = 4;
/**
 * The longest body whose refusal includes a diagnostic. Core schemas report the first problem;
 * longer bodies are refused without rendering it.
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

/**
 * `value` as `schema` parses it, asked of `validate` first: a value it refuses is refused without
 * an issue listed, however long it is. For a caller that never says what was wrong.
 */
export function safeParseValidated<T>(schema: CheckingSchema<T>, value: unknown): BoundedParse<T> {
  if (schema instanceof Schema) {
    const parsed = schema.safeParseFirst(value);
    return parsed.success ? { success: true, data: parsed.data as T } : UNLISTED;
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
 * Parse a core schema once with first-problem diagnostics for a short body, and no diagnostic for
 * a longer one. Legacy zod schemas retain their validation-first path for longer bodies.
 */
export function safeParseBounded<T>(
  schema: CheckingSchema<T>,
  value: unknown,
  /** How long the body was, in bytes or in UTF-16 code units: its structure is ASCII either way. */
  length: number,
): BoundedParse<T> {
  if (schema instanceof Schema) {
    const parsed = schema.safeParseFirst(value);
    return (parsed.success || length <= MAX_LISTED_BYTES ? parsed : UNLISTED) as BoundedParse<T>;
  }
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
