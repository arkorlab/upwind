import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertAffordable,
  budgetPatterns,
  createPatternBudget,
  execWithin,
  type PatternBudget,
  PatternBudgetExceededError,
  testWithin,
} from '../src/request/pattern-budget.ts';

const ROUTE = '^/(?<locale>en|ja)/(?<team>[^/]+)/catalog$';

function compiled(source = ROUTE, flags = ''): RegExp {
  // eslint-disable-next-line security/detect-non-literal-regexp -- deliberately exercise routing patterns and their flags
  return new RegExp(source, flags);
}

describe('proven short routing non-matches', () => {
  let current: PatternBudget | undefined;

  beforeAll(() => {
    budgetPatterns(() => current);
  });

  beforeEach(() => {
    current = createPatternBudget();
  });

  it('leaves an application that did not enable bounds on its native matching path', async () => {
    vi.resetModules();
    const unbounded = await import('../src/request/pattern-budget.ts');
    const pattern = compiled('^/catalog$', 'iu');

    expect(unbounded.execWithin(pattern, '/catalog')).toStrictEqual(pattern.exec('/catalog'));
  });

  it('uses a replacement request getter and retains it when enabled again without one', async () => {
    vi.resetModules();
    const isolated = await import('../src/request/pattern-budget.ts');
    const first = { remaining: 1 };
    const second = { remaining: 2 };
    const pattern = compiled();
    const source = vi.spyOn(pattern, 'source', 'get');
    const execute = vi.spyOn(pattern, 'exec');

    isolated.budgetPatterns(() => first);

    expect(isolated.testWithin(pattern, '/')).toBe(false);

    isolated.budgetPatterns(() => second);

    expect(isolated.execWithin(pattern, '/en')).toBeNull();
    expect(second.remaining).toBe(1);

    isolated.budgetPatterns();

    expect(isolated.testWithin(pattern, '/ja')).toBe(false);
    expect([first.remaining, second.remaining]).toStrictEqual([0, 0]);
    expect(source).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(() => isolated.execWithin(pattern, '/')).toThrow(isolated.PatternBudgetExceededError);
  });

  it.each(['', 'i'])('returns a proven miss without executing the %s pattern', (flags) => {
    const pattern = compiled(ROUTE, flags);
    const test = vi.spyOn(pattern, 'test');
    const execute = vi.spyOn(pattern, 'exec');
    const initial = current?.remaining ?? 0;

    expect(testWithin(pattern, '/')).toBe(false);
    expect(execWithin(pattern, '/en')).toBeNull();
    expect(test).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(current?.remaining).toBe(initial - 2);
  });

  it('charges every proof attempt and refuses an exhausted request before the regex runs', () => {
    current = { remaining: 2 };
    const pattern = compiled();
    const execute = vi.spyOn(pattern, 'exec');

    expect(testWithin(pattern, '/')).toBe(false);
    expect(execWithin(pattern, '/ja')).toBeNull();
    expect(current.remaining).toBe(0);
    expect(() => testWithin(pattern, '/')).toThrow(PatternBudgetExceededError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves the public affordability check even when a wrapper can prove a miss', () => {
    current = { remaining: 1 };
    const pattern = compiled();

    expect(() => {
      assertAffordable(pattern, '/');
    }).toThrow(PatternBudgetExceededError);
    expect(current.remaining).toBe(1);
    expect(testWithin(pattern, '/')).toBe(false);
    expect(current.remaining).toBe(0);
  });

  it('preserves actual matches, captures and case behavior after an earlier proven miss', () => {
    const pattern = compiled(ROUTE, 'i');
    const value = '/JA/a-team/CATALOG';

    expect(execWithin(pattern, '/')).toBeNull();
    expect(execWithin(pattern, value)).toStrictEqual(pattern.exec(value));
    expect(execWithin(pattern, value)?.groups?.['locale']).toBe('JA');
    expect(execWithin(pattern, value)?.groups?.['team']).toBe('a-team');
  });

  it('keeps the already analyzed path and its request charge unchanged', () => {
    const pattern = compiled();

    expect(testWithin(pattern, '/en/team/catalog')).toBe(true);

    current = createPatternBudget();
    const execute = vi.spyOn(pattern, 'exec');

    expect(execWithin(pattern, '/')).toBeNull();
    expect(execute).toHaveBeenCalledExactlyOnceWith('/');

    const remaining = current.remaining;
    current = createPatternBudget();

    assertAffordable(pattern, '/');

    expect(current.remaining).toBe(remaining);
  });

  it.each(['g', 'y', 'u'])('does not shortcut unsupported or stateful flags %s', (flags) => {
    const pattern = compiled('^/catalog$', flags);
    const execute = vi.spyOn(pattern, 'exec');

    expect(execWithin(pattern, '/')).toBeNull();
    expect(execute).toHaveBeenCalledExactlyOnceWith('/');
  });

  it.each(['', 'i'])('preserves a real legacy octal match with flags %s', (flags) => {
    const pattern = compiled(String.raw`^\012ab$`, flags);
    const value = '\nab';
    const native = pattern.exec(value);
    const execute = vi.spyOn(pattern, 'exec');

    expect(testWithin(pattern, value)).toBe(true);
    expect(execWithin(pattern, value)).toStrictEqual(native);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('keeps the refusal for a Unicode case-folding pattern its cost cannot bound', () => {
    const pattern = compiled('^/catalog$', 'iu');
    const execute = vi.spyOn(pattern, 'exec');

    expect(() => execWithin(pattern, '/')).toThrow(PatternBudgetExceededError);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['^/short$|^/catalog$', '^(?:/catalog)?$', '^(?=/catalog)/.*$'])(
    'keeps normal matching when necessity is unproved: %s',
    (source) => {
      const pattern = compiled(source);
      const execute = vi.spyOn(pattern, 'exec');

      expect(execWithin(pattern, '')).toStrictEqual(pattern.exec(''));
      expect(execute).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps the legacy per-test path when no request-local store is active', () => {
    current = undefined;
    const pattern = compiled();
    const execute = vi.spyOn(pattern, 'exec');

    expect(execWithin(pattern, '/')).toBeNull();
    expect(execute).toHaveBeenCalledExactlyOnceWith('/');
  });
});
