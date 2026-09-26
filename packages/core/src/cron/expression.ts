/**
 * Cron expressions, in the dialect Vercel's cron jobs accept.
 *
 * Five fields — minute, hour, day of month, month, day of week — in UTC, with no alternative
 * spellings (`MON`, `JAN`) and no `@daily` shortcuts, and with day of month and day of week
 * mutually exclusive: when one names days, the other must be `*`
 * (https://vercel.com/docs/cron-jobs#cron-expression-limitations, read 2026-09-23).
 *
 * That last rule is why this file can match every field with an `and`. Ordinary cron *ors* the two
 * day fields when both are restricted, which is a rule nobody remembers correctly; a dialect that
 * refuses the ambiguous expression never has to decide it. An expression accepted here therefore
 * means on Vercel and here the same thing, which is the whole point of reading one.
 *
 * The next firing is computed, not searched for minute by minute: a schedule that fires once a
 * year is as cheap to advance as one that fires every minute.
 */

const MINUTE_MS = 60_000;

/** Field bounds, in the order the fields are written. */
const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 6 },
] as const;

const MINUTE_FIELD = 0;
const HOUR_FIELD = 1;
const DAY_OF_MONTH_FIELD = 2;
const MONTH_FIELD = 3;
const DAY_OF_WEEK_FIELD = 4;

/**
 * How far ahead a next firing is looked for before the expression is called unsatisfiable.
 *
 * Nine years, because eight is the longest a satisfiable expression can wait: February the 29th
 * skips a century year that is not a leap year (2096 to 2104). Past that horizon the only
 * expressions left are the ones that name a day no month has — February the 30th, April the 31st —
 * and those never fire at all.
 */
const SEARCH_YEARS = 9;

/**
 * One parsed expression: the values each field allows, and whether the field was written `*`.
 *
 * `restricted` is kept because `*` and "every value spelled out" are the same set and not the same
 * expression: `0 0 * * 0-6` names days of the week, so it may not also name days of the month.
 */
export interface CronExpression {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
}

export class CronExpressionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CronExpressionError';
  }
}

function fail(source: string, detail: string): never {
  throw new CronExpressionError(`invalid cron expression ${JSON.stringify(source)}: ${detail}`);
}

/** A whole number written in decimal with no sign, no padding beyond zeros, and nothing else. */
function decimal(text: string): number | undefined {
  return /^\d{1,2}$/u.test(text) ? Number.parseInt(text, 10) : undefined;
}

interface FieldBounds {
  readonly name: string;
  readonly min: number;
  readonly max: number;
}

/** `a-b`, `a`, or `*` — the range a step is taken over. */
function rangeOf(
  source: string,
  field: FieldBounds,
  text: string,
): { from: number; to: number; wildcard: boolean } {
  if (text === '*') {
    return { from: field.min, to: field.max, wildcard: true };
  }
  const [fromText, toText, ...rest] = text.split('-');
  if (fromText === undefined || rest.length > 0) {
    fail(source, `${field.name}: ${JSON.stringify(text)} is not a value or a range`);
  }
  const from = decimal(fromText);
  if (from === undefined) {
    fail(source, `${field.name}: ${JSON.stringify(fromText)} is not a number`);
  }
  if (toText === undefined) {
    return { from, to: from, wildcard: false };
  }
  const to = decimal(toText);
  if (to === undefined) {
    fail(source, `${field.name}: ${JSON.stringify(toText)} is not a number`);
  }
  if (to < from) {
    fail(source, `${field.name}: the range ${from}-${to} ends before it begins`);
  }
  return { from, to, wildcard: false };
}

/** The step a term was written with; 1 when it names none. */
function stepOf(source: string, field: FieldBounds, stepText: string | undefined): number {
  if (stepText === undefined) {
    return 1;
  }
  const step = decimal(stepText);
  if (step === undefined || step === 0) {
    fail(source, `${field.name}: ${JSON.stringify(stepText)} is not a step`);
  }
  return step;
}

// One term of a field: `*`, `a`, `a-b`, `*/n`, `a-b/n`.
// (A line comment, not a doc comment: a step term would close a block comment at its slash.)
function parseTerm(
  source: string,
  field: FieldBounds,
  term: string,
): { values: number[]; restricted: boolean } {
  const [rangeText, stepText, ...rest] = term.split('/');
  if (rangeText === undefined || rangeText === '' || rest.length > 0) {
    fail(source, `${field.name}: ${JSON.stringify(term)} is not a term`);
  }
  const range = rangeOf(source, field, rangeText);
  const step = stepOf(source, field, stepText);
  if (range.from < field.min || range.to > field.max) {
    fail(source, `${field.name}: ${range.from}-${range.to} is outside ${field.min}-${field.max}`);
  }
  const values: number[] = [];
  for (let value = range.from; value <= range.to; value += step) {
    values.push(value);
  }
  // A step above 1 selects every other value rather than all of them, so it names values as
  // surely as a range does; a step of 1 over `*` is `*` written the long way.
  return { values, restricted: !range.wildcard || step > 1 };
}

/** One comma-separated field: the terms above, and lists of them. */
function parseField(
  source: string,
  field: FieldBounds,
  text: string,
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;
  for (const term of text.split(',')) {
    const parsed = parseTerm(source, field, term);
    for (const value of parsed.values) {
      values.add(value);
    }
    restricted ||= parsed.restricted;
  }
  return { values, restricted };
}

/**
 * Parse one expression, or throw `CronExpressionError` saying which field is wrong.
 *
 * Fields are separated by runs of spaces; a leading or trailing run is ignored, so an expression
 * copied out of a table with its padding still on is read as written rather than refused for it.
 */
export function parseCronExpression(source: string): CronExpression {
  if (!/^[\u{20}-\u{7E}]+$/u.test(source)) {
    // A tab or a newline between fields, or a non-ASCII digit that would parse as a number
    // somewhere and not here. Refused whole rather than read past.
    fail(source, 'expected printable ASCII with spaces between the fields');
  }
  const parts = source.split(' ').filter((part) => part !== '');
  if (parts.length !== FIELDS.length) {
    fail(source, `expected ${FIELDS.length} fields, found ${parts.length}`);
  }
  const parsed = FIELDS.map((field, index) => parseField(source, field, parts[index] ?? ''));
  const dayOfMonth = parsed[DAY_OF_MONTH_FIELD];
  const dayOfWeek = parsed[DAY_OF_WEEK_FIELD];
  if (dayOfMonth === undefined || dayOfWeek === undefined) {
    fail(source, 'the day fields are missing');
  }
  if (dayOfMonth.restricted && dayOfWeek.restricted) {
    fail(source, 'day of month and day of week cannot both name days; one of them must be "*"');
  }
  return {
    source,
    minutes: parsed[MINUTE_FIELD]?.values ?? new Set(),
    hours: parsed[HOUR_FIELD]?.values ?? new Set(),
    daysOfMonth: dayOfMonth.values,
    months: parsed[MONTH_FIELD]?.values ?? new Set(),
    daysOfWeek: dayOfWeek.values,
  };
}

/** Whether `source` is an expression this platform runs; the reason it is not, if it is not. */
export function cronExpressionError(source: string): string | undefined {
  try {
    parseCronExpression(source);
    return undefined;
  } catch (error) {
    return error instanceof CronExpressionError ? error.message : String(error);
  }
}

/**
 * Whether a day is one the expression fires on.
 *
 * Both fields are consulted with `and`, which is only correct because one of them is always `*`
 * (see the note at the top): the `*` field admits every day, so the restricted one decides.
 */
function dayMatches(expression: CronExpression, date: Date): boolean {
  return (
    expression.daysOfMonth.has(date.getUTCDate()) && expression.daysOfWeek.has(date.getUTCDay())
  );
}

/**
 * The first firing strictly after `afterMs`, in epoch milliseconds.
 *
 * Strictly after, so a schedule advanced from its own firing moves on rather than repeating it.
 * Seconds and milliseconds are dropped: cron has a minute's resolution, and a firing is the start
 * of its minute.
 *
 * `undefined` for an expression that names no day that exists — `0 0 30 2 *`, February the 30th —
 * which is the one shape that parses and can never fire.
 */
export function nextFireAfter(expression: CronExpression, afterMs: number): number | undefined {
  /* eslint-disable unicorn/prefer-temporal -- Temporal is not available in the Workers runtime. */
  const cursor = new Date(Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const limit = Date.UTC(cursor.getUTCFullYear() + SEARCH_YEARS, 0, 1);
  /* eslint-enable unicorn/prefer-temporal */
  while (cursor.getTime() < limit) {
    if (!expression.months.has(cursor.getUTCMonth() + 1)) {
      // Nothing this month fires: go to midnight on the first of the next one.
      cursor.setUTCFullYear(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(expression, cursor)) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      cursor.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!expression.hours.has(cursor.getUTCHours())) {
      cursor.setUTCHours(cursor.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!expression.minutes.has(cursor.getUTCMinutes())) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return cursor.getTime();
  }
  return undefined;
}

/** The same, from the expression's text; `undefined` for an expression that cannot fire. */
export function nextFireAfterExpression(source: string, afterMs: number): number | undefined {
  return nextFireAfter(parseCronExpression(source), afterMs);
}
