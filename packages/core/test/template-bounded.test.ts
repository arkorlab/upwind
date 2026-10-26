import { describe, expect, it, vi } from 'vitest';

import { string, templateLiteral } from '../src/schema/strings.ts';

describe('bounded template matching', () => {
  it('retains the generated pattern as metadata, without executing it', () => {
    const schema = templateLiteral([string(), 'a', string(), 'a', string(), '!']);
    const execute = vi.spyOn(schema.pattern, 'test');
    expect(schema.safeParse(`${'a'.repeat(1024)}?`).success).toBe(false);
    expect(schema.safeParse('aa!').success).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it('matches literal runs and arbitrary Unicode gaps with the original semantics', () => {
    const schemas = [
      templateLiteral([]),
      templateLiteral(['a', 1, null]),
      templateLiteral(['segment:', string()]),
      templateLiteral([string(), 'a', string(), 'ab']),
      templateLiteral([string(), '', string(), '!']),
      templateLiteral(['\ud83d', string(), '\ude00']),
      templateLiteral([string(), '\ude00', string()]),
      templateLiteral(['\ud83d', '\ude00', string()]),
    ];
    const inputs = [
      '',
      'a1null',
      'segment:',
      'segment:\n😀',
      'aaab',
      'abab',
      '!',
      '😀',
      '\ud83d',
      '\ude00',
      '😀\ude00',
    ];
    for (const schema of schemas) {
      for (const input of inputs) expect(schema.matches(input)).toBe(schema.pattern.test(input));
    }
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'requires the fixed suffix at the actual end before %j',
    (line) => {
      expect(templateLiteral([string(), '!']).matches(`!${line}`)).toBe(false);
      expect(templateLiteral(['a']).matches(`a${line}`)).toBe(false);
    },
  );
});
