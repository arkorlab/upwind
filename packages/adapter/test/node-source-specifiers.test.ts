import { describe, expect, it } from 'vitest';

import {
  originalNodeSpecifierInventory,
  originalNodeSpecifiers,
} from '../src/node-source-specifiers.ts';

function specifiers(code: string, extension = 'cjs'): string[] {
  return originalNodeSpecifiers(`/project/entry.${extension}`, new TextEncoder().encode(code));
}

describe('original Node physical dependency discovery', () => {
  it('keeps env-pruned layout hints separate from the unchanged required production inventory', () => {
    const raw = new TextEncoder().encode(
      [
        `require('./mutator.cjs');`,
        `if(process.env.NODE_ENV!=='production')require('./alternate.cjs');else require('./required.cjs');`,
        `process.env.NEXT_RUNTIME==='nodejs'||import('alternate-package');`,
        `if(false)require('primitive-dead');`,
      ].join('\n'),
    );
    const before = new Uint8Array(raw);

    expect(originalNodeSpecifierInventory('/project/entry.cjs', raw)).toStrictEqual({
      required: ['./mutator.cjs', './required.cjs'],
      alternatives: ['./alternate.cjs', 'alternate-package'],
    });
    expect(originalNodeSpecifiers('/project/entry.cjs', raw)).toStrictEqual([
      './mutator.cjs',
      './required.cjs',
    ]);
    expect(raw).toStrictEqual(before);
  });

  it('keeps nested literal-dead code excluded and explores both env alternatives only as hints', () => {
    const raw = new TextEncoder().encode(
      `if(process.env.NODE_ENV!=='production'){if(false)require('never');if(process.env.NEXT_RUNTIME==='nodejs')require('first');else require('second');}`,
    );

    expect(originalNodeSpecifierInventory('/project/entry.cjs', raw)).toStrictEqual({
      required: [],
      alternatives: ['first', 'second'],
    });
  });

  it.each([
    'settings.enabled',
    'process.env.CUSTOM',
    `(effect(),process.env.NODE_ENV==='production')`,
  ])('never demotes an unproved condition to a layout-only hint: %s', (condition) => {
    const raw = new TextEncoder().encode(`if(${condition})require('one');else require('two');`);

    expect(originalNodeSpecifierInventory('/project/entry.cjs', raw)).toStrictEqual({
      required: ['one', 'two'],
      alternatives: [],
    });
  });

  it.each([
    'exports.label=require=>require("/label");',
    'function label(require){return require("/label");}',
    'function require(value){return value;}exports.label=require("/label");',
    'const label=function require(){return require("/label");};',
    '{const require=value=>value;exports.label=require("/label");}',
    'try{label();}catch(require){require("/label");}',
    'function label(){require("/label");var require=value=>value;}',
    'function label(){require("/label");if(false){var require=value=>value;}}',
  ])('does not treat a lexical require binding as the CJS loader: %s', (code) => {
    expect(specifiers(code)).toStrictEqual([]);
  });

  it('preserves genuine CJS loader calls outside independent local/block/catch shadows', () => {
    const code = [
      'require("./first.node");',
      'function local(require){return require("/label");}',
      '{let require=value=>value;require("/label");}',
      'try{local();}catch(require){require("/label");}',
      'function later(){return require("./nested.node");}',
      'require("package-alias");',
    ].join('\n');

    expect(specifiers(code)).toStrictEqual(['./first.node', './nested.node', 'package-alias']);
  });

  it.each(['js', 'ts', 'mts'])(
    'keeps actual import edges while excluding an imported require function in %s',
    (extension) => {
      const code = 'import require from "./local-loader.mjs";export const label=require("/label");';

      expect(specifiers(code, extension)).toStrictEqual(['./local-loader.mjs']);
    },
  );

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

  it.each(['js', 'cjs', 'mjs', 'ts', 'cts', 'mts'])(
    'omits a development-only package under the fixed production %s environment',
    (extension) => {
      const code = [
        `if(process.env.NODE_ENV !== 'production') require('dev-only');`,
        `if(process.env.NEXT_RUNTIME === 'edge') require('edge-only');`,
        `if(process.env.NODE_ENV === 'production') require('./production.node');`,
        `if(process.env.NEXT_RUNTIME === 'nodejs') require('node-runtime');`,
      ].join('\n');

      expect(specifiers(code, extension)).toStrictEqual(['./production.node', 'node-runtime']);
    },
  );

  it.each([
    `process.env['NODE_ENV'] !== 'production'`,
    `'production' !== process['env'].NODE_ENV`,
    `process['env']['NEXT_RUNTIME'] !== 'nodejs'`,
    `!(process.env.NODE_ENV === 'production')`,
    `!process.env.NEXT_RUNTIME`,
  ])('uses only finite pure fixed-environment comparisons for %s', (condition) => {
    const code = `if(${condition})require('dev-only');else require('./live.node');`;

    expect(specifiers(code)).toStrictEqual(['./live.node']);
  });

  it('uses fixed environment conditions in ternaries and short-circuit discovery without changing input bytes', () => {
    const bytes = new TextEncoder().encode(
      [
        `process.env.NODE_ENV !== 'production' ? require('dev-only') : require('./live.node');`,
        `process.env.NEXT_RUNTIME === 'edge' && require('edge-only');`,
        `process.env.NODE_ENV === 'production' || require('development-only');`,
      ].join('\n'),
    );
    const before = new Uint8Array(bytes);

    expect(originalNodeSpecifiers('/project/entry.cjs', bytes)).toStrictEqual(['./live.node']);
    expect(bytes).toStrictEqual(before);
  });

  it.each([
    `process.env.CUSTOM_MODE === 'production'`,
    `(sideEffect(), process.env.NODE_ENV !== 'production')`,
    `(require('./condition.cjs'), process.env.NEXT_RUNTIME === 'edge')`,
    `process.env.NODE_ENV.startsWith('dev')`,
    `process?.env.NODE_ENV !== 'production'`,
    `process.env[mode()] !== 'production'`,
  ])(
    'visits unknown, optional or effectful environment conditions conservatively: %s',
    (condition) => {
      const code = `if(${condition})require('./one.node');else require('./two.node');`;
      const expected = condition.includes('condition.cjs')
        ? ['./condition.cjs', './one.node', './two.node']
        : ['./one.node', './two.node'];

      expect(specifiers(code)).toStrictEqual(expected);
    },
  );

  it.each([
    `const env=process.env;env.NODE_ENV='development';`,
    `const p=process;p.env.NODE_ENV='development';`,
    `const {env}=process;env.NODE_ENV='development';`,
    `handoff(process.env);`,
    `handoff(process);`,
    `process.env.NODE_ENV='development';`,
    `function later(){process.env.NEXT_RUNTIME='edge';}`,
    `for(process.env.NODE_ENV of ['development']){}`,
    `({mode:process.env.NODE_ENV}=settings);`,
    `Object.defineProperty(process.env,'NODE_ENV',{value:'development'});`,
    `const p=globalThis.process;p.env.NODE_ENV='development';`,
    `const p=require('node:process');p.env.NODE_ENV='development';`,
  ])(
    'keeps both branches after an observable process/env alias, handoff or write: %s',
    (prefix) => {
      const code = `${prefix}if(process.env.NODE_ENV!=='production')require('./one.node');else require('./two.node');`;
      const expected = prefix.includes('node:process')
        ? ['node:process', './one.node', './two.node']
        : ['./one.node', './two.node'];

      expect(specifiers(code)).toStrictEqual(expected);
    },
  );

  it.each([
    `function run(process){if(process.env.NODE_ENV!=='production')require('./one.node');else require('./two.node');}`,
    `const process=settings;if(process.env.NEXT_RUNTIME==='edge')require('./one.node');else require('./two.node');`,
    `{let process=settings;if(process.env.NODE_ENV!=='production')require('./one.node');else require('./two.node');}`,
  ])('retains conditions on a genuinely shadowed process binding', (code) => {
    expect(specifiers(code)).toStrictEqual(['./one.node', './two.node']);
  });

  it('keeps a shadowed process independent of a genuine fixed global condition', () => {
    const code = [
      `function local(process){if(process.env.NODE_ENV!=='production')require('local-one');else require('local-two');}`,
      `if(process.env.NODE_ENV!=='production')require('dev-only');else require('./production.node');`,
      `if(process.env.CUSTOM_MODE)require('custom-one');else require('custom-two');`,
    ].join('\n');

    expect(specifiers(code)).toStrictEqual([
      'local-one',
      'local-two',
      './production.node',
      'custom-one',
      'custom-two',
    ]);
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
