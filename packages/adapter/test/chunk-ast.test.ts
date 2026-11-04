import { rawTransferSupported } from 'oxc-parser';
import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { parseChunk } from '../src/chunk-ast.ts';

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
  it.each(Object.entries(CHUNKS))('is the tree parseAst answers, for %s', (_form, code) => {
    expect(textOf(parseChunk(code))).toBe(textOf(parseAst(code)));
  });

  it('refuses a chunk that does not parse as parseAst does', () => {
    const code = 'const a = ;';

    expect(() => parseChunk(code)).toThrow(/Parse failed/u);
    expect(() => parseAst(code)).toThrow(/Parse failed/u);
  });

  it('reads with raw transfer here, which hands the tree over in a buffer', () => {
    expect(rawTransferSupported()).toBe(true);
  });
});
