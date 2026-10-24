import { describe, expect, it } from 'vitest';

import {
  CloudflareCronExpressionError,
  cloudflareCronExpressionError,
  parseCloudflareCronExpression,
} from '../src/cron/cloudflare-expression.ts';
import { nextCloudflareFireAfterExpression } from '../src/cron/cloudflare-occurrence.ts';

/* eslint-disable unicorn/prefer-temporal -- Match the Workers calculator's epoch-millisecond API. */
const next = (expression: string, after: string): string | undefined => {
  const timestamp = nextCloudflareFireAfterExpression(expression, Date.parse(after));
  return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
};
/* eslint-enable unicorn/prefer-temporal */

describe('cloudflare cron expressions', () => {
  it.each([
    '* * * * *',
    '0 17 * * sun',
    '10 7 * * mon-fri',
    '0 18 * * friL',
    '59 23 LW * *',
    '0 0 L-30W * *',
    '0 0 31W * *',
    '0 0 * * MON#5',
    '0 0 * * L',
    '50-10/3 22-2/2 28-3/2 NOV-FEB/2 FRI-MON/2',
    '1,*/5,*,*-10/3 0 * * *',
    '000 00 01 jan 001',
  ])('accepts the Saffron grammar: %s', (expression) => {
    expect(cloudflareCronExpressionError(expression)).toBeUndefined();
  });

  it.each([
    '',
    '* * * *',
    '* * * * * *',
    ' * * * * *',
    '* * * * * ',
    '*\n* * * *',
    '@daily',
    '0 0 ? * MON',
    '0 0 * * 0',
    '60 * * * *',
    '* 24 * * *',
    '*/60 * * * *',
    '* */24 * * *',
    '* * */31 * *',
    '* * * */12 *',
    '* * * * */7',
    '0 0 L-0 * *',
    '0 0 L-31 * *',
    '0 0 0W * *',
    '0 0 32W * *',
    '0 0 L,1 * *',
    '0 0 1W,15 * *',
    '0 0 * * MON#0',
    '0 0 * * MON#6',
    '0 0 * * MON#1,FRI#2',
    '0 0 * * MONL,FRIL',
    '0 0 * * L/2',
    '0 0 lw * *',
    '0 0 1w * *',
    '0 0 * * monl',
    '*,1 * * * *',
    '*-10 * * * *',
    '1,,2 * * * *',
    '1/0 * * * *',
    '0 0 * january *',
  ])('rejects unsupported syntax: %s', (expression) => {
    expect(() => parseCloudflareCronExpression(expression)).toThrow(CloudflareCronExpressionError);
  });

  it('preserves spacing and case for the scheduled controller', () => {
    const source = '0\t0  *   jan mon';

    expect(parseCloudflareCronExpression(source).source).toBe(source);
  });

  it('expands a starting value through the field maximum when a step is present', () => {
    expect([...parseCloudflareCronExpression('50/4 * * * *').minutes]).toStrictEqual([50, 54, 58]);
  });

  it('retains Saffron’s literal-star semantics inside list tails', () => {
    expect([...parseCloudflareCronExpression('1,* * * * *').minutes]).toStrictEqual([1, 0]);
    expect([...parseCloudflareCronExpression('1,*-5 * * * *').minutes]).toStrictEqual([
      1, 0, 2, 3, 4, 5,
    ]);
  });

  it('steps continuously through wrapped ranges', () => {
    const expression = parseCloudflareCronExpression('58-3/2 22-2/2 * NOV-FEB/2 FRI-MON/2');

    expect([...expression.minutes]).toStrictEqual([58, 0, 2]);
    expect([...expression.hours]).toStrictEqual([22, 0, 2]);
    expect([...expression.months]).toStrictEqual([11, 1]);
    expect(expression.daysOfWeek).toStrictEqual({ kind: 'values', values: new Set([1, 6]) });
  });

  it('keeps bare stars distinct from full-domain patterns', () => {
    expect(next('0 0 * * MON', '2026-10-25T00:00:00Z')).toBe('2026-10-26T00:00:00.000Z');
    expect(next('0 0 */1 * MON', '2026-10-25T00:00:00Z')).toBe('2026-10-26T00:00:00.000Z');
    expect(next('0 0 * * MON', '2026-10-26T00:00:00Z')).toBe('2026-11-02T00:00:00.000Z');
    expect(next('0 0 */1 * MON', '2026-10-26T00:00:00Z')).toBe('2026-10-27T00:00:00.000Z');
  });
});

describe('cloudflare next scheduled occurrence', () => {
  it.each([
    ['* * * * *', '2026-10-24T10:03:00Z', '2026-10-24T10:04:00.000Z'],
    ['* * * * *', '2026-10-24T10:03:59.999Z', '2026-10-24T10:04:00.000Z'],
    ['59,1 23,0 * * *', '2026-10-24T00:00:00Z', '2026-10-24T00:01:00.000Z'],
    ['0 0 1 * MON', '2026-10-25T00:00:00Z', '2026-10-26T00:00:00.000Z'],
    ['0 0 31 FEB MON', '2026-02-01T00:00:00Z', '2026-02-02T00:00:00.000Z'],
    ['0 0 * * 1', '2026-10-24T00:00:00Z', '2026-10-25T00:00:00.000Z'],
    ['0 0 * * 7', '2026-10-24T00:00:00Z', '2026-10-31T00:00:00.000Z'],
    ['0 0 * * L', '2026-10-24T00:00:00Z', '2026-10-31T00:00:00.000Z'],
    ['59 23 LW * *', '2026-01-01T00:00:00Z', '2026-01-30T23:59:00.000Z'],
    ['0 0 1W * *', '2026-07-31T00:00:00Z', '2026-08-03T00:00:00.000Z'],
    ['0 0 31W * *', '2026-04-01T00:00:00Z', '2026-05-29T00:00:00.000Z'],
    ['0 0 L-1 * *', '2026-02-01T00:00:00Z', '2026-02-27T00:00:00.000Z'],
    ['0 0 L-1W * *', '2026-05-01T00:00:00Z', '2026-05-29T00:00:00.000Z'],
    ['0 0 L-30W * *', '2026-08-01T00:00:00Z', '2026-08-03T00:00:00.000Z'],
    ['0 0 * * FRIL', '2026-10-01T00:00:00Z', '2026-10-30T00:00:00.000Z'],
    ['0 0 * * MON#5', '2026-02-01T00:00:00Z', '2026-03-30T00:00:00.000Z'],
    ['0 0 29 FEB *', '2096-02-29T00:00:00Z', '2104-02-29T00:00:00.000Z'],
    ['0 0 29 FEB *', '2399-03-01T00:00:00Z', '2400-02-29T00:00:00.000Z'],
    ['0 0 31 DEC *', '0099-01-01T00:00:00Z', '0099-12-31T00:00:00.000Z'],
  ])('%s after %s', (expression, after, expected) => {
    expect(next(expression, after)).toBe(expected);
  });

  it.each(['0 0 30 FEB *', '0 0 31 APR *', '0 0 31W FEB *', '0 0 L-30 FEB *'])(
    'returns no occurrence for impossible calendar dates: %s',
    (expression) => {
      expect(next(expression, '2026-01-01T00:00:00Z')).toBeUndefined();
    },
  );

  it('rejects non-finite and out-of-range timestamps without searching', () => {
    for (const timestamp of [NaN, Infinity, Number.MAX_VALUE]) {
      expect(nextCloudflareFireAfterExpression('* * * * *', timestamp)).toBeUndefined();
    }
  });
});
