import { describe, expect, it, vi } from 'vitest';

import { afterGroup } from '../src/request/pattern-syntax.ts';
import { requiresLiteral } from '../src/request/required-literal.ts';

vi.mock(import('../src/request/pattern-syntax.ts'), async (importOriginal) => {
  const actual = await importOriginal();

  return { ...actual, afterGroup: vi.fn(actual.afterGroup) };
});

describe('outside routing proofs avoid recursive group analysis', () => {
  it.each([1, 8, 24])(
    'keeps group reads independent of a %s-level group before a suffix',
    (depth) => {
      const nested = `${'(?:'.repeat(depth)}alpha|beta${')'.repeat(depth)}`;
      vi.mocked(afterGroup).mockClear();

      expect(requiresLiteral(`^/${nested}/catalog$`, '/catalog')).toBe(true);
      // One top-level alternative scan and one token read, regardless of the skipped depth.
      expect(afterGroup).toHaveBeenCalledTimes(2);
    },
  );

  it('falls back to recursive proof when only the group can prove the literal', () => {
    vi.mocked(afterGroup).mockClear();

    expect(requiresLiteral(String.raw`^((?:/catalog))\1$`, '/catalog')).toBe(true);
    expect(vi.mocked(afterGroup).mock.calls.length).toBeGreaterThan(2);
  });
});
