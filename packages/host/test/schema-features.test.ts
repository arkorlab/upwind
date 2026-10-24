import { describe, expect, it } from 'vitest';
import * as zod from 'zod';

import * as s from '../../core/src/schema/index.ts';
import { type Answering, outcome } from './fixtures/schema-parity.ts';

/**
 * core's validator against zod, a feature at a time: each case builds one schema with either
 * library from the same code, and both have to give the same answer to every value listed — what
 * passes, what is returned, byte for byte and key for key, what is reported and how it is worded,
 * and what `validate` says. `schema-parity.test.ts` does the same for every schema a module
 * exports; this is what those schemas use, each part on its own, including what none of them
 * happens to meet.
 */

type Library = typeof s;
/** zod, read through the validator's types: every case uses only what both have. */
const ZOD = zod as unknown as Library;

interface Case {
  readonly name: string;
  readonly schema: (z: Library) => Answering;
  readonly inputs: readonly unknown[];
}

/** An object made by a class: an object to an object schema, not one to a record. */
class Instance {
  readonly a = 'from a class';
}

/** An array of `length` holes, with a value at some of them. */
function sparse(length: number, values: Readonly<Record<number, unknown>> = {}): unknown[] {
  const list: unknown[] = [];
  list.length = length;
  for (const [index, value] of Object.entries(values)) {
    list[Number(index)] = value;
  }
  return list;
}

/** A schema whose refusal of `{ a: 1, b: [] }` lists two issues. */
function twoIssues(z: Library): Answering & { parse: (value: unknown) => unknown } {
  return z.object({ a: z.string(), b: z.array(z.number()).min(1) });
}

const inherited: unknown = Object.create({ inherited: 'x' });
const ownProto: unknown = JSON.parse('{"__proto__": "x", "c": "y"}');
const symbolKeyed = { [Symbol('s')]: 1, ok: 'x' };
const withHidden = Object.defineProperty({ ok: 'x' }, 'hidden', { value: 1, enumerable: false });

const CASES: readonly Case[] = [
  {
    name: 'object: absent optional, present undefined, default filled, unknown key stripped',
    schema: (z) => z.object({ a: z.string().optional(), b: z.number().default(1), c: z.string() }),
    inputs: [
      {},
      { c: 'x' },
      { a: undefined, c: 'x' },
      { b: undefined, c: 'x' },
      { c: 'x', extra: 1 },
      { c: 1, a: 2 },
      null,
      [],
      'x',
      new Instance(),
    ],
  },
  {
    name: 'object: strict refuses each unknown key, loose keeps them',
    schema: (z) =>
      z.union([z.strictObject({ a: z.string() }), z.looseObject({ b: z.number().int() })]),
    inputs: [{ a: 'x' }, { a: 'x', z: 1, y: 2 }, { b: 1, z: 1 }, { b: 1.5, z: 1 }, {}],
  },
  {
    name: 'object: inherited and `__proto__` keys, symbol and hidden keys',
    schema: (z) => {
      return z.union([
        z.looseObject({ inherited: z.string().optional(), c: z.string().optional() }),
        z.strictObject({ ok: z.string() }),
      ]);
    },
    inputs: [inherited, ownProto, symbolKeyed, withHidden, Object.create(null)],
  },
  {
    name: 'object: a required key that takes undefined, and refinements of the whole',
    schema: (z) => {
      return z
        .object({ a: z.unknown(), b: z.string().nullable() })
        .refine((value) => value.b !== 'no', { message: 'not no', path: ['b'] })
        .superRefine((value, ctx) => {
          if (value.b === 'fatal') {
            ctx.addIssue({ code: 'custom', message: 'fatal', fatal: true });
          } else if (value.b === 'string') {
            ctx.addIssue('as a string');
          }
        });
    },
    inputs: [
      {},
      { a: 1 },
      { a: 1, b: null },
      { a: 1, b: 'no' },
      { a: 1, b: 'fatal' },
      { b: 'string' },
    ],
  },
  {
    name: 'object: extend over fields, omit, strict',
    schema: (z) => {
      return z
        .object({ a: z.string(), b: z.number() })
        .extend({ b: z.string() })
        .omit({ a: true })
        .strict();
    },
    inputs: [{ b: 'x' }, { b: 1 }, { a: 'x', b: 'x' }, {}],
  },
  {
    name: 'string: lengths in code points, after a type error too',
    schema: (z) => z.string().min(2).max(3),
    inputs: [
      'a',
      'ab',
      'abcd',
      '😀',
      '😀😀',
      '\u{D800}\u{D800}',
      1,
      { length: 1 },
      [1],
      [1, 2, 3, 4],
      null,
    ],
  },
  {
    name: 'string: exact length, prefix, pattern with a global flag, trim in chain order',
    schema: (z) => z.string().trim().length(3).startsWith('a').regex(/b/gu),
    inputs: ['abc', ' abc ', 'ab', 'abcd', 'xbc', 'acc', 'abb', ''],
  },
  {
    name: 'string: checks before trim see the untrimmed value',
    schema: (z) => z.string().max(3).trim(),
    inputs: ['abc', ' abc ', ' '.repeat(4), ''],
  },
  {
    name: 'url and datetime',
    schema: (z) => z.object({ url: z.url().optional(), at: z.iso.datetime().optional() }),
    inputs: [
      { url: 'https://example.com' },
      { url: ' https://exa\tmple.com/\n' },
      { url: 'not a url' },
      { url: '' },
      { at: '2026-10-10T08:20:02Z' },
      { at: '2026-10-10T08:20:02.123456Z' },
      { at: '2026-10-10T08:20Z' },
      { at: '2026-10-10T08:20:02+09:00' },
      { at: '2026-02-29T00:00:00Z' },
      { at: '2024-02-29T00:00:00Z' },
    ],
  },
  {
    name: 'number: not finite, integers, bounds, and what follows a failed int',
    schema: (z) => z.number().int().positive().lte(10).gt(1),
    inputs: [0, 1, 2, 10, 11, 1.5, -1, NaN, Infinity, -Infinity, 2 ** 53, '1', null],
  },
  {
    name: 'number: nonnegative, min, max, coerced',
    schema: (z) => z.object({ a: z.number().nonnegative().max(5), b: z.coerce.number().min(1) }),
    inputs: [
      { a: 0, b: '1' },
      { a: -0, b: '' },
      { a: 6, b: 'x' },
      { a: 1, b: null },
      { a: 1, b: [] },
    ],
  },
  {
    name: 'literal, enum, boolean, null, unknown',
    schema: (z) => {
      return z.object({
        literal: z.literal(['a', 1, true, null]).optional(),
        enum: z.enum(['x', 'y']).optional(),
        boolean: z.boolean().optional(),
        null: z.null().optional(),
        unknown: z.unknown(),
      });
    },
    inputs: [
      { unknown: 1 },
      { literal: 'a', enum: 'x', boolean: false, null: null },
      { literal: 'b' },
      { literal: 1n },
      { enum: 'z' },
      { boolean: 0 },
      { null: undefined },
    ],
  },
  {
    name: 'array: elements, lengths, after a type error',
    schema: (z) => z.array(z.number()).min(1).max(2),
    inputs: [[], [1], [1, 2], [1, 2, 3], ['a'], ['a', 'b', 'c'], 'ab', { length: 0 }, null],
  },
  {
    name: 'record: plain objects only, keys checked, values parsed',
    schema: (z) => z.record(z.string().min(2), z.number()),
    inputs: [
      {},
      { ab: 1 },
      { a: 1 },
      { ab: 'x' },
      { a: 'x', bc: 2 },
      [],
      new Instance(),
      new Map(),
      ownProto,
      symbolKeyed,
      withHidden,
      Object.create(null),
    ],
  },
  {
    name: 'record: a key that reads as a number, refused as a string',
    schema: (z) => z.record(z.string().min(2), z.string()),
    inputs: [{ 1: 'x' }, { 12: 'x' }, { '-1': 'x' }, { '1.5': 'x' }, { NaN: 'x' }],
  },
  {
    name: 'strict object: an own `__proto__` key is one it does not know',
    schema: (z) => z.strictObject({ c: z.string() }),
    inputs: [ownProto, { c: 'y' }, JSON.parse('{"__proto__": {"c": 1}}')],
  },
  {
    name: 'union: two objects that fail only on checks are reported together',
    schema: (z) =>
      z.union([z.object({ a: z.string().min(3) }), z.object({ a: z.string().max(1) })]),
    inputs: [{ a: 'ab' }, { a: 'abc' }, { a: 'a' }, { a: 1 }, {}],
  },
  {
    name: 'superRefine: a path, a fatal issue, an issue that stops what follows',
    schema: (z) => {
      return z.object({
        a: z
          .string()
          .superRefine((value, ctx) => {
            if (value.includes('p')) {
              ctx.addIssue({ code: 'custom', message: 'p', path: ['inner', 0] });
            }
            if (value.includes('f')) {
              ctx.addIssue({ code: 'custom', message: 'f', fatal: true });
            }
            if (value.includes('c')) {
              ctx.addIssue({ code: 'custom', message: 'c', continue: false });
            }
          })
          .min(5),
        b: z
          .number()
          .optional()
          .refine((value) => value !== undefined, 'b is missing'),
      });
    },
    inputs: [
      { a: 'p' },
      { a: 'f' },
      { a: 'c' },
      { a: 'pfc' },
      { a: 'okay!' },
      { a: 'okay!', b: 1 },
    ],
  },
  {
    name: 'coerced number: what `Number()` makes of anything, and what it throws on',
    schema: (z) => z.coerce.number().int(),
    inputs: [
      '1',
      '',
      ' 2 ',
      '1e3',
      '0x10',
      1n,
      true,
      null,
      undefined,
      [],
      [5],
      {},
      Symbol('x'),
      new Map(),
    ],
  },
  {
    name: 'array: holes read as undefined',
    schema: (z) => z.array(z.string().optional()),
    inputs: [sparse(2, { 1: 'a' }), sparse(3, { 0: 'a', 2: 'b' }), sparse(2)],
  },
  {
    name: 'union: the first that passes, one continuable failure as is, otherwise all',
    schema: (z) => z.union([z.string().min(3), z.number(), z.object({ a: z.string() })]),
    inputs: ['abc', 'a', 1, { a: 'x' }, { a: 1 }, null, true],
  },
  {
    name: 'discriminated union: picked by the field, a miss lists the values',
    schema: (z) => {
      const either = z.union([z.literal('d'), z.literal('e')]).optional();
      return z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), a: z.string() }),
        z.object({ kind: z.enum(['b', 'c']), b: z.number() }),
        z.object({ kind: either, d: z.boolean() }),
      ]);
    },
    inputs: [
      { kind: 'a', a: 'x' },
      { kind: 'a', a: 1 },
      { kind: 'c', b: 1 },
      { kind: 'd', d: true },
      { d: true },
      { kind: 'z' },
      { kind: 1 },
      {},
      null,
      [],
    ],
  },
  {
    name: 'template literal',
    schema: (z) => z.templateLiteral(['segment:', z.string(), '.', 1]),
    inputs: ['segment:x.1', 'segment:.1', 'segment:x.2', 'segment:x', 'other:x.1', 1, null],
  },
  {
    name: 'wrappers: nullish, default of a function and of an object, nullable of a default',
    schema: (z) => {
      return z.object({
        a: z.string().nullish(),
        b: z.array(z.string()).default(() => ['made']),
        c: z.object({ x: z.number() }).default({ x: 1 }),
        d: z.number().default(2).nullable(),
      });
    },
    inputs: [
      {},
      { a: null, b: ['given'], c: { x: 2 }, d: null },
      { a: 1 },
      { b: 'x' },
      { c: {} },
      { d: undefined },
    ],
  },
  {
    name: 'refine on a field: string form, message and path, what continues after it',
    schema: (z) => {
      return z.object({
        a: z
          .string()
          .refine((value) => value !== 'x', 'not x')
          .refine((value) => value !== 'y', { message: 'not y', path: ['deeper'] })
          .max(1),
      });
    },
    inputs: [{ a: 'x' }, { a: 'y' }, { a: 'zz' }, { a: 'xx' }, { a: 'a' }, { a: 1 }],
  },
];

describe('core validator against zod, a feature at a time', () => {
  it.each(CASES)('$name', ({ schema, inputs }) => {
    const ours = schema(s);
    const theirs = schema(ZOD);
    for (const input of inputs) {
      expect(outcome(ours, input)).toBe(outcome(theirs, input));
    }
  });

  it('names an error as its issues, as zod does', () => {
    const ours = twoIssues(s).safeParse({ a: 1, b: [] });
    const theirs = twoIssues(ZOD).safeParse({ a: 1, b: [] });
    const message = (theirs.error as Error | undefined)?.message;

    expect(ours.error).toBeInstanceOf(s.SchemaError);
    expect((ours.error as Error | undefined)?.message).toBe(message);
    expect(JSON.stringify(ours.error)).toBe(JSON.stringify({ name: 'SchemaError', message }));
    expect(() => twoIssues(s).parse(null)).toThrow(s.SchemaError);
  });

  it('hands each parse a fresh copy of a default, as zod does', () => {
    for (const z of [s, ZOD]) {
      const schema = z.object({
        list: z.array(z.string()).default(['a']),
        made: z.object({ x: z.number() }).default(() => ({ x: 1 })),
      });
      const first = schema.parse({});
      const second = schema.parse({});

      expect(first.list).not.toBe(second.list);
      expect(first.made).not.toBe(second.made);
      expect(first).toStrictEqual(second);
    }
  });

  it('keeps one shape, its fields the schemas it was given', () => {
    const field = s.string();
    const schema = s.object({ a: field });

    expect(schema.shape.a).toBe(field);
    expect(schema.shape).toBe(schema.shape);
    expect(schema.extend({}).shape.a).toBe(field);
  });
});
