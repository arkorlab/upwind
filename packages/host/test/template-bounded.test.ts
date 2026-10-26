import * as s from '@stayingupwind/core/schema';
import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { toZod } from '../src/zod/to-zod.ts';

function issues(
  result: { success: true } | { success: false; error: { issues: readonly unknown[] } },
): unknown {
  return result.success ? undefined : result.error.issues;
}

describe('bounded converted templates', () => {
  it('uses the core matcher and runs chained refinements once', () => {
    const refine = vi.fn(() => true);
    const schema = s
      .templateLiteral([s.string(), 'a', s.string(), 'a', s.string(), '!'])
      .refine(refine);
    const execute = vi.spyOn(schema.pattern, 'test');
    const converted = toZod(schema);

    expect(converted.safeParse('aa!').success).toBe(true);
    expect(refine).toHaveBeenCalledTimes(1);

    const input = `${'a'.repeat(1024)}?`;
    const actual = converted.safeParse(input);
    const expected = schema.safeParse(input);

    expect(actual.success).toBe(false);
    expect(expected.success).toBe(false);

    expect(issues(actual)).toStrictEqual(issues(expected));

    expect(execute).not.toHaveBeenCalled();
    expect(z.toJSONSchema(converted)).toMatchObject({
      type: 'string',
      pattern: schema.pattern.source,
    });
  });

  it('preserves literal suffix and Unicode boundary behavior', () => {
    for (const parts of [
      ['\u{D83D}', s.string(), '\u{DE00}'],
      [s.string(), '!'],
    ] as const) {
      const schema = s.templateLiteral(parts);
      const converted = toZod(schema);
      for (const input of ['😀', '\u{1F600}', '!\n', '!', '\u{D83D}x\u{DE00}']) {
        expect(converted.safeParse(input).success).toBe(schema.safeParse(input).success);
      }
    }
  });
});
