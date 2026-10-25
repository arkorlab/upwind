import { describe, expect, it } from 'vitest';

import { originalNodeSpecifiers } from '../src/node-source-specifiers.ts';

function specifiers(code: string, extension = 'cjs'): string[] {
  return originalNodeSpecifiers(`/project/entry.${extension}`, new TextEncoder().encode(code));
}

describe('original Node physical dependency discovery', () => {
  it.each(['ts', 'cts', 'mts'])(
    'discovers relative addon and package alias specifiers in raw %s',
    (extension) => {
      const code = [
        'import {Loader} from "package-alias";export type Shape=Loader;',
        'import type {TypeOnly} from "not-runtime";',
        'export {value} from "./exported.ts";',
        'export const native=()=>require("./addon.node") as unknown;',
        'export const lazy=()=>import("./lazy.mjs");',
      ].join('\n');

      expect(specifiers(code, extension)).toStrictEqual([
        'package-alias',
        './exported.ts',
        './addon.node',
        './lazy.mjs',
      ]);
    },
  );

  it.each(['0', '""', 'null', 'false', '0n'])(
    'omits only the impossible primitive literal branch for %s',
    (condition) => {
      const code = `if(${condition})require("./dead.node");else require("./live.node");`;

      expect(specifiers(code)).toStrictEqual(['./live.node']);
    },
  );

  it.each(['1', '"0"', 'true', '1n'])(
    'retains the selected truthy primitive literal branch for %s',
    (condition) => {
      const code = `if(${condition})require("./live.node");else require("./dead.node");`;

      expect(specifiers(code)).toStrictEqual(['./live.node']);
    },
  );

  it.each([
    ['conditional', '0 ? require("./dead.node") : require("./live.node");'],
    ['false conjunction', '"" && require("./dead.node");require("./live.node");'],
    ['true disjunction', '"truthy" || require("./dead.node");require("./live.node");'],
    ['required conjunction', '1 && require("./live.node");'],
    ['required disjunction', '0 || require("./live.node");'],
    ['absent else', 'if(0)require("./dead.node");require("./live.node");'],
  ])('keeps the same finite primitive semantics for %s', (_name, code) => {
    expect(specifiers(code)).toStrictEqual(['./live.node']);
  });

  it.each([
    'process.env.NATIVE',
    'settings.enabled',
    'choose()',
    '(sideEffect(),0)',
    '({valueOf(){sideEffect();return 0;}})',
    '/literal/',
    '-1',
    'undefined',
    'NaN',
  ])('does not evaluate an unproved condition %s', (condition) => {
    const code = `if(${condition})require("./one.node");else require("./two.node");`;

    expect(specifiers(code)).toStrictEqual(['./one.node', './two.node']);
  });

  it('keeps dependency loads in an unknown condition and both of its branches', () => {
    const code = 'if(require("./condition.cjs"))require("./one.node");else require("./two.node");';

    expect(specifiers(code)).toStrictEqual(['./condition.cjs', './one.node', './two.node']);
  });

  it('does not infer a runtime file from explicit type-only imports or rewrite raw source', () => {
    const raw = new TextEncoder().encode(
      'import type {Value} from "only-types";export const x:number=1;',
    );
    const before = new Uint8Array(raw);

    expect(originalNodeSpecifiers('/project/entry.ts', raw)).toStrictEqual([]);
    expect(raw).toStrictEqual(before);
  });

  it.each(['json', 'txt', 'tsx', 'jsx'])(
    'preserves the existing data and unshipped raw %s boundary',
    (extension) => {
      expect(specifiers('require("./not-executable.node");', extension)).toStrictEqual([]);
    },
  );
});
