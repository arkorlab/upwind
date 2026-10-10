import type { Check, Payload } from './checks.ts';
import { messageOf, type RefineParams, Schema } from './schema.ts';
import type { Primitive, TemplateOutput } from './types.ts';

export class StringSchema extends Schema<string, string, undefined, undefined> {
  parseType(payload: Payload): Payload {
    if (typeof payload.value !== 'string') {
      payload.issues.push({ expected: 'string', code: 'invalid_type', input: payload.value });
    }
    return payload;
  }

  /** At least `minimum` characters, counted as code points. */
  min(minimum: number, params?: string | RefineParams): this {
    return this.withCheck({ kind: 'min_length', value: minimum, message: messageOf(params) });
  }

  /** At most `maximum` characters, counted as code points. */
  max(maximum: number, params?: string | RefineParams): this {
    return this.withCheck({ kind: 'max_length', value: maximum, message: messageOf(params) });
  }

  /** Exactly `length` characters, counted as code points. */
  length(length: number, params?: string | RefineParams): this {
    return this.withCheck({ kind: 'length_equals', value: length, message: messageOf(params) });
  }

  startsWith(prefix: string, params?: string | RefineParams): this {
    return this.withCheck({ kind: 'starts_with', prefix, message: messageOf(params) });
  }

  regex(pattern: RegExp, params?: string | RefineParams): this {
    return this.withCheck({ kind: 'regex', pattern, message: messageOf(params) });
  }

  /** The value with its surrounding whitespace removed, for the checks after this and the output. */
  trim(): this {
    return this.withCheck({ kind: 'trim' });
  }
}

const URL_CHECKS: readonly Check[] = Object.freeze([{ kind: 'url' }]);
const DATETIME_CHECKS: readonly Check[] = Object.freeze([{ kind: 'datetime' }]);

export function string(): StringSchema {
  return new StringSchema();
}

/** Anything the URL parser takes, trimmed, with tabs and newlines removed from what is returned. */
export function url(): StringSchema {
  return new StringSchema(URL_CHECKS);
}

/** A date and time in UTC — `2026-10-10T08:20:02Z`, seconds required, any fraction of them. */
export function datetime(): StringSchema {
  return new StringSchema(DATETIME_CHECKS);
}

/** One part of a template literal: text written as is, or a string schema without checks. */
export type TemplatePart = Exclude<Primitive, undefined> | StringSchema;

/** Characters a regular expression would read as syntax rather than as themselves. */
const REGEX_SYNTAX = /[$()*+.?[\\\]^{|}]/gu;

function patternOf(parts: readonly TemplatePart[]): RegExp {
  const sources = parts.map((part) => {
    if (part instanceof StringSchema) {
      if (part.checks.length > 0) {
        throw new Error('A template literal part must be a string schema without checks');
      }
      return String.raw`[\s\S]{0,}`;
    }
    return String(part).replaceAll(REGEX_SYNTAX, String.raw`\$&`);
  });
  // eslint-disable-next-line security/detect-non-literal-regexp -- the parts are escaped text and a fixed class.
  return new RegExp(`^${sources.join('')}$`, 'u');
}

/** A string matching text and strings in the order given, as zod's `templateLiteral` reads one. */
export class TemplateLiteralSchema<Out extends string = string> extends Schema<
  Out,
  Out,
  undefined,
  undefined
> {
  /** The parts as they were given, for a reader that rebuilds the schema elsewhere. */
  readonly parts: readonly TemplatePart[];
  readonly pattern: RegExp;

  constructor(parts: readonly TemplatePart[]) {
    super();
    this.parts = [...parts];
    this.pattern = patternOf(parts);
  }

  parseType(payload: Payload): Payload {
    const input = payload.value;
    if (typeof input !== 'string') {
      payload.issues.push({ input, expected: 'string', code: 'invalid_type' });
      return payload;
    }
    this.pattern.lastIndex = 0;
    if (!this.pattern.test(input)) {
      payload.issues.push({
        input,
        code: 'invalid_format',
        format: 'template_literal',
        pattern: this.pattern.source,
      });
    }
    return payload;
  }
}

export function templateLiteral<const Parts extends readonly TemplatePart[]>(
  parts: Parts,
): TemplateLiteralSchema<string & TemplateOutput<Parts>> {
  return new TemplateLiteralSchema(parts);
}
