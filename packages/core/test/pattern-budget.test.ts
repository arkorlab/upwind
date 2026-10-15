import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { matcherHolds } from '../src/paas/payload-matcher.ts';
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
/**
 * The redirects Next.js 16.4 writes for `trailingSlash: true`, as its adapter compiles them: one for
 * a file's path asked with a slash, and one for any other path asked without.
 */
const TRAILING_SLASH_REDIRECTS = [
  String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/]+\.\w+))\/$`,
  String.raw`^(?:\/((?!\.well-known(?:\/.*)?)(?:[^/]+\/)*[^/\.]+))$`,
];

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
    current.remaining = 5;
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

  it.each([
    ['^a+a+!$', 'a'.repeat(4096)],
    ['^gatea+a+!$', `gate${'a'.repeat(4096)}`],
  ])(
    'charges guard scans when %s is refused, including one that finds its literal',
    (source, value) => {
      current = createPatternBudget();
      const initial = current.remaining;
      const pattern = compiled(source, 'i');
      const test = vi.spyOn(pattern, 'test');

      expect(() => testWithin(pattern, value)).toThrow(PatternBudgetExceededError);
      expect(test).not.toHaveBeenCalled();
      expect(current.remaining).toBe(initial - value.length * 3);
    },
  );

  it('does not scan a literal when the guards have too little allowance left', () => {
    current = createPatternBudget();
    const value = 'a'.repeat(4096);
    current.remaining = value.length + 1;
    const pattern = compiled('^a+a+!$', 'i');

    expect(() => testWithin(pattern, value)).toThrow(PatternBudgetExceededError);
    expect(current.remaining).toBe(1);
    expect(() => testWithin(pattern, value)).toThrow(PatternBudgetExceededError);
    expect(current.remaining).toBe(1);
  });

  it('charges guard attempts for refused patterns against an empty value', () => {
    current = createPatternBudget();
    current.remaining = 3;
    const pattern = compiled(String.raw`(a)\1`);

    expect(() => testWithin(pattern, '')).toThrow(PatternBudgetExceededError);
    expect(current.remaining).toBe(2);
    expect(() => testWithin(pattern, '')).toThrow(PatternBudgetExceededError);
    expect(current.remaining).toBe(1);
    expect(() => testWithin(pattern, '')).toThrow(PatternBudgetExceededError);
    expect(current.remaining).toBe(1);
  });

  it('bounds guards across refused payload split candidates that the matcher catches', () => {
    current = createPatternBudget();
    const initial = current.remaining;
    const payload = String.raw`(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;
    const pattern = compiled(`^/(a+a+)!${payload}`, 'i');
    const path = `/${'a'.repeat(20_000)}${'.segments/child'.repeat(16)}.segment.rsc`;

    expect(() => matcherHolds(pattern, path)).toThrow(PatternBudgetExceededError);
    expect(current.remaining).toBeLessThan(path.length * 3);
    expect(current.remaining).toBeGreaterThanOrEqual(0);
    expect(current.remaining).toBeLessThan(initial);
  });

  it('reads the cost for a value with line terminators separately', () => {
    current = createPatternBudget();
    const pattern = compiled('^(?:a+.*)$');

    expect(testWithin(pattern, 'a'.repeat(4096))).toBe(true);
    expect(() => testWithin(pattern, `${'a'.repeat(4096)}\n`)).toThrow(PatternBudgetExceededError);
  });

  /**
   * A request is asked both ahead of the file it names, and both again among the header rules,
   * since each redirect carries the `Location` it answers with. Read as cubic, the one for a file's
   * path took nearly all of a request's allowance at 63 characters, asked twice: a build's own
   * client middleware manifest went to the application's Function, which has none to serve.
   */
  it('affords a file’s path the redirects of `trailingSlash: true`, twice over', () => {
    current = createPatternBudget();
    const redirects = TRAILING_SLASH_REDIRECTS.map((source) => compiled(source, 'i'));
    const path = `/_next/static/${'a'.repeat(200)}/_clientMiddlewareManifest.js`;

    // Ahead of the file, and among the header rules.
    const asked = [...redirects, ...redirects].map((redirect) => testWithin(redirect, path));

    expect(asked).toStrictEqual([false, false, false, false]);
    // With most of the allowance left for the rest of the request's rules.
    expect(current.remaining).toBeGreaterThan(createPatternBudget().remaining / 2);
  });
});
