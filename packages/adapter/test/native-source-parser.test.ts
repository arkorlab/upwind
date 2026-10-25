import { describe, expect, it } from 'vitest';

import { parseNativeSource } from '../src/native-source-parser.ts';
import { originalNodeSpecifiers } from '../src/node-source-specifiers.ts';

describe('native capability source parsing', () => {
  it.each(['entry.cjs', 'entry.js'])(
    'retains the closed dependency lookup after a CommonJS top-level return in %s',
    (file) => {
      const source = "if(process.env.DISABLED)return;module.exports=require('./addon.node');";
      const tree = parseNativeSource(source, file);

      expect(tree.body).toHaveLength(2);
      expect(originalNodeSpecifiers(file, new TextEncoder().encode(source))).toStrictEqual([
        './addon.node',
      ]);
    },
  );

  it('accepts explicit ESM without turning it into a CommonJS script', () => {
    const program = parseNativeSource("export {default} from './addon.node';", 'entry.mjs');

    expect(program.sourceType).toBe('module');
  });

  it.each([
    ['entry.mjs', 'if(process.env.DISABLED)return;'],
    ['entry.cjs', 'module.exports='],
  ])('refuses unparsed executable source in %s', (file, source) => {
    expect(() => parseNativeSource(source, file)).toThrow('cannot parse an executable module');
  });
});
