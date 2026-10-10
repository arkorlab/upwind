/**
 * A validator with zod 4's API, as much of it as this package's schemas use, and nothing more:
 * `import * as z from '@stayingupwind/core/schema'` reads as `import * as z from 'zod'` does,
 * and what a schema accepts, what it returns and how it says what was wrong are zod's.
 *
 * Why not zod itself: a host evaluates every schema a module defines before it answers its first
 * request, and zod's are expensive to build and to load — the classes, the locales, the
 * converters. Here a schema is a few fields on a prototype that already has every method, and the
 * whole of it is a few kilobytes.
 */
import { coerceNumber } from './numbers.ts';
import { datetime } from './strings.ts';

export { array, ArraySchema, record, RecordSchema } from './collections.ts';
export { SchemaError } from './error.ts';
export { NumberSchema, number } from './numbers.ts';
export { looseObject, object, ObjectSchema, strictObject } from './object.ts';
export type { Issue } from './raw-issue.ts';
export { type RefineParams, type SafeParseResult, Schema, WrapperSchema } from './schema.ts';
export type { RefinementContext, RefinementIssue } from './checks.ts';
export {
  string,
  StringSchema,
  templateLiteral,
  TemplateLiteralSchema,
  type TemplatePart,
  url,
} from './strings.ts';
export type {
  Input as input,
  Output as infer,
  Output as output,
  Primitive,
  Shape,
  UnknownKeys,
} from './types.ts';
export { DiscriminatedUnionSchema, discriminatedUnion, union, UnionSchema } from './unions.ts';
export {
  boolean,
  EnumSchema,
  enumOf as enum,
  literal,
  nullValue as null,
  unknown,
  ValueSchema,
} from './values.ts';

/** `z.iso.datetime()`: an ISO 8601 date and time in UTC, seconds required. */
export const iso = { datetime } as const;

/** `z.coerce.number()`: `Number(value)`, then checked as a number. */
export const coerce = { number: coerceNumber } as const;
