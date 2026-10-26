import { describe, expect, it, vi } from 'vitest';

import {
  budgetPatterns,
  execWithin,
  PatternBudgetExceededError,
  testWithin,
} from '../src/request/pattern-budget.ts';
import { literalGate, patternCost } from '../src/request/pattern-cost.ts';

const LEADING_ZERO_ESCAPES = [
  [String.raw`\01`, '\u{1}'],
  [String.raw`\012`, '\n'],
  [String.raw`\057`, '/'],
  [String.raw`\00`, '\0'],
  [String.raw`\078`, '\u{7}8'],
  [String.raw`\08`, '\u{0}8'],
  [String.raw`\0008`, '\u{0}8'],
  [String.raw`\0777`, '?7'],
] as const;

describe('legacy leading-zero octal routing tokens', () => {
  it.each(LEADING_ZERO_ESCAPES)(
    'reads the complete token and preserves real trailing digits in %s',
    (escape, prefix) => {
      const source = `^${escape}a*a*a*a*!$`;

      expect(patternCost(source, '', true)).toBeDefined();
      expect(literalGate(source, '', true)?.literal).toBe(prefix);
    },
  );

  it.each(['', 'i'])('preserves affordable native matches with flags %j', (flags) => {
    budgetPatterns();
    for (const [escape, prefix] of LEADING_ZERO_ESCAPES) {
      // eslint-disable-next-line security/detect-non-literal-regexp -- bounded legacy literals compared to their native semantics.
      const pattern = new RegExp(`^${escape}ab$`, flags);
      const value = `${prefix}ab`;
      const native = pattern.exec(value);

      expect(native).not.toBeNull();
      expect(testWithin(pattern, value)).toBe(true);
      expect(execWithin(pattern, value)).toStrictEqual(native);
    }
  });

  it.each(['', 'i'])(
    'still refuses adversarial work before either native API with flags %j',
    (flags) => {
      budgetPatterns();
      // eslint-disable-next-line security/detect-non-literal-regexp -- adversarial legacy grammar, refused before execution.
      const pattern = new RegExp(['^', String.raw`\057`, 'a*'.repeat(4), '!$'].join(''), flags);
      const test = vi.spyOn(pattern, 'test');
      const exec = vi.spyOn(pattern, 'exec');
      const value = `/${'a'.repeat(200)}b`;

      expect(literalGate(pattern.source, flags, true)?.literal).toBe('/');
      expect(() => testWithin(pattern, value)).toThrow(PatternBudgetExceededError);
      expect(() => execWithin(pattern, value)).toThrow(PatternBudgetExceededError);
      expect(test).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it.each([String.raw`\1`, String.raw`\123`, String.raw`\9`])(
    'keeps nonzero decimal/backreference tokens unread: %s',
    (escape) => {
      const source = `^${escape}a*a*a*a*!$`;

      expect(patternCost(source, '', true)).toBeUndefined();
      expect(literalGate(source, '', true)).toBeUndefined();
    },
  );
});
