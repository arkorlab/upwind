import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { anyConditionHolds } from '../src/request/conditions.ts';
import {
  budgetPatterns,
  createPatternBudget,
  execWithin,
  type PatternBudget,
  PatternBudgetExceededError,
  testWithin,
} from '../src/request/pattern-budget.ts';

/** A pattern as the edge holds one, compiled from the application's routing manifest. */
function compiled(source: string, flags = 'u'): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- deliberately costly routing patterns
  return new RegExp(source, flags);
}

/** Each test fits on its own, but two cannot fit in one request's allowance. */
const QUADRATIC = '^a+a+!$';
const VALUE = 'a'.repeat(700);
/** Next.js 16.4's matcher for `/rewritten/:path*`, whose missing literal bounds the work. */
const MATCHER = String.raw`^(?:\/(_next\/data\/[^/]{1,}))?\/rewritten(?:\/((?:[^\/#\?]+?)(?:\/(?:[^\/#\?]+?))*))?(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;

describe('a request allowance for routing patterns', () => {
  let current: PatternBudget | undefined;

  beforeAll(() => {
    budgetPatterns(() => current);
  });

  beforeEach(() => {
    current = undefined;
  });

  it('keeps the per-test bound when no request store is active', () => {
    const pattern = compiled(QUADRATIC);

    expect(testWithin(pattern, VALUE)).toBe(false);
    expect(testWithin(pattern, VALUE)).toBe(false);
    expect(execWithin(pattern, VALUE)).toBeNull();
    expect(() => testWithin(pattern, 'a'.repeat(4096))).toThrow(PatternBudgetExceededError);
  });

  it('charges tests and executions of distinct patterns to one request, before they run', () => {
    current = createPatternBudget();
    const first = compiled(QUADRATIC);
    const later = compiled('^b+b+!$');
    const execute = vi.spyOn(later, 'exec');

    expect(testWithin(first, VALUE)).toBe(false);
    expect(() => execWithin(later, VALUE)).toThrow(PatternBudgetExceededError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not reset a request allowance when bounds are enabled again', () => {
    current = createPatternBudget();
    const pattern = compiled(QUADRATIC);

    expect(testWithin(pattern, VALUE)).toBe(false);

    budgetPatterns();

    expect(() => testWithin(pattern, VALUE)).toThrow(PatternBudgetExceededError);
  });

  it('uses a new allowance for the next request', () => {
    current = createPatternBudget();
    const pattern = compiled(QUADRATIC);

    expect(testWithin(pattern, VALUE)).toBe(false);
    expect(() => testWithin(pattern, VALUE)).toThrow(PatternBudgetExceededError);

    current = createPatternBudget();

    expect(testWithin(pattern, VALUE)).toBe(false);
  });

  it('charges the whole and substring attempts of a condition separately', () => {
    current = createPatternBudget();
    const condition = { type: 'header' as const, key: 'x-value', value: QUADRATIC };

    expect(() => {
      return anyConditionHolds(
        [condition],
        new URL('https://example.com/'),
        new Headers({ 'x-value': VALUE }),
      );
    }).toThrow(PatternBudgetExceededError);
  });

  it('charges only the affordable prefix when a costly matcher cannot reach its literal', () => {
    current = createPatternBudget();
    const initial = current.remaining;
    const pattern = compiled(MATCHER, 'i');
    const path = `/_next/static/immutable/chunks/${'a'.repeat(4096)}.js`;

    expect(testWithin(pattern, path)).toBe(false);

    const spent = initial - current.remaining;

    expect(spent).toBeGreaterThanOrEqual(path.length * 2);
    expect(testWithin(pattern, path)).toBe(false);
    expect(initial - current.remaining).toBe(spent * 2);
  });

  it('does not let the literal shortcut escape the cumulative bound', () => {
    current = createPatternBudget();
    const pattern = compiled(MATCHER, 'i');
    const path = `/_next/static/immutable/chunks/${'a'.repeat(4096)}.js`;

    expect(testWithin(pattern, path)).toBe(false);

    current.remaining = 0;
    const test = vi.spyOn(pattern, 'test');

    expect(() => testWithin(pattern, path)).toThrow(PatternBudgetExceededError);
    expect(test).not.toHaveBeenCalled();
  });

  it('charges an attempt against an empty value and refuses it after exhaustion', () => {
    current = createPatternBudget();
    current.remaining = 3;
    const pattern = compiled('^$');

    expect(testWithin(pattern, '')).toBe(true);
    expect(testWithin(pattern, '')).toBe(true);
    expect(() => testWithin(pattern, '')).toThrow(PatternBudgetExceededError);
  });

  it('bounds repeated guard scans even when each anchored non-match has constant cost', () => {
    current = createPatternBudget();
    const pattern = compiled('^b$');
    const value = 'a'.repeat(65_536);

    expect(Array.from({ length: 7 }, () => testWithin(pattern, value))).toStrictEqual(
      Array.from({ length: 7 }, () => false),
    );

    const test = vi.spyOn(pattern, 'test');

    expect(() => testWithin(pattern, value)).toThrow(PatternBudgetExceededError);
    expect(test).not.toHaveBeenCalled();
  });

  it('reads the cost for a value with line terminators separately', () => {
    current = createPatternBudget();
    const pattern = compiled('^(?:a+.*)$');

    expect(testWithin(pattern, 'a'.repeat(4096))).toBe(true);
    expect(() => testWithin(pattern, `${'a'.repeat(4096)}\n`)).toThrow(PatternBudgetExceededError);
  });
});
