import { describe, expect, it, vi } from 'vitest';

import * as s from '../src/schema/index.ts';

describe('bounded array parsing', () => {
  it.each(['parse', 'safeParse', 'validate'] as const)(
    'rejects an oversized sparse input before reading elements or refinements with %s',
    (method) => {
      let elements = 0;
      let refinements = 0;
      const input: unknown[] = [];
      input.length = 10_000;
      Object.defineProperty(input, 0, {
        get: () => {
          elements += 1;
          throw new Error('an oversized array must not read its elements');
        },
      });
      const schema = s
        .array(s.string())
        .max(2, 'at most two')
        .refine(() => {
          refinements += 1;
          return true;
        });
      const ask = {
        parse: () => {
          expect(() => schema.parse(input)).toThrow('at most two');
        },
        safeParse: () => {
          expect(schema.safeParse(input).success).toBe(false);
        },
        validate: () => {
          expect(schema.validate(input)).toBe(false);
        },
      };
      ask[method]();

      expect({ elements, refinements }).toStrictEqual({ elements: 0, refinements: 0 });
    },
  );

  it('reports only the first exceeded leading bound, retaining its exactness and message', () => {
    const schema = s.array(s.number()).min(10).length(2, 'exactly two').max(1, 'only one');
    const parsed = schema.safeParse(['bad', 'bad', 'bad']);

    expect(parsed.error?.issues).toStrictEqual([
      {
        origin: 'array',
        code: 'too_big',
        maximum: 2,
        inclusive: true,
        exact: true,
        path: [],
        message: 'exactly two',
      },
    ]);
  });

  it('does not run a parent refinement on a rejected raw collection', () => {
    let refined = 0;
    const schema = s.object({ entries: s.array(s.number()).max(1) }).refine(() => {
      refined += 1;
      return true;
    });
    const parsed = schema.safeParse({ entries: ['bad', 'bad'] });

    expect(parsed.error?.issues).toMatchObject([{ code: 'too_big', path: ['entries'] }]);
    expect(refined).toBe(0);
  });

  it('still parses undersized inputs and checks following a refinement in their original order', () => {
    let elements = 0;
    let refined = 0;
    const element = s.number().refine(() => {
      elements += 1;
      return true;
    });
    const undersized = s.array(element).length(2).safeParse([1]);
    const afterRefinement = s
      .array(element)
      .refine(() => {
        refined += 1;
        return true;
      })
      .max(1)
      .safeParse([1, 2]);

    expect(undersized.error?.issues).toMatchObject([{ code: 'too_small', exact: true }]);
    expect(afterRefinement.error?.issues).toMatchObject([{ code: 'too_big' }]);
    expect({ elements, refined }).toStrictEqual({ elements: 3, refined: 1 });
  });

  it('keeps chained copies independent and returns freshly parsed in-bound arrays', () => {
    const original = s.array(s.number());
    const capped = original.max(1);
    const input = [1, 2];

    expect(original.parse(input)).toStrictEqual(input);
    expect(original.parse(input)).not.toBe(input);
    expect(capped.safeParse(input).success).toBe(false);
    expect(capped.parse([1])).toStrictEqual([1]);
  });
});

// Zod 4.6.6/4.6.7 reject an oversized array at its first leading upper bound.
const TOO_BIG_TWO = {
  origin: 'array',
  code: 'too_big',
  maximum: 2,
  inclusive: true,
  path: [],
  message: 'Too big: expected array to have <=2 items',
};
const EXACTLY_TWO = {
  ...TOO_BIG_TWO,
  exact: true,
  message: 'Too big: expected array to have exactly 2 items',
};
const INVALID_NUMBER = {
  expected: 'number',
  code: 'invalid_type',
  path: [0],
  message: 'Invalid input: expected number, received string',
};

function issuesFor(schema: s.Schema, input: unknown): readonly s.Issue[] {
  const result = schema.safeParse(input);
  if (result.success) {
    throw new Error('Expected the input to fail validation.');
  }
  return result.error.issues;
}

function unreadableArray(): { input: number[]; read: () => never } {
  const read = vi.fn(() => {
    throw new Error('An oversized array element must not be read.');
  });
  const input = [1, 2, 3];
  Object.defineProperty(input, 0, { get: read });
  return { input, read };
}

function shrink(value: string[]): boolean {
  value.splice(2);
  return true;
}

describe('array upper bounds before element parsing', () => {
  it('reports only the maximum when every oversized element has the wrong type', () => {
    const schema = s.array(s.number()).min(1).max(2);

    expect(issuesFor(schema, ['a', 'b', 'c'])).toStrictEqual([TOO_BIG_TWO]);
  });

  it('short circuits an exact upper bound before reading any element', () => {
    const schema = s.array(s.number()).length(2);
    const { input, read } = unreadableArray();

    expect(issuesFor(schema, input)).toStrictEqual([EXACTLY_TWO]);
    expect(read).not.toHaveBeenCalled();
  });

  it('skips all child and later refinement callbacks after the upper bound fails', () => {
    const child = vi.fn(() => true);
    const refine = vi.fn(() => true);
    const superRefine = vi.fn();
    const element = s.number().refine(child);
    const schema = s.array(element).max(2).refine(refine).superRefine(superRefine);

    expect(issuesFor(schema, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
    expect([child.mock.calls, refine.mock.calls, superRefine.mock.calls]).toStrictEqual([
      [],
      [],
      [],
    ]);
  });

  it('reports the first violated upper bound in chain order, not the smallest one', () => {
    const schema = s.array(s.number()).max(5, 'first').max(2, 'second');

    expect(issuesFor(schema, [1, 2, 3, 4, 5, 6])).toStrictEqual([
      { ...TOO_BIG_TWO, maximum: 5, message: 'first' },
    ]);
    expect(issuesFor(schema, [1, 2, 3, 4])).toStrictEqual([{ ...TOO_BIG_TWO, message: 'second' }]);
  });

  it('ignores an earlier minimum when a later leading upper bound rejects the input', () => {
    const schema = s.array(s.number()).min(10).max(2);

    expect(issuesFor(schema, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
  });

  it('keeps exact-length issue details and a custom message under nested paths', () => {
    const row = s.array(s.number()).length(2, 'two only');
    const schema = s.object({ rows: s.array(row) });

    expect(issuesFor(schema, { rows: [[1, 2, 3]] })).toStrictEqual([
      { ...EXACTLY_TWO, path: ['rows', 0], message: 'two only' },
    ]);
  });

  it('still parses children and reports their errors before a minimum failure', () => {
    const schema = s.array(s.number()).min(2);

    expect(issuesFor(schema, ['a'])).toStrictEqual([
      INVALID_NUMBER,
      {
        origin: 'array',
        code: 'too_small',
        minimum: 2,
        inclusive: true,
        path: [],
        message: 'Too small: expected array to have >=2 items',
      },
    ]);
  });

  it('does not short circuit an exact-length underflow', () => {
    const schema = s.array(s.number()).length(2);

    expect(issuesFor(schema, ['a'])).toStrictEqual([
      INVALID_NUMBER,
      {
        origin: 'array',
        code: 'too_small',
        minimum: 2,
        inclusive: true,
        exact: true,
        path: [],
        message: 'Too small: expected array to have exactly 2 items',
      },
    ]);
  });

  it('does not change valid child output or bounds on a base or sibling schema', () => {
    const base = s.array(s.string().trim());
    const narrow = base.max(1);
    const wide = base.max(2);
    const input = [' a ', ' b '];

    expect(base.parse(input)).toStrictEqual(['a', 'b']);
    expect(wide.parse(input)).toStrictEqual(['a', 'b']);
    expect(issuesFor(narrow, input)).toStrictEqual([
      {
        ...TOO_BIG_TWO,
        maximum: 1,
        message: 'Too big: expected array to have <=1 items',
      },
    ]);
    expect(input).toStrictEqual([' a ', ' b ']);
  });

  it('does not hoist a maximum across a refinement that changes the parsed output', () => {
    const refine = vi.fn(shrink);
    const schema = s.array(s.string().trim()).refine(refine).max(2);
    const input = [' a ', ' b ', ' c '];

    expect(schema.parse(input)).toStrictEqual(['a', 'b']);
    expect(refine).toHaveBeenCalledExactlyOnceWith(['a', 'b']);
    expect(input).toStrictEqual([' a ', ' b ', ' c ']);
  });

  it('does not hoist a length bound across superRefine either', () => {
    const schema = s.array(s.string().trim()).superRefine(shrink).length(2);

    expect(schema.parse([' a ', ' b ', ' c '])).toStrictEqual(['a', 'b']);
  });

  it('retains a leading cap through wrappers while preserving their own accepted values', () => {
    const bounded = s.array(s.number()).max(2);
    const wrapped = bounded.optional().nullable();
    const defaulted = bounded.default([1, 2, 3]);

    expect(issuesFor(wrapped, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
    expect([wrapped.parse(undefined), wrapped.parse(null)]).toStrictEqual([undefined, null]);
    expect(defaulted.parse(undefined)).toStrictEqual([1, 2, 3]);
    expect(issuesFor(defaulted, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
  });

  it('retains normal wrong-type and length diagnostics for non-array values', () => {
    const schema = s.array(s.number()).max(2);

    expect(issuesFor(schema, 'abc')).toStrictEqual([
      {
        expected: 'array',
        code: 'invalid_type',
        path: [],
        message: 'Invalid input: expected array, received string',
      },
      {
        origin: 'string',
        code: 'too_big',
        maximum: 2,
        inclusive: true,
        path: [],
        message: 'Too big: expected string to have <=2 characters',
      },
    ]);
  });

  it('does not let an ineligible NaN or negative upper bound hide a later cap', () => {
    const nan = s.array(s.number()).max(NaN).max(2);
    const negative = s.array(s.number()).max(-1).max(2);

    expect(issuesFor(nan, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
    expect(issuesFor(negative, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
  });

  it('keeps zero as an upper cap and infinity as an unbounded maximum', () => {
    const zero = s.array(s.number()).max(0);
    const infinite = s.array(s.number()).max(Infinity);

    expect(issuesFor(zero, [1])).toStrictEqual([
      {
        ...TOO_BIG_TWO,
        maximum: 0,
        message: 'Too big: expected array to have <=0 items',
      },
    ]);
    expect(infinite.parse([1, 2, 3])).toStrictEqual([1, 2, 3]);
  });

  it('marks the oversized option as aborted when a union has no matching alternative', () => {
    const schema = s.union([s.array(s.number()).max(2), s.string()]);

    expect(issuesFor(schema, [1, 2, 3])).toStrictEqual([
      {
        code: 'invalid_union',
        errors: [
          [TOO_BIG_TWO],
          [
            {
              expected: 'string',
              code: 'invalid_type',
              path: [],
              message: 'Invalid input: expected string, received array',
            },
          ],
        ],
        path: [],
        message: 'Invalid input',
      },
    ]);
    expect(schema.parse('alternate')).toBe('alternate');
  });
});
