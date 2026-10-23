import * as s from '@stayingupwind/core/schema';
import { describe, expect, it } from 'vitest';

import { toZod } from '../src/zod/to-zod.ts';

/**
 * `toZod` makes of each of core's schemas the zod schema the same source would have built, check for
 * check: it is held here to take, return and report what core's does, value for value — whether a
 * value passes, what it comes out as, the issues of one that does not, and what `validate` says.
 */

/** What a schema of either kind is asked. */
interface Asked {
  safeParse: (value: unknown) => {
    readonly success: boolean;
    readonly data?: unknown;
    readonly error?: { readonly issues: unknown } | undefined;
  };
  validate: (value: unknown) => boolean;
}

/** A schema's whole answer to one value. */
function answer(schema: Asked, value: unknown): unknown {
  const parsed = schema.safeParse(value);
  return {
    valid: schema.validate(value),
    ...(parsed.success ? { data: parsed.data } : { issues: parsed.error?.issues }),
  };
}

/** Core's answers to `values`, and zod's, through `toZod`. */
function bothAnswers(
  schema: s.Schema,
  values: readonly unknown[],
): { readonly core: unknown[]; readonly zod: unknown[] } {
  const zod = toZod(schema) as unknown as Asked;
  return {
    core: values.map((value) => answer(schema, value)),
    zod: values.map((value) => answer(zod, value)),
  };
}

const evenOnly = s.number().refine((value) => value % 2 === 0, 'must be even');
const ordered = s.object({ from: s.number(), to: s.number() }).superRefine((range, ctx) => {
  if (range.to < range.from) {
    ctx.addIssue({ code: 'custom', message: 'ends before it starts', path: ['to'] });
  }
});
const kinded = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('a'), count: s.number() }),
  s.object({ kind: s.literal('b') }),
]);

/** Each kind of schema core's validator makes, and the values each is asked. */
const CASES: readonly (readonly [string, s.Schema, readonly unknown[]])[] = [
  ['a bounded string', s.string().min(2).max(4), ['ab', 'abcd', 'a', 'abcde', 7, undefined]],
  ['a string of an exact length', s.string().length(2), ['ab', 'a', 'abc', null]],
  [
    'a trimmed string, by prefix and pattern',
    s
      .string()
      .trim()
      .startsWith('/')
      .regex(/^\/[a-z]*$/u, 'lower-case path'),
    ['  /ab ', '/AB', 'ab', '/', 5],
  ],
  ['a URL', s.url(), ['https://example.com/', ' https://example.com/a\tb\n ', 'not a url', '', 1]],
  [
    'a date and time',
    s.iso.datetime(),
    ['2026-10-10T08:20:02Z', '2026-10-10T08:20:02.25Z', '2026-10-10', '2026-02-30T00:00:00Z'],
  ],
  [
    'a bounded integer',
    s.number().int().nonnegative().max(10),
    [0, 10, 11, -1, 1.5, NaN, Infinity, '1', 2 ** 60],
  ],
  ['a number coerced', s.coerce.number().positive(), ['3', 3, '-1', 'x', null, true]],
  ['a boolean', s.boolean(), [true, false, 0, 'true']],
  ['null', s.null(), [null, undefined, 0]],
  ['anything', s.unknown(), [undefined, null, { a: 1 }]],
  ['one of literals', s.literal(['a', 1, null]), ['a', 1, null, 'b', 2]],
  ['one of words', s.enum(['x', 'y']), ['x', 'y', 'z', 1]],
  [
    'an object, keys it does not name dropped',
    s.object({ name: s.string(), count: s.number().optional() }),
    [{ name: 'x' }, { name: 'x', count: 1, other: 2 }, { count: 1 }, null, []],
  ],
  [
    'a strict object',
    s.strictObject({ name: s.string() }),
    [{ name: 'x' }, { name: 'x', other: 1 }],
  ],
  ['a loose object', s.looseObject({ name: s.string() }), [{ name: 'x', other: 1 }, {}]],
  ['a bounded list', s.array(s.number()).min(1).max(2), [[1], [1, 2, 3], [], ['x'], 'x']],
  [
    'an oversized list with invalid elements',
    s.array(s.number()).min(10).max(2, 'at most two'),
    [['x', 'y', 'z'], [1, 2, 3], [1], 'not an array'],
  ],
  [
    'an exact list with a later refinement',
    s
      .array(s.number())
      .length(2, 'exactly two')
      .refine(() => false, 'after parsing'),
    [['x', 'y', 'z'], [1, 2, 3], [1], [1, 2]],
  ],
  [
    'a list whose upper bound follows a refinement',
    s
      .array(s.number())
      .refine(() => true)
      .max(1),
    [[1, 2], ['x', 'y'], [1]],
  ],
  [
    'a parent refinement after an oversized list',
    s.object({ entries: s.array(s.number()).max(1) }).refine(() => false, 'after parsing'),
    [{ entries: ['x', 'y'] }, { entries: [1, 2] }, { entries: [1] }],
  ],
  [
    'a record of named keys',
    s.record(s.string().regex(/^[a-z]+$/u), s.number()),
    [{ a: 1 }, { A: 1 }, { a: 'x' }, [], null],
  ],
  ['one of two types', s.union([s.string(), s.number()]), ['x', 1, true, null]],
  [
    'one of kinds',
    kinded,
    [{ kind: 'a', count: 1 }, { kind: 'b' }, { kind: 'c' }, { kind: 'a' }, {}],
  ],
  ['an optional string', s.string().optional(), ['x', undefined, null]],
  ['a nullable string', s.string().nullable(), ['x', null, undefined]],
  ['a nullish string', s.string().nullish(), ['x', null, undefined, 1]],
  [
    'an object with defaults',
    s.object({ label: s.string().default('none'), flags: s.array(s.string()).default(['a']) }),
    [{}, { label: 'x', flags: [] }, { label: 1 }],
  ],
  ['a refined number', evenOnly, [2, 3, 'x']],
  [
    'a refined object',
    ordered,
    [
      { from: 1, to: 2 },
      { from: 2, to: 1 },
      { from: 'x', to: 1 },
    ],
  ],
  [
    'a template of text and strings',
    s.templateLiteral(['v', 1, '-', s.string()]),
    ['v1-x', 'v1-', 'v2-x', 'v1x', 1],
  ],
  [
    'a template of other primitives',
    s.templateLiteral([null, ':', true, ':', 7n]),
    ['null:true:7', 'null:false:7', 'x'],
  ],
  [
    'a string counted in code points',
    s.string().min(2).max(2),
    ['😀😀', '😀', 'ab', '😀😀😀', '\u{D800}a'],
  ],
];

describe('toZod', () => {
  it.each(CASES)('answers for %s what core does', (_, schema, values) => {
    const { core, zod } = bothAnswers(schema, values);

    expect(zod).toStrictEqual(core);
  });

  /** As core's `url()` does: trimmed, and tabs and newlines taken out of what is returned. */
  it('returns a URL as core does, trimmed and without its tabs and newlines', () => {
    const value = ' https://example.com/a\tb\n ';

    expect(toZod(s.url()).parse(value)).toBe('https://example.com/ab');
    expect(s.url().parse(value)).toBe('https://example.com/ab');
  });

  /** As core's `defaultValue()` does: a fresh copy each time, so one changed changes no other. */
  it('fills in a list or an object default afresh for each value', () => {
    const schema = s.object({ flags: s.array(s.string()).default(['a']) });
    const zod = toZod(schema);

    const first = zod.parse({});
    first.flags.push('changed');

    expect(zod.parse({}).flags).toStrictEqual(['a']);
    expect(schema.parse({}).flags).toStrictEqual(['a']);
  });

  /** As core's do: a character outside the basic plane is one, though it is two UTF-16 units. */
  it('counts a string’s length in code points', () => {
    expect(toZod(s.string().max(1)).safeParse('😀').success).toBe(true);
    expect(s.string().max(1).safeParse('😀').success).toBe(true);
  });
});
