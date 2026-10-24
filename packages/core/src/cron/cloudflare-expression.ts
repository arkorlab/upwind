/**
 * Cloudflare's five-field UTC dialect, kept separate from Vercel's HTTP cron dialect.
 * Grammar checked against Cloudflare's Saffron parser on 2026-10-24:
 * https://github.com/cloudflare/saffron/blob/master/saffron/src/parse.rs
 */

interface Field {
  readonly name: string;
  readonly min: number;
  readonly max: number;
  readonly names?: readonly string[];
}

const MINUTES: Field = { name: 'minute', min: 0, max: 59 };
const HOURS: Field = { name: 'hour', min: 0, max: 23 };
const DAYS: Field = { name: 'day of month', min: 1, max: 31 };
const MONTHS: Field = {
  name: 'month',
  min: 1,
  max: 12,
  names: ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
};
const WEEKDAYS: Field = {
  name: 'day of week',
  min: 1,
  max: 7,
  names: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
};
const FIELD_COUNT = 5;
const MAX_LAST_OFFSET = 30;
const MAX_NTH = 5;

type DayPattern =
  | { readonly kind: 'all' }
  | { readonly kind: 'values'; readonly values: ReadonlySet<number> };

export type CloudflareMonthDays =
  | DayPattern
  | { readonly kind: 'last'; readonly offset: number; readonly weekday: boolean }
  | { readonly kind: 'weekday'; readonly day: number };

export type CloudflareWeekDays =
  | DayPattern
  | { readonly kind: 'last'; readonly day: number }
  | { readonly kind: 'nth'; readonly day: number; readonly nth: number };

export interface CloudflareCronExpression {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfMonth: CloudflareMonthDays;
  /** Cloudflare numbers Sunday through Saturday as 1 through 7. */
  readonly daysOfWeek: CloudflareWeekDays;
}

export class CloudflareCronExpressionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CloudflareCronExpressionError';
  }
}

function fail(source: string, detail: string): never {
  throw new CloudflareCronExpressionError(
    `invalid Cloudflare cron expression ${JSON.stringify(source)}: ${detail}`,
  );
}

function boundedNumber(text: string, min: number, max: number): number | undefined {
  if (!/^\d+$/u.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function valueOf(source: string, field: Field, text: string): number {
  const numeric = boundedNumber(text, field.min, field.max);
  if (numeric !== undefined) return numeric;
  const named = field.names?.indexOf(text.toUpperCase());
  if (named !== undefined && named >= 0) return named + field.min;
  return fail(
    source,
    `${field.name}: ${JSON.stringify(text)} is outside ${field.min}-${field.max}`,
  );
}

/** One inclusive circular range. A step keeps its position across the field's rollover. */
function addRange(
  values: Set<number>,
  field: Field,
  range: readonly [number, number, number],
): void {
  const [start, end, step] = range;
  const width = field.max - field.min + 1;
  const distance = end >= start ? end - start : width - start + end;
  for (let offset = 0; offset <= distance; offset += step) {
    values.add(((start - field.min + offset) % width) + field.min);
  }
}

function addTerm(source: string, field: Field, term: string, values: Set<number>): void {
  const match = /^(\*|\d+|[A-Za-z]+)(?:-(\d+|[A-Za-z]+))?(?:\/(\d+))?$/u.exec(term);
  if (match === null) fail(source, `${field.name}: ${JSON.stringify(term)} is not a term`);
  const start = match[1] === '*' ? field.min : valueOf(source, field, match[1] ?? '');
  const endText = match[2];
  const stepText = match[3];
  const implicitEnd = stepText === undefined ? start : field.max;
  const end = endText === undefined ? implicitEnd : valueOf(source, field, endText);
  const step = stepText === undefined ? 1 : boundedNumber(stepText, 1, field.max - field.min);
  if (step === undefined) fail(source, `${field.name}: ${JSON.stringify(stepText)} is not a step`);
  addRange(values, field, [start, end, step]);
}

/** Saffron treats a bare first star as the whole field; stars in list tails are ordinary terms. */
function fieldValues(source: string, field: Field, text: string): ReadonlySet<number> {
  const values = new Set<number>();
  if (text === '*') {
    addRange(values, field, [field.min, field.max, 1]);
    return values;
  }
  if (text.startsWith('*') && !text.startsWith('*/')) {
    fail(source, `${field.name}: a bare "*" must occupy the whole field`);
  }
  for (const term of text.split(',')) addTerm(source, field, term, values);
  return values;
}

function monthDays(source: string, text: string): CloudflareMonthDays {
  if (text === '*') return { kind: 'all' };
  const last = /^L(?:-(\d+))?(W)?$/u.exec(text);
  if (last !== null) {
    const offset = last[1] === undefined ? 0 : boundedNumber(last[1], 1, MAX_LAST_OFFSET);
    if (offset === undefined) fail(source, 'day of month: last-day offset must be 1-30');
    return { kind: 'last', offset, weekday: last[2] === 'W' };
  }
  const weekday = /^(\d+)W$/u.exec(text);
  if (weekday !== null) {
    return { kind: 'weekday', day: valueOf(source, DAYS, weekday[1] ?? '') };
  }
  return { kind: 'values', values: fieldValues(source, DAYS, text) };
}

function weekDays(source: string, text: string): CloudflareWeekDays {
  if (text === '*') return { kind: 'all' };
  if (text === 'L') return { kind: 'values', values: new Set([WEEKDAYS.max]) };
  const last = /^(\d+|[A-Za-z]{3})L$/u.exec(text);
  if (last !== null) return { kind: 'last', day: valueOf(source, WEEKDAYS, last[1] ?? '') };
  const nthMatch = /^(\d+|[A-Za-z]{3})#(\d+)$/u.exec(text);
  if (nthMatch !== null) {
    const nth = boundedNumber(nthMatch[2] ?? '', 1, MAX_NTH);
    if (nth === undefined) fail(source, 'day of week: occurrence must be 1-5');
    return { kind: 'nth', day: valueOf(source, WEEKDAYS, nthMatch[1] ?? ''), nth };
  }
  return { kind: 'values', values: fieldValues(source, WEEKDAYS, text) };
}

/** Parse without rewriting the expression: scheduled handlers receive exactly what was declared. */
export function parseCloudflareCronExpression(source: string): CloudflareCronExpression {
  if (!/^[\u{21}-\u{7E}]+(?:[\t ]+[\u{21}-\u{7E}]+){4}$/u.test(source)) {
    fail(source, `expected ${FIELD_COUNT} fields separated by spaces or tabs`);
  }
  const parts = source.split(/[\t ]+/u);
  return {
    source,
    minutes: fieldValues(source, MINUTES, parts[0] ?? ''),
    hours: fieldValues(source, HOURS, parts[1] ?? ''),
    daysOfMonth: monthDays(source, parts[2] ?? ''),
    months: fieldValues(source, MONTHS, parts[3] ?? ''),
    daysOfWeek: weekDays(source, parts[4] ?? ''),
  };
}

export function cloudflareCronExpressionError(source: string): string | undefined {
  try {
    parseCloudflareCronExpression(source);
    return undefined;
  } catch (error) {
    return error instanceof CloudflareCronExpressionError ? error.message : String(error);
  }
}
