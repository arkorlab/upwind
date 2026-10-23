import { describe, expect, it } from 'vitest';

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
