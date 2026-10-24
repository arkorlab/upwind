import { describe, expect, it } from 'vitest';

import {
  cronExpressionError,
  nextFireAfterExpression,
  parseCronExpression,
} from '../src/cron/expression.ts';

/* eslint-disable unicorn/prefer-temporal -- Temporal is not available in the Workers runtime. */
/** Every time in this file is UTC, which is the only zone a cron expression is read in. */
function at(iso: string): number {
  return Date.parse(iso);
}

function nextFrom(schedule: string, iso: string): string | undefined {
  const next = nextFireAfterExpression(schedule, at(iso));
  return next === undefined ? undefined : new Date(next).toISOString();
}
/* eslint-enable unicorn/prefer-temporal */

describe('parseCronExpression', () => {
  it('reads the fields Vercel documents', () => {
    const expression = parseCronExpression('5 8 * * *');

    expect([...expression.minutes]).toStrictEqual([5]);
    expect([...expression.hours]).toStrictEqual([8]);
    expect(expression.daysOfMonth.size).toBe(31);
    expect(expression.months.size).toBe(12);
    expect(expression.daysOfWeek.size).toBe(7);
  });

  it('reads lists, ranges and steps', () => {
    expect([...parseCronExpression('0,30 * * * *').minutes]).toStrictEqual([0, 30]);
    expect([...parseCronExpression('*/15 * * * *').minutes]).toStrictEqual([0, 15, 30, 45]);
    expect([...parseCronExpression('0 9-17 * * *').hours]).toStrictEqual([
      9, 10, 11, 12, 13, 14, 15, 16, 17,
    ]);
    expect([...parseCronExpression('0 0-12/6 * * *').hours]).toStrictEqual([0, 6, 12]);
    expect([...parseCronExpression('0 0 1,15 * *').daysOfMonth]).toStrictEqual([1, 15]);
  });

  it('ignores the padding an expression was copied with', () => {
    expect([...parseCronExpression('  0   5 * * *  ').minutes]).toStrictEqual([0]);
  });
});

describe('expressions this dialect refuses', () => {
  it.each([
    ['MON', '* * * * MON'],
    ['JAN', '0 0 1 JAN *'],
    ['a shortcut', '@daily'],
    ['seconds', '0 0 0 * * *'],
    ['too few fields', '0 0 * *'],
    ['a minute out of range', '60 * * * *'],
    ['an hour out of range', '0 24 * * *'],
    ['a day out of range', '0 0 32 * *'],
    ['a month out of range', '0 0 1 13 *'],
    ['Sunday written as 7', '0 0 * * 7'],
    ['a backwards range', '0 9-5 * * *'],
    ['a zero step', '*/0 * * * *'],
    ['a negative value', '-5 * * * *'],
    ['an empty term', '0,, * * * *'],
    ['a tab between fields', '0\t0 * * *'],
    ['nothing at all', ''],
  ])('refuses %s', (_case, schedule) => {
    expect(cronExpressionError(schedule)).toBeDefined();
    expect(() => parseCronExpression(schedule)).toThrow(/invalid cron expression/u);
  });

  /**
   * The one rule that is not about syntax: ordinary cron *ors* the two day fields, and Vercel
   * refuses the expression instead. Refusing it is what lets `nextFireAfter` match with `and`.
   */
  it('refuses an expression that names both day fields', () => {
    expect(cronExpressionError('0 0 1 * 1')).toMatch(/day of month and day of week/u);
    expect(cronExpressionError('0 0 */2 * 1-5')).toMatch(/day of month and day of week/u);
    // One of them spelled out the long way still names days.
    expect(cronExpressionError('0 0 1-31 * 0-6')).toMatch(/day of month and day of week/u);
    // `*` and `*/1` name none, so either may go with the other field.
    expect(cronExpressionError('0 0 */1 * 1-5')).toBeUndefined();
    expect(cronExpressionError('0 0 1 * *')).toBeUndefined();
  });
});

describe('nextFireAfter', () => {
  it('is strictly after the moment it is given', () => {
    expect(nextFrom('* * * * *', '2026-09-23T10:00:00.000Z')).toBe('2026-09-23T10:01:00.000Z');
    // A firing advanced from its own minute moves on rather than repeating.
    expect(nextFrom('0 * * * *', '2026-09-23T10:00:00.000Z')).toBe('2026-09-23T11:00:00.000Z');
  });

  it('drops the seconds of the moment it is given', () => {
    expect(nextFrom('* * * * *', '2026-09-23T10:00:30.500Z')).toBe('2026-09-23T10:01:00.000Z');
  });

  it('advances a quarter-hourly schedule', () => {
    expect(nextFrom('*/15 * * * *', '2026-09-23T10:02:00.000Z')).toBe('2026-09-23T10:15:00.000Z');
    expect(nextFrom('*/15 * * * *', '2026-09-23T10:47:00.000Z')).toBe('2026-09-23T11:00:00.000Z');
  });

  it('crosses a day, a month and a year', () => {
    expect(nextFrom('0 5 * * *', '2026-09-23T06:00:00.000Z')).toBe('2026-09-24T05:00:00.000Z');
    expect(nextFrom('0 0 1 * *', '2026-09-23T06:00:00.000Z')).toBe('2026-10-01T00:00:00.000Z');
    expect(nextFrom('0 0 1 1 *', '2026-09-23T06:00:00.000Z')).toBe('2027-01-01T00:00:00.000Z');
    // The 31st exists in October and not in November.
    expect(nextFrom('0 0 31 * *', '2026-10-31T00:00:00.000Z')).toBe('2026-12-31T00:00:00.000Z');
  });

  it('finds the next leap day', () => {
    expect(nextFrom('0 0 29 2 *', '2026-09-23T00:00:00.000Z')).toBe('2028-02-29T00:00:00.000Z');
    // 2100 is not a leap year: the leap day after 2096 is eight years later, the longest a
    // satisfiable expression can wait, and the search reaches it.
    expect(nextFrom('0 0 29 2 *', '2096-03-01T00:00:00.000Z')).toBe('2104-02-29T00:00:00.000Z');
  });

  it('reads a day of week', () => {
    // 2026-09-23 is a Wednesday; the Friday after it is the 25th.
    expect(nextFrom('0 5 * * 5', '2026-09-23T06:00:00.000Z')).toBe('2026-09-25T05:00:00.000Z');
    expect(nextFrom('0 0 * * 0', '2026-09-23T06:00:00.000Z')).toBe('2026-09-27T00:00:00.000Z');
  });

  it('has nothing to answer for a day that never comes', () => {
    expect(nextFrom('0 0 30 2 *', '2026-09-23T00:00:00.000Z')).toBeUndefined();
  });

  it('reads an hourly schedule from the half hour', () => {
    expect(nextFrom('0 * * * *', '2026-09-23T10:30:00.000Z')).toBe('2026-09-23T11:00:00.000Z');
  });
});
