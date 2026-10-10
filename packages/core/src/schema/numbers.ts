import type { Payload } from './checks.ts';
import type { RawIssue } from './raw-issue.ts';
import { messageOf, type RefineParams, Schema } from './schema.ts';

/** How a non-finite number is named when it is refused. */
function receivedOf(input: unknown): string | undefined {
  if (typeof input !== 'number') {
    return undefined;
  }
  return Number.isNaN(input) ? 'NaN' : String(input);
}

/** A finite number: `NaN` and the infinities are refused, as zod refuses them. */
export class NumberSchema<In = number> extends Schema<number, In, undefined, undefined> {
  /** Whether the value is made a number (`Number(value)`) before it is checked. */
  readonly coerce: boolean;

  constructor(coerce = false) {
    super();
    this.coerce = coerce;
  }

  parseType(payload: Payload): Payload {
    if (this.coerce) {
      try {
        payload.value = Number(payload.value);
      } catch {
        // A value `Number` throws on — a symbol — is checked as it is, and refused.
      }
    }
    const input = payload.value;
    if (typeof input === 'number' && Number.isFinite(input)) {
      return payload;
    }
    const issue: RawIssue = { expected: 'number', code: 'invalid_type', input };
    const received = receivedOf(input);
    if (received !== undefined) {
      issue['received'] = received;
    }
    payload.issues.push(issue);
    return payload;
  }

  /** At least `minimum`. */
  min(minimum: number, params?: string | RefineParams): this {
    return this.withCheck({
      kind: 'greater_than',
      value: minimum,
      inclusive: true,
      message: messageOf(params),
    });
  }

  /** At most `maximum`. */
  max(maximum: number, params?: string | RefineParams): this {
    return this.withCheck({
      kind: 'less_than',
      value: maximum,
      inclusive: true,
      message: messageOf(params),
    });
  }

  /** More than `bound`. */
  gt(bound: number, params?: string | RefineParams): this {
    return this.withCheck({
      kind: 'greater_than',
      value: bound,
      inclusive: false,
      message: messageOf(params),
    });
  }

  /** At most `bound`. */
  lte(bound: number, params?: string | RefineParams): this {
    return this.max(bound, params);
  }

  /** More than zero (`-0` is not). */
  positive(params?: string | RefineParams): this {
    return this.gt(0, params);
  }

  /** Zero or more (`-0` is). */
  nonnegative(params?: string | RefineParams): this {
    return this.min(0, params);
  }

  /** A safe integer: an integer, and within ±(2^53 − 1). */
  int(params?: string | RefineParams): this {
    return this.withCheck({ kind: 'safe_int', message: messageOf(params) });
  }
}

export function number(): NumberSchema {
  return new NumberSchema();
}

/** A number made of whatever was given (`Number(value)`), then checked as `number()` checks one. */
export function coerceNumber(): NumberSchema<unknown> {
  return new NumberSchema<unknown>(true);
}
