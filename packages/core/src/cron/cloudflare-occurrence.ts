import {
  type CloudflareCronExpression,
  type CloudflareMonthDays,
  type CloudflareWeekDays,
  parseCloudflareCronExpression,
} from './cloudflare-expression.ts';

const MINUTE_MS = 60_000;
const MONTHS_PER_YEAR = 12;
const DAYS_PER_WEEK = 7;
const SATURDAY = 6;
/** Every Gregorian month/day/weekday combination repeats within this many years. */
const SEARCH_YEARS = 400;

/* eslint-disable unicorn/prefer-temporal -- Temporal is not available in the Workers runtime. */
function dateAt(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  return date;
}
/* eslint-enable unicorn/prefer-temporal */

function nearestWeekday(
  year: number,
  month: number,
  day: number,
  last: number,
): number | undefined {
  if (day < 1 || day > last) return undefined;
  const weekday = dateAt(year, month, day).getUTCDay();
  if (weekday === SATURDAY) return day === 1 ? day + 2 : day - 1;
  if (weekday === 0) return day === last ? day - 2 : day + 1;
  return day;
}

function monthDayMatches(pattern: CloudflareMonthDays, date: Date, last: number): boolean {
  const day = date.getUTCDate();
  switch (pattern.kind) {
    case 'all': {
      return true;
    }
    case 'values': {
      return pattern.values.has(day);
    }
    case 'weekday': {
      return day === nearestWeekday(date.getUTCFullYear(), date.getUTCMonth(), pattern.day, last);
    }
    case 'last': {
      const target = last - pattern.offset;
      return (
        day ===
        (pattern.weekday
          ? nearestWeekday(date.getUTCFullYear(), date.getUTCMonth(), target, last)
          : target)
      );
    }
  }
}

function weekDayMatches(pattern: CloudflareWeekDays, date: Date, last: number): boolean {
  const weekday = date.getUTCDay() + 1;
  switch (pattern.kind) {
    case 'all': {
      return true;
    }
    case 'values': {
      return pattern.values.has(weekday);
    }
    case 'last': {
      return weekday === pattern.day && date.getUTCDate() + DAYS_PER_WEEK > last;
    }
    case 'nth': {
      return (
        weekday === pattern.day && Math.ceil(date.getUTCDate() / DAYS_PER_WEEK) === pattern.nth
      );
    }
  }
}

/** Saffron ORs restricted day fields; only a literal star removes that field's restriction. */
function dayMatches(expression: CloudflareCronExpression, date: Date, last: number): boolean {
  const dom = monthDayMatches(expression.daysOfMonth, date, last);
  const dow = weekDayMatches(expression.daysOfWeek, date, last);
  if (expression.daysOfMonth.kind === 'all') return dow;
  if (expression.daysOfWeek.kind === 'all') return dom;
  return dom || dow;
}

function timeOnDay(
  expression: CloudflareCronExpression,
  date: Date,
  earliest: number,
): number | undefined {
  for (const hour of expression.hours) {
    for (const minute of expression.minutes) {
      date.setUTCHours(hour, minute, 0, 0);
      if (date.getTime() >= earliest) return date.getTime();
    }
  }
  return undefined;
}

function timeInMonth(
  expression: CloudflareCronExpression,
  date: Date,
  firstDay: number,
  earliest: number,
): number | undefined {
  const last = dateAt(date.getUTCFullYear(), date.getUTCMonth() + 1, 0).getUTCDate();
  for (let day = firstDay; day <= last; day++) {
    date.setUTCDate(day);
    if (!dayMatches(expression, date, last)) continue;
    const next = timeOnDay(expression, date, earliest);
    if (next !== undefined) return next;
  }
  return undefined;
}

/** Strictly after the timestamp; finite month/day jumps, never a minute-by-minute scan. */
export function nextCloudflareFireAfter(
  expression: CloudflareCronExpression,
  afterMs: number,
): number | undefined {
  const earliest = Math.floor(afterMs / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  if (!Number.isFinite(earliest)) return undefined;
  /* eslint-disable unicorn/prefer-temporal -- Temporal is not available in the Workers runtime. */
  const start = new Date(earliest);
  /* eslint-enable unicorn/prefer-temporal */
  const firstYear = start.getUTCFullYear();
  const firstMonth = start.getUTCMonth();
  // Lists may be written out of order. Searching their sorted values also avoids scanning hours.
  const sorted = {
    ...expression,
    hours: new Set([...expression.hours].toSorted((a, b) => a - b)),
    minutes: new Set([...expression.minutes].toSorted((a, b) => a - b)),
  };
  const maxMonths = SEARCH_YEARS * MONTHS_PER_YEAR;
  for (let offset = 0; offset <= maxMonths; offset++) {
    const date = dateAt(firstYear, firstMonth + offset, 1);
    if (!Number.isFinite(date.getTime())) return undefined;
    if (!expression.months.has(date.getUTCMonth() + 1)) continue;
    const firstDay = offset === 0 ? start.getUTCDate() : 1;
    const next = timeInMonth(sorted, date, firstDay, earliest);
    if (next !== undefined) return next;
  }
  return undefined;
}

export function nextCloudflareFireAfterExpression(
  source: string,
  afterMs: number,
): number | undefined {
  return nextCloudflareFireAfter(parseCloudflareCronExpression(source), afterMs);
}
