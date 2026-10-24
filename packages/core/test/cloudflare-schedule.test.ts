import { describe, expect, it } from 'vitest';

import { cloudflareCronExpressionError } from '../src/cron/cloudflare-expression.ts';
import { nextCloudflareFireAfterExpression } from '../src/cron/cloudflare-occurrence.ts';
import { cloudflareScheduleOf } from '../src/cron/cloudflare-schedule.ts';
import { CronExpressionError, nextFireAfterExpression } from '../src/cron/expression.ts';

/* eslint-disable unicorn/prefer-temporal -- The calculators take and give epoch milliseconds. */
/** Where each comparison starts: a week before a year's end, in no minute a schedule names. */
const FROM_MS = Date.parse('2027-12-25T10:17:00Z');
/** A year without the 29th of February, the day after which the next one is three years on. */
const YEAR_START_MS = Date.parse('2027-01-01T00:00:00Z');

function firings(
  next: (source: string, afterMs: number) => number | undefined,
  source: string,
  count: number,
): string[] {
  const out: string[] = [];
  let after = FROM_MS;
  while (out.length < count) {
    const at = next(source, after);
    if (at === undefined) {
      break;
    }
    out.push(new Date(at).toISOString());
    after = at;
  }
  return out;
}
/* eslint-enable unicorn/prefer-temporal */

describe('a schedule as a Cloudflare Cron Trigger', () => {
  it.each([
    ['* * * * *', '* * * * *'],
    ['*/15 * * * *', '0,15,30,45 * * * *'],
    ['0 9 * * 1', '0 9 * * 2'],
    ['0 9 * * 0', '0 9 * * 1'],
    ['0 9 * * 6', '0 9 * * 7'],
    ['0 9 * * 1-5', '0 9 * * 2-6'],
    ['30 18 * * 0,6', '30 18 * * 1,7'],
    ['0 0 * * 0-6', '0 0 * * *'],
    ['0 0 1 * *', '0 0 1 * *'],
    ['0 0 1-31 * *', '0 0 * * *'],
    ['0 6 15 1,4,7,10 *', '0 6 15 1,4,7,10 *'],
    ['5-10,20 0-2 * * *', '5-10,20 0-2 * * *'],
    ['0 */6 * * *', '0 0,6,12,18 * * *'],
    ['0 0 29 2 *', '0 0 29 2 *'],
    ['  0   0 * * *  ', '0 0 * * *'],
  ])('writes %j as %j', (schedule, trigger) => {
    expect(cloudflareScheduleOf(schedule)).toBe(trigger);
  });

  it('writes one trigger for two schedules that select the same minutes', () => {
    expect(cloudflareScheduleOf('0,30 * * * *')).toBe(cloudflareScheduleOf('*/30 * * * *'));
    expect(cloudflareScheduleOf('0 0 * * 1-5')).toBe(cloudflareScheduleOf('0 0 * * 1,2,3,4,5'));
  });

  it('refuses a schedule the dialect refuses, as the dialect does', () => {
    expect(() => cloudflareScheduleOf('0 0 * * MON')).toThrow(CronExpressionError);
    expect(() => cloudflareScheduleOf('0 0 1 * 1')).toThrow(CronExpressionError);
  });

  /**
   * What the translation is for: Cloudflare, reading the trigger, fires at every minute the
   * schedule names and no other — compared over firings that cross months, years, leap days and
   * every day of the week.
   */
  it.each([
    '* * * * *',
    '*/7 * * * *',
    '0 9 * * 1',
    '0 9 * * 0',
    '15 23 * * 6',
    '0 9 * * 1-5',
    '30 18 * * 0,6',
    '0 */5 * * 3',
    '0 0 1 * *',
    '0 12 31 * *',
    '59 23 28-31 * *',
    '0 6 15 1,4,7,10 *',
    '0 0 29 2 *',
    '0 0 * 2 0',
    '45 4 1-7 * *',
  ])('fires %j on Cloudflare when it fires here', (schedule) => {
    const trigger = cloudflareScheduleOf(schedule);
    const count = schedule.startsWith('*') ? 200 : 60;

    expect(cloudflareCronExpressionError(trigger)).toBeUndefined();
    expect(firings(nextCloudflareFireAfterExpression, trigger, count)).toStrictEqual(
      firings(nextFireAfterExpression, schedule, count),
    );
  });

  it('never fires on Cloudflare a schedule that never fires here', () => {
    const trigger = cloudflareScheduleOf('0 0 30 2 *');

    expect(nextFireAfterExpression('0 0 30 2 *', YEAR_START_MS)).toBeUndefined();
    expect(nextCloudflareFireAfterExpression(trigger, YEAR_START_MS)).toBeUndefined();
  });
});
