import { describe, expect, it } from 'vitest';

import * as z from '../src/schema/index.ts';

describe('boundary parsing', () => {
  it('stops a list at its first continuable issue without changing ordinary parsing', () => {
    let checks = 0;
    const item = z.string().superRefine((_value, ctx) => {
      checks += 1;
      ctx.addIssue({ code: 'custom', message: 'refused' });
      ctx.addIssue({ code: 'custom', message: 'another issue' });
    });
    const schema = z.array(item);
    const first = schema.safeParseFirst(['a', 'b', 'c']);

    expect(first.success).toBe(false);
    expect(first.error?.issues).toHaveLength(1);
    expect(checks).toBe(1);
    expect(schema.safeParse(['a', 'b', 'c']).error?.issues).toHaveLength(6);
  });

  it('keeps transformations and valid union alternatives, running successful checks once', () => {
    let checks = 0;
    const value = z
      .string()
      .trim()
      .refine(() => {
        checks += 1;
        return true;
      });
    const schema = z.union([z.number(), z.object({ value })]);

    expect(schema.safeParseFirst({ value: ' yes ' })).toStrictEqual({
      success: true,
      data: { value: 'yes' },
    });
    expect(checks).toBe(1);
  });

  it('stops objects, records, and checks on their first problem', () => {
    const schema = z.object({ values: z.record(z.string(), z.string().min(2).min(3)) });
    const parsed = schema.safeParseFirst({ values: { a: '', b: '' } });

    expect(parsed.error?.issues).toHaveLength(1);
    expect(parsed.error?.issues[0]?.path).toStrictEqual(['values', 'a']);

    const strict = z.strictObject({}).safeParseFirst({ a: true, b: true });

    expect(strict.error?.issues[0]?.keys).toStrictEqual(['a']);
  });
});

describe('selected shared inputs', () => {
  it('validates a shared table root once and preserves its parsed identity', () => {
    let checks = 0;
    const table = z.array(
      z
        .string()
        .trim()
        .refine(() => {
          checks += 1;
          return true;
        }),
    );
    const schema = z.object({ a: table, b: table });
    const input = [' one ', ' two '];
    const parsed = schema.parseShared({ a: input, b: input }, new WeakSet([input]));

    expect(parsed.a).toBe(parsed.b);
    expect(parsed.a).toStrictEqual(['one', 'two']);
    expect(checks).toBe(2);
  });

  it('separates schemas and calls, never trusting a previous result after mutation', () => {
    const input = [' one '];
    const roots = new WeakSet([input]);
    const schema = z.object({ a: z.array(z.string().trim()), b: z.array(z.string()) });
    const first = schema.parseShared({ a: input, b: input }, roots);

    expect(first.a).toStrictEqual(['one']);
    expect(first.b).toStrictEqual([' one ']);
    expect(first.a).not.toBe(first.b);

    input[0] = ' two ';
    const second = schema.parseShared({ a: input, b: input }, roots);

    expect(second.a).toStrictEqual(['two']);
    expect(second.a).not.toBe(first.a);
  });
});
