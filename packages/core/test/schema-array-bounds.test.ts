import { describe, expect, it, vi } from 'vitest';

import * as z from '../src/schema/index.ts';

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

function issuesFor(schema: z.Schema, input: unknown): readonly z.Issue[] {
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
    const schema = z.array(z.number()).min(1).max(2);

    expect(issuesFor(schema, ['a', 'b', 'c'])).toStrictEqual([TOO_BIG_TWO]);
  });

  it('never reads oversized elements in safeParse, parse or validate', () => {
    const schema = z.array(z.number()).max(2);
    const { input, read } = unreadableArray();

    expect(issuesFor(schema, input)).toStrictEqual([TOO_BIG_TWO]);
    expect(() => schema.parse(input)).toThrow(z.SchemaError);
    expect(schema.validate(input)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it('short circuits an exact upper bound before reading any element', () => {
    const schema = z.array(z.number()).length(2);
    const { input, read } = unreadableArray();

    expect(issuesFor(schema, input)).toStrictEqual([EXACTLY_TWO]);
    expect(read).not.toHaveBeenCalled();
  });

  it('skips all child and later refinement callbacks after the upper bound fails', () => {
    const child = vi.fn(() => true);
    const refine = vi.fn(() => true);
    const superRefine = vi.fn(() => {});
    const element = z.number().refine(child);
    const schema = z.array(element).max(2).refine(refine).superRefine(superRefine);

    expect(issuesFor(schema, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
    expect([child.mock.calls, refine.mock.calls, superRefine.mock.calls]).toStrictEqual([
      [],
      [],
      [],
    ]);
  });

  it('reports the first violated upper bound in chain order, not the smallest one', () => {
    const schema = z.array(z.number()).max(5, 'first').max(2, 'second');

    expect(issuesFor(schema, [1, 2, 3, 4, 5, 6])).toStrictEqual([
      { ...TOO_BIG_TWO, maximum: 5, message: 'first' },
    ]);
    expect(issuesFor(schema, [1, 2, 3, 4])).toStrictEqual([{ ...TOO_BIG_TWO, message: 'second' }]);
  });

  it('ignores an earlier minimum when a later leading upper bound rejects the input', () => {
    const schema = z.array(z.number()).min(10).max(2);

    expect(issuesFor(schema, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
  });

  it('keeps exact-length issue details and a custom message under nested paths', () => {
    const row = z.array(z.number()).length(2, 'two only');
    const schema = z.object({ rows: z.array(row) });

    expect(issuesFor(schema, { rows: [[1, 2, 3]] })).toStrictEqual([
      { ...EXACTLY_TWO, path: ['rows', 0], message: 'two only' },
    ]);
  });

  it('still parses children and reports their errors before a minimum failure', () => {
    const schema = z.array(z.number()).min(2);

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
    const schema = z.array(z.number()).length(2);

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
    const base = z.array(z.string().trim());
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
    const schema = z.array(z.string().trim()).refine(refine).max(2);
    const input = [' a ', ' b ', ' c '];

    expect(schema.parse(input)).toStrictEqual(['a', 'b']);
    expect(refine).toHaveBeenCalledOnce();
    expect(input).toStrictEqual([' a ', ' b ', ' c ']);
  });

  it('does not hoist a length bound across superRefine either', () => {
    const schema = z.array(z.string().trim()).superRefine(shrink).length(2);

    expect(schema.parse([' a ', ' b ', ' c '])).toStrictEqual(['a', 'b']);
  });

  it('retains a leading cap through wrappers while preserving their own accepted values', () => {
    const bounded = z.array(z.number()).max(2);
    const wrapped = bounded.optional().nullable();
    const defaulted = bounded.default([1, 2, 3]);

    expect(issuesFor(wrapped, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
    expect([wrapped.parse(undefined), wrapped.parse(null)]).toStrictEqual([undefined, null]);
    expect(defaulted.parse(undefined)).toStrictEqual([1, 2, 3]);
    expect(issuesFor(defaulted, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
  });

  it('retains normal wrong-type and length diagnostics for non-array values', () => {
    const schema = z.array(z.number()).max(2);

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
    const nan = z.array(z.number()).max(Number.NaN).max(2);
    const negative = z.array(z.number()).max(-1).max(2);

    expect(issuesFor(nan, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
    expect(issuesFor(negative, [1, 2, 3])).toStrictEqual([TOO_BIG_TWO]);
  });

  it('keeps zero as an upper cap and infinity as an unbounded maximum', () => {
    const zero = z.array(z.number()).max(0);
    const infinite = z.array(z.number()).max(Number.POSITIVE_INFINITY);

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
    const schema = z.union([z.array(z.number()).max(2), z.string()]);

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
