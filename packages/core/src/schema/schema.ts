import {
  type Check,
  type ParseContext,
  type Payload,
  type RefinementContext,
  runChecks,
} from './checks.ts';
import { SchemaError } from './error.ts';
import { finalizeIssue } from './issues.ts';
import { shallowClone } from './plain.ts';
import type { RawIssue } from './raw-issue.ts';
import type { NoUndefined, OptIn, OptOut, TypeMarks } from './types.ts';

const PARSE: ParseContext = { abortEarly: false };
const VALIDATE: ParseContext = { abortEarly: true };
const NO_CHECKS: readonly Check[] = Object.freeze([]);

/** What a refinement or a check is told besides its rule: a message, and for a refinement a path. */
export interface RefineParams {
  readonly message?: string | undefined;
  readonly path?: readonly PropertyKey[] | undefined;
}

/** A check's message, given as zod takes one: the string itself, or `{ message }`. */
export function messageOf(params: string | RefineParams | undefined): string | undefined {
  return typeof params === 'string' ? params : params?.message;
}

export type SafeParseResult<T> =
  | { success: true; data: T; error?: never }
  | { success: false; data?: never; error: SchemaError };

function failure(issues: readonly RawIssue[]): { success: false; error: SchemaError } {
  let error: SchemaError | undefined;
  return {
    success: false,
    // Built when first read: a caller that only asks whether it passed never pays for the report.
    get error(): SchemaError {
      error ??= new SchemaError(issues.map((issue) => finalizeIssue(issue)));
      return error;
    },
  };
}

/**
 * A schema: what it accepts, and what parsing it makes of a value.
 *
 * Built to cost nothing much to build. Every method lives on the prototype, and a schema is a
 * handful of fields — its checks as plain data, and what its kind needs — so that the hundreds a
 * module defines at its top level, evaluated before a Worker answers its first request, are each
 * one small allocation. A chained method returns a copy with one more check, as zod's do.
 */
export abstract class Schema<
  Out = unknown,
  In = unknown,
  I extends OptIn = OptIn,
  O extends OptOut = OptOut,
> {
  declare readonly '~types': TypeMarks<Out, In, I, O>;
  readonly checks: readonly Check[];
  /** Whether a key holding this schema may be absent from the input (`defaulted`: and is filled in). */
  readonly optin: OptIn;
  /** Whether a key holding this schema may be absent from the output. */
  readonly optout: OptOut;

  constructor(checks: readonly Check[] = NO_CHECKS, optin?: OptIn, optout?: OptOut) {
    this.checks = checks;
    this.optin = optin;
    this.optout = optout;
  }

  /** The schema's own type, before its checks. */
  abstract parseType(payload: Payload, ctx: ParseContext): Payload;

  /** The schema's type, then its checks. */
  run(payload: Payload, ctx: ParseContext): Payload {
    const result = this.parseType(payload, ctx);
    return this.checks.length === 0 ? result : runChecks(result, this.checks);
  }

  /** A copy of this schema with `checks` in place of its own. */
  protected withChecks(checks: readonly Check[]): this {
    const copy = Object.create(Object.getPrototypeOf(this) as Record<string, unknown>) as this;
    Object.assign(copy, this);
    (copy as { checks: readonly Check[] }).checks = checks;
    return copy;
  }

  /** A copy of this schema with one more check after the rest. */
  protected withCheck(check: Check): this {
    return this.withChecks([...this.checks, check]);
  }

  refine(fn: (value: Out) => unknown, params?: string | RefineParams): this {
    const options = typeof params === 'string' ? { message: params } : params;
    return this.withCheck({
      kind: 'refine',
      fn: fn as (value: unknown) => unknown,
      message: options?.message,
      path: options?.path,
    });
  }

  superRefine(fn: (value: Out, ctx: RefinementContext<Out>) => void): this {
    return this.withCheck({
      kind: 'super_refine',
      fn: fn as (value: unknown, ctx: RefinementContext) => unknown,
    });
  }

  optional(): Schema<
    Out | undefined,
    In | undefined,
    I extends 'defaulted' ? 'defaulted' : 'optional',
    'optional'
  > {
    return wrap('optional', this) as Schema<
      Out | undefined,
      In | undefined,
      I extends 'defaulted' ? 'defaulted' : 'optional',
      'optional'
    >;
  }

  nullable(): Schema<Out | null, In | null, I, O> {
    return wrap('nullable', this) as Schema<Out | null, In | null, I, O>;
  }

  nullish(): Schema<
    Out | null | undefined,
    In | null | undefined,
    I extends 'defaulted' ? 'defaulted' : 'optional',
    'optional'
  > {
    return wrap('optional', wrap('nullable', this)) as Schema<
      Out | null | undefined,
      In | null | undefined,
      I extends 'defaulted' ? 'defaulted' : 'optional',
      'optional'
    >;
  }

  default(
    value: NoUndefined<Out> | (() => NoUndefined<Out>),
  ): Schema<NoUndefined<Out>, In | undefined, 'defaulted', undefined> {
    return wrap('default', this, value) as Schema<
      NoUndefined<Out>,
      In | undefined,
      'defaulted',
      undefined
    >;
  }

  parse(value: unknown): Out {
    const result = this.run({ value, issues: [] }, PARSE);
    if (result.issues.length > 0) {
      throw new SchemaError(result.issues.map((issue) => finalizeIssue(issue)));
    }
    return result.value as Out;
  }

  safeParse(value: unknown): SafeParseResult<Out> {
    const result = this.run({ value, issues: [] }, PARSE);
    return result.issues.length === 0
      ? { success: true, data: result.value as Out }
      : failure(result.issues);
  }

  /**
   * Whether `value` parses, found as cheaply as that can be: an object, a record or a list stops at
   * its first member that fails outright, and no issue is reported. What does not fail outright is
   * still gone through, as `safeParse` goes through it: a string too short, a pattern not matched,
   * every key a strict object does not know. The answer is always `safeParse`'s.
   */
  validate(value: unknown): value is In {
    return this.run({ value, issues: [] }, VALIDATE).issues.length === 0;
  }
}

type Wrapping = 'default' | 'nullable' | 'optional';

function optinOf(wrapping: Wrapping, inner: Schema): OptIn {
  if (wrapping === 'default') {
    return 'defaulted';
  }
  if (wrapping === 'nullable') {
    return inner.optin;
  }
  return inner.optin === 'defaulted' ? 'defaulted' : 'optional';
}

function optoutOf(wrapping: Wrapping, inner: Schema): OptOut {
  if (wrapping === 'default') {
    return undefined;
  }
  return wrapping === 'nullable' ? inner.optout : 'optional';
}

/** `optional()`, `nullable()` and `default()`: a schema around another, answering one value itself. */
export class WrapperSchema<
  Out = unknown,
  In = unknown,
  I extends OptIn = OptIn,
  O extends OptOut = OptOut,
> extends Schema<Out, In, I, O> {
  readonly wrapping: Wrapping;
  readonly inner: Schema;
  /** A default's value, or the function that makes one. */
  readonly fallback: unknown;

  constructor(wrapping: Wrapping, inner: Schema, fallback?: unknown) {
    super(NO_CHECKS, optinOf(wrapping, inner), optoutOf(wrapping, inner));
    this.wrapping = wrapping;
    this.inner = inner;
    this.fallback = fallback;
  }

  /** A default as this parse receives it: made anew by its function, or a fresh copy of it. */
  defaultValue(): unknown {
    const fallback = this.fallback;
    return typeof fallback === 'function' ? (fallback as () => unknown)() : shallowClone(fallback);
  }

  parseType(payload: Payload, ctx: ParseContext): Payload {
    if (this.wrapping === 'nullable') {
      return payload.value === null ? payload : this.inner.run(payload, ctx);
    }
    if (this.wrapping === 'default') {
      if (payload.value === undefined) {
        // Not parsed: a default is the schema's own, and zod hands it over as it is.
        payload.value = this.defaultValue();
        return payload;
      }
      const result = this.inner.run(payload, ctx);
      if (result.value === undefined) {
        result.value = this.defaultValue();
      }
      return result;
    }
    if (payload.value !== undefined) {
      return this.inner.run(payload, ctx);
    }
    if (this.inner.optin !== 'defaulted') {
      return payload;
    }
    // An absent value under a default: the default, or nothing where even that fails.
    const result = this.inner.run({ value: undefined, issues: [] }, ctx);
    payload.value = result.issues.length > 0 ? undefined : result.value;
    return payload;
  }
}

/** A schema around `inner`, for the methods above: declared after the class it builds. */
function wrap(wrapping: Wrapping, inner: Schema, fallback?: unknown): Schema {
  return new WrapperSchema(wrapping, inner, fallback);
}
