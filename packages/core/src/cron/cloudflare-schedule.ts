import { parseCronExpression } from './expression.ts';

/**
 * A cron job's schedule, written as a Cloudflare Cron Trigger that fires when it does.
 *
 * A schedule is read in Vercel's dialect (`expression.ts`) and cannot be given to Cloudflare as
 * written, for one reason: Cloudflare numbers the days of the week 1 to 7 from Sunday, where
 * Vercel's dialect numbers them 0 to 6 (https://developers.cloudflare.com/workers/configuration/cron-triggers/,
 * read 2026-10-24) — `0 9 * * 1` is a Monday there and a Sunday on Cloudflare. Everything else of
 * the dialect means the same on both: five fields in UTC, and day of month and day of week never
 * both naming days, so Cloudflare's rule for when both do never applies.
 *
 * So the trigger is written from what the schedule selects rather than from its text: each field
 * that selects every value as `*`, any other as the values it selects, runs of them as ranges, the
 * days of the week moved up by one. Two schedules that select the same minutes are one trigger,
 * however each was written.
 */

/** How far Cloudflare's numbering of the days of the week is from the dialect's. */
const WEEKDAY_OFFSET = 1;

interface Field {
  readonly values: ReadonlySet<number>;
  readonly min: number;
  readonly max: number;
  /** What each value is moved by, as Cloudflare numbers it. */
  readonly offset: number;
}

/** One field: `*` where it selects every value, otherwise its values, a run of them as a range. */
function fieldOf({ values, min, max, offset }: Field): string {
  if (values.size === max - min + 1) {
    return '*';
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const value of sorted) {
    const last = runs.at(-1);
    if (last !== undefined && value === last[1] + 1) {
      last[1] = value;
    } else {
      runs.push([value, value]);
    }
  }
  return runs
    .map(([from, to]) => (from === to ? String(from + offset) : `${from + offset}-${to + offset}`))
    .join(',');
}

/**
 * The Cloudflare Cron Trigger that fires when `schedule` does. Throws `CronExpressionError` for a
 * schedule the dialect refuses, as `parseCronExpression` does.
 */
export function cloudflareScheduleOf(schedule: string): string {
  const expression = parseCronExpression(schedule);
  const fields: readonly Field[] = [
    { values: expression.minutes, min: 0, max: 59, offset: 0 },
    { values: expression.hours, min: 0, max: 23, offset: 0 },
    { values: expression.daysOfMonth, min: 1, max: 31, offset: 0 },
    { values: expression.months, min: 1, max: 12, offset: 0 },
    { values: expression.daysOfWeek, min: 0, max: 6, offset: WEEKDAY_OFFSET },
  ];
  return fields.map((field) => fieldOf(field)).join(' ');
}
