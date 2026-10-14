import * as s from '@stayingupwind/core/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';

import { commitRequestSchema } from '../src/cache/index.ts';
import {
  jsonValuesWithin,
  MAX_LISTED_BYTES,
  safeParseBounded,
  safeParseValidated,
} from '../src/util/parse.ts';

const KIB = 1024;
const MIB = KIB * KIB;
/**
 * A commit whose outputs are nothing but `{}`, each lacking every field an output has. `safeParse`
 * lists every one of them: at this length, hundreds of mebibytes.
 */
const EMPTY_OUTPUTS_BYTES = 256 * KIB;
/** Far past what refusing the body above without its issues costs, far short of listing them. */
const HEAP_BUDGET_BYTES = 32 * MIB;

/** `{"generation":{"outputs":[{},{},…]}}`, as long as `bytes` allows. */
function emptyOutputs(bytes: number): { readonly text: string; readonly value: unknown } {
  const opening = '{"generation":{"outputs":[';
  const closing = ']}}';
  const count = Math.floor((bytes - opening.length - closing.length) / '{},'.length);
  const text = `${opening}${Array.from({ length: count }, () => '{}').join(',')}${closing}`;
  return { text, value: JSON.parse(text) };
}

describe('a body short enough to list its issues', () => {
  it('is refused with every issue safeParse finds', () => {
    const body = emptyOutputs(MAX_LISTED_BYTES);

    const parsed = safeParseBounded(commitRequestSchema, body.value, body.text.length);

    expect(parsed.success).toBe(false);
    expect(parsed.success ? undefined : parsed.error?.issues).toStrictEqual(
      commitRequestSchema.safeParse(body.value).error?.issues,
    );
  });
});

describe('a longer body', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Nothing is asked of `safeParse`, and so no issue is built: `validate` stops at the first output
   * and says only that it failed.
   */
  it('is refused without an issue built for each element that fails', () => {
    const body = emptyOutputs(EMPTY_OUTPUTS_BYTES);
    const safeParse = vi.spyOn(commitRequestSchema, 'safeParse');
    const before = process.memoryUsage().heapUsed;

    const parsed = safeParseBounded(commitRequestSchema, body.value, body.text.length);
    const grown = process.memoryUsage().heapUsed - before;

    expect(parsed).toStrictEqual({ success: false, error: undefined });
    expect(safeParse).not.toHaveBeenCalled();
    expect(grown).toBeLessThan(HEAP_BUDGET_BYTES);
  });

  it('that the schema takes is answered with what safeParse makes of it', () => {
    const item = z.object({ name: z.string() });
    const schema = z.object({ items: z.array(item) });
    const count = MAX_LISTED_BYTES;
    const value = {
      items: Array.from({ length: count }, (_, index) => ({ name: `n${index}`, extra: true })),
    };

    const parsed = safeParseBounded(schema, value, JSON.stringify(value).length);

    // What the schema does not name is dropped, as `safeParse` drops it.
    expect(parsed.success ? parsed.data.items.at(-1) : undefined).toStrictEqual({
      name: `n${count - 1}`,
    });
  });
});

describe("a longer body a schema of core's validator takes", () => {
  /**
   * Asked `validate` and then `safeParse`, every check of the schema ran twice for each value that
   * passed. A run as `validate` makes, through a value with nothing wrong in it, is the parse.
   */
  it('is checked once, and answered with what safeParse makes of it', () => {
    let checks = 0;
    const counted = s
      .string()
      .trim()
      .refine(() => {
        checks += 1;
        return true;
      });
    const schema = s.object({ items: s.array(s.object({ name: counted })) });
    const count = MAX_LISTED_BYTES;
    const value = { items: Array.from({ length: count }, (_, index) => ({ name: ` n${index} ` })) };

    const parsed = safeParseBounded(schema, value, JSON.stringify(value).length);

    expect(parsed.success ? parsed.data.items.at(-1) : undefined).toStrictEqual({
      name: `n${count - 1}`,
    });
    expect(checks).toBe(count);
  });
});

describe('a value checked by validate first', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is refused without its issues, however short', () => {
    const safeParse = vi.spyOn(commitRequestSchema, 'safeParse');

    const parsed = safeParseValidated(commitRequestSchema, { generation: { outputs: [{}] } });

    expect(parsed).toStrictEqual({ success: false, error: undefined });
    expect(safeParse).not.toHaveBeenCalled();
  });
});

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('jsonValuesWithin', () => {
  it('counts what a value opens and what separates two, up to the limit and not past it', () => {
    // An object, an array, three objects in it, the two commas between those and the one between
    // the object's members.
    const text = '{"env":[{},{},{}],"n":1}';

    expect(jsonValuesWithin(bytesOf(text), 8)).toBe(true);
    expect(jsonValuesWithin(bytesOf(text), 7)).toBe(false);
  });

  it('counts nothing inside a string, an escaped quote included', () => {
    const text = JSON.stringify({ value: String.raw`{[,]} \" {[,]}` });

    expect(jsonValuesWithin(bytesOf(text), 1)).toBe(true);
  });
});
