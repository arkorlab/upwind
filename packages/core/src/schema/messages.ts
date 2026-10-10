import type { RawIssue } from './raw-issue.ts';
import type { Primitive } from './types.ts';

/**
 * The English message of an issue, word for word what zod 4's English locale says for the same
 * issue: parsed results are compared by their messages too, and an error's message is its issues'
 * JSON.
 */

/** What a length-carrying origin is counted in. */
const SIZED_UNITS: Readonly<Record<string, string>> = {
  string: 'characters',
  file: 'bytes',
  array: 'items',
  set: 'items',
  map: 'entries',
};

/** What an `invalid_format` issue calls a format it names. */
const FORMAT_NAMES: Readonly<Record<string, string>> = {
  regex: 'input',
  url: 'URL',
  datetime: 'ISO datetime',
  template_literal: 'input',
};

/** The type of a value as an issue names it. */
export function parsedType(value: unknown): string {
  const type = typeof value;
  if (type === 'number') {
    return Number.isNaN(value) ? 'nan' : 'number';
  }
  if (type === 'object') {
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    const object = value as { readonly constructor?: unknown };
    if (
      Object.getPrototypeOf(object) !== Object.prototype &&
      'constructor' in object &&
      typeof object.constructor === 'function'
    ) {
      return (object.constructor as { readonly name: string }).name;
    }
  }
  return type;
}

function typeName(type: unknown, input?: unknown): string {
  if (type === 'number' && typeof input === 'number' && !Number.isFinite(input)) {
    return String(input);
  }
  return type === 'nan' ? 'NaN' : String(type);
}

/** A value as a message quotes it. */
export function stringifyPrimitive(value: unknown): string {
  if (typeof value === 'bigint') {
    return `${value.toString()}n`;
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  return String(value);
}

function joinValues(values: readonly unknown[], separator: string): string {
  return values.map((value) => stringifyPrimitive(value)).join(separator);
}

/** How a bound is compared: `exactly `, or `<=`/`<` (too big) and `>=`/`>` (too small). */
function comparison(issue: RawIssue, big: boolean): string {
  if (issue['exact'] === true) {
    return 'exactly ';
  }
  const inclusive = issue['inclusive'] === true;
  if (big) {
    return inclusive ? '<=' : '<';
  }
  return inclusive ? '>=' : '>';
}

function sizeMessage(issue: RawIssue, big: boolean): string {
  const adjective = comparison(issue, big);
  const bound = String(big ? issue['maximum'] : issue['minimum']);
  const origin = typeof issue['origin'] === 'string' ? issue['origin'] : undefined;
  const unit =
    origin !== undefined && Object.hasOwn(SIZED_UNITS, origin) ? SIZED_UNITS[origin] : undefined;
  const lead = big ? 'Too big' : 'Too small';
  // zod names a missing origin `value` when the bound is a maximum, and leaves it as is otherwise.
  const named = big ? (origin ?? 'value') : String(origin);
  return unit === undefined
    ? `${lead}: expected ${named} to be ${adjective}${bound}`
    : `${lead}: expected ${named} to have ${adjective}${bound} ${unit}`;
}

function formatMessage(issue: RawIssue): string {
  const format = issue['format'];
  if (format === 'starts_with') {
    return `Invalid string: must start with "${String(issue['prefix'])}"`;
  }
  if (format === 'regex') {
    return `Invalid string: must match pattern ${String(issue['pattern'])}`;
  }
  const named =
    typeof format === 'string' && Object.hasOwn(FORMAT_NAMES, format)
      ? FORMAT_NAMES[format]
      : undefined;
  return `Invalid ${named ?? String(format)}`;
}

function unionMessage(issue: RawIssue): string {
  const options: unknown = issue['options'];
  if (Array.isArray(options) && options.length > 0) {
    const expected = (options as readonly unknown[])
      .map((option) => `'${String(option as Primitive)}'`)
      .join(' | ');
    return `Invalid discriminator value. Expected ${expected}`;
  }
  return 'Invalid input';
}

export function localeMessage(issue: RawIssue): string {
  switch (issue.code) {
    case 'invalid_type': {
      const received = typeName(parsedType(issue.input), issue.input);
      return `Invalid input: expected ${typeName(issue['expected'])}, received ${received}`;
    }
    case 'invalid_value': {
      const values = issue['values'] as readonly unknown[];
      return values.length === 1
        ? `Invalid input: expected ${stringifyPrimitive(values[0])}`
        : `Invalid option: expected one of ${joinValues(values, '|')}`;
    }
    case 'too_big': {
      return sizeMessage(issue, true);
    }
    case 'too_small': {
      return sizeMessage(issue, false);
    }
    case 'invalid_format': {
      return formatMessage(issue);
    }
    case 'unrecognized_keys': {
      const keys = issue['keys'] as readonly unknown[];
      return `Unrecognized key${keys.length > 1 ? 's' : ''}: ${joinValues(keys, ', ')}`;
    }
    case 'invalid_key': {
      return `Invalid key in ${String(issue['origin'])}`;
    }
    case 'invalid_union': {
      return unionMessage(issue);
    }
    default: {
      return 'Invalid input';
    }
  }
}
