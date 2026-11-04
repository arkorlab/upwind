import { parseSync, rawTransferSupported } from 'oxc-parser';
import { parseAst } from 'rolldown/parseAst';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseChunk } from '../src/chunk-ast.ts';

// Both parsers as they are, counted: which one answered is what these cases are about.
vi.mock(import('rolldown/parseAst'), async (importOriginal) => {
  const original = await importOriginal();
  return { ...original, parseAst: vi.fn(original.parseAst) };
});
vi.mock(import('oxc-parser'), async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    parseSync: vi.fn(original.parseSync),
    rawTransferSupported: vi.fn(original.rawTransferSupported),
  };
});

const RAW_TRANSFER_SUPPORTED = rawTransferSupported();

/**
 * A tree as text, its literal values included: `parseAst` answers a BigInt or a RegExp as the value
 * itself, which `JSON.stringify` refuses or empties.
 */
function textOf(tree: unknown): string {
  return JSON.stringify(tree, (_key, value: unknown) => {
    if (typeof value === 'bigint') return `${String(value)}n`;
    if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
    return value;
  });
}

/** What `parseAst` throws for a chunk whose tree is past the longest string V8 makes. */
function pastTheLongestString(): Error {
  return new Error('Failed to convert rust `String` into napi `string`');
}

/** The options a raw-transfer parse is asked with: `parseAst`'s own, and the buffer. */
const RAW_TRANSFER = { experimentalRawTransfer: true, lang: 'js', preserveParens: false } as const;

/** Statements in one body past what raw transfer's deserializer takes (`body.push(...)`). */
const STATEMENTS_PAST_RAW_TRANSFER = 200_000;

/** What a bundled chunk holds: the forms whose nodes the two parsers could have told apart. */
const CHUNKS = {
  parenthesized: 'var a = (b, (c = d)), e = ((f)) ? (g) : h;\nexports.x = (0, a.b)(c);',
  literals: `const big = 123n, re = /a[b-c]+/giu, s = "\\u00e9\\n", t = \`x\${big}y\`, n = 1e3;`,
  'non-ASCII text': 'const é = "日本語"; // コメント\nmodule.exports = { é, "🙂": 1 };',
  'module syntax':
    'import a, { b as c } from "x";\nexport default class extends a { #d = c; static { this.e = 1; } }',
  'CommonJS wrapper':
    '"use strict";\n(function (exports, require, module) {\n  const m = require("m");\n  module.exports = async function* () { for await (const x of m) yield* x; };\n})(exports, require, module);',
};

describe('a whole chunk’s syntax tree', () => {
  beforeEach(() => {
    vi.mocked(parseAst).mockClear();
    vi.mocked(parseSync).mockClear();
    vi.mocked(rawTransferSupported).mockClear();
  });

  it('preserves parseAst’s error where raw transfer is unsupported', () => {
    const code = CHUNKS.parenthesized;
    const error = pastTheLongestString();
    vi.mocked(rawTransferSupported).mockReturnValueOnce(false);
    vi.mocked(parseAst).mockImplementationOnce(() => {
      throw error;
    });

    expect(() => parseChunk(code)).toThrow(error);
    expect(parseAst).toHaveBeenCalledExactlyOnceWith(code);
    expect(rawTransferSupported).toHaveBeenCalledOnce();
    expect(parseSync).not.toHaveBeenCalled();
  });

  it('is parseAst’s, with no raw transfer, for a chunk parseAst reads', () => {
    const code = CHUNKS.parenthesized;

    const tree = parseChunk(code);

    expect(parseSync).not.toHaveBeenCalled();
    expect(parseAst).toHaveBeenCalledExactlyOnceWith(code);
    expect(textOf(tree)).toBe(textOf(parseAst(code)));
  });

  it.skipIf(!RAW_TRANSFER_SUPPORTED).each(Object.entries(CHUNKS))(
    'is the tree parseAst answers, through raw transfer where parseAst throws, for %s',
    (_form, code) => {
      vi.mocked(parseAst).mockImplementationOnce(() => {
        throw pastTheLongestString();
      });

      const tree = parseChunk(code);

      expect(parseSync).toHaveBeenCalledExactlyOnceWith('file.js', code, RAW_TRANSFER);
      expect(textOf(tree)).toBe(textOf(parseAst(code)));
    },
  );

  it.skipIf(!RAW_TRANSFER_SUPPORTED)(
    'refuses with parseAst’s error a chunk raw transfer cannot read either',
    () => {
      // Raw transfer spreads a body's statements into one call, which 200,000 are past.
      const code = `function f() {\n${'a;\n'.repeat(STATEMENTS_PAST_RAW_TRANSFER)}}`;
      vi.mocked(parseAst).mockImplementationOnce(() => {
        throw pastTheLongestString();
      });

      expect(() => parseChunk(code)).toThrow(/napi/u);
      expect(parseSync).toHaveBeenCalledExactlyOnceWith('file.js', code, RAW_TRANSFER);
    },
  );

  it('refuses a chunk that does not parse as parseAst does', () => {
    const code = 'const a = ;';

    expect(() => parseChunk(code)).toThrow(/Parse failed/u);
    expect(parseAst).toHaveBeenCalledExactlyOnceWith(code);
  });
});
