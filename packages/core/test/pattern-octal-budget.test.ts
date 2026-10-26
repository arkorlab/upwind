import { describe, expect, it, vi } from 'vitest';

import {
  budgetPatterns,
  execWithin,
  PatternBudgetExceededError,
  testWithin,
} from '../src/request/pattern-budget.ts';
import { literalGate, patternCost } from '../src/request/pattern-cost.ts';

describe('unsupported legacy octal routing tokens', () => {
  it.each([String.raw`\01`, String.raw`\057`, String.raw`\00`, String.raw`\078`, String.raw`\08`])(
    'does not infer mandatory trailing digits from %s',
    (escape) => {
      const source = `^${escape}a*a*a*a*!$`;

      expect(patternCost(source, '', true)).toBeUndefined();
      expect(literalGate(source, '', true)).toBeUndefined();
    },
  );

  it('refuses both guarded APIs before native execution', () => {
    budgetPatterns();
    // eslint-disable-next-line security/detect-non-literal-regexp, require-unicode-regexp -- adversarial legacy grammar, refused before execution.
    const pattern = new RegExp(['^', String.raw`\057`, 'a*'.repeat(4), '!$'].join(''));
    const test = vi.spyOn(pattern, 'test');
    const exec = vi.spyOn(pattern, 'exec');
    const value = `/${'a'.repeat(200)}b`;

    expect(() => testWithin(pattern, value)).toThrow(PatternBudgetExceededError);
    expect(() => execWithin(pattern, value)).toThrow(PatternBudgetExceededError);
    expect(test).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });
});
