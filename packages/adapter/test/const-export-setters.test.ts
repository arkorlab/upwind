import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

import { constExportSettersPlugin, constSetterBodies } from '../src/const-export-setters.ts';
import { edgeBundleOptions } from '../src/edge.ts';

/**
 * Turbopack's module fragments (`experimental.turbopackModuleFragments`, Next.js 16.4) register
 * every export of a module with a setter, a `const` export's among them: `e.s(["b",()=>r,e=>r=e])`.
 * Node.js runs such a chunk, since the assignment is only an error if it is made; Rolldown refuses
 * to bundle it (`ILLEGAL_REASSIGNMENT`), and the Function did not build (`treeshake-mw`,
 * `turbopack-tree-shaking-chunkgroup`, `turbopack-tree-shaking-pages`).
 */

/** A module factory as Turbopack writes one with module fragments: its exports, getter and setter. */
const FACTORY =
  'e=>{const r={level:"log"};let n=1;function t(){return"k"}' +
  'e.s(["b",()=>r,e=>r=e,"c",()=>n,e=>n=e,"getKey",()=>t,e=>t=e])}';

function bodiesIn(code: string): string[] {
  return constSetterBodies(code).map(({ start, end }) => code.slice(start, end));
}

describe('the setters Turbopack gives a module’s exports', () => {
  it('are found where they assign a const binding, and nowhere else', () => {
    expect(bodiesIn(`module.exports=[[1,${FACTORY}]];`)).toStrictEqual(['r=e']);
  });

  it.each<[string, string]>([
    ['a function’s own', 'function f(){let r=2;return[()=>r,e=>r=e]}'],
    ['a block’s own', '{let r=2;e.s(["r",()=>r,e=>r=e])}'],
    ['a `var` hoisted out of a block', 'function f(){if(f){var r=2}return[()=>r,e=>r=e]}'],
    ['a caught error', 'try{f()}catch(r){e.s(["r",()=>r,e=>r=e])}'],
    ['a loop’s', 'for(let r of f())e.s(["r",()=>r,e=>r=e])'],
    ['a class’s static block', 'class C{static{var r=2;e.s(["r",()=>r,e=>r=e])}}'],
  ])('read a name as the scope it is used in declares it: %s', (_, inner) => {
    const shadowed = `module.exports=[[1,e=>{const r=1;function f(){return[]}${inner}}]];`;

    expect(bodiesIn(shadowed)).toStrictEqual([]);
  });

  /** A class's static block keeps its `var`s: one there shadows nothing outside it. */
  it('are found past a static block’s own `var` of the same name', () => {
    const outside =
      'module.exports=[[1,e=>{const r=1;class C{static{var r=2}}e.s(["r",()=>r,e=>r=e])}]];';

    expect(bodiesIn(outside)).toStrictEqual(['r=e']);
  });

  it('are found inside a block that declares other names', () => {
    expect(
      bodiesIn('module.exports=[[1,e=>{const r=1;{let n=2;e.s(["r",()=>r,e=>r=e])}}]];'),
    ).toStrictEqual(['r=e']);
  });

  it('are found by the positions the chunk is edited at, past text of more than one byte', () => {
    const wide = `module.exports=[[1,e=>{const s="日本語の文";const r=1;e.s(["r",()=>r,e=>r=e])}]];`;

    expect(bodiesIn(wide)).toStrictEqual(['r=e']);
  });

  it('are not found outside a list, where nothing registers them', () => {
    expect(bodiesIn('const r=1;const set=e=>r=e;')).toStrictEqual([]);
  });
});

/** A chunk that runs its factory against a registry of what it exports, as Turbopack's runtime would. */
const CHUNK = `
const registry = {};
const e = {
  s(list) {
    for (let at = 0; at < list.length; at += 3) {
      registry[list[at]] = { get: list[at + 1], set: list[at + 2] };
    }
  },
};
(${FACTORY})(e);
export { registry };
`;

async function chunkFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'adapter-setters-'));
  const file = path.join(dir, 'chunk.mjs');
  await writeFile(file, CHUNK);
  return file;
}

describe('the bundles the rewrite is made in', () => {
  /** An edge route's chunks, and an edge middleware's, are Turbopack's module fragments too. */
  it('include the edge bundle, as well as the app bundle', () => {
    const plugins = edgeBundleOptions('/project', '/project/entry.cjs', () => {
      // Nothing is bundled here.
    }).plugins as { name: string }[];

    expect(plugins.map((plugin) => plugin.name)).toContain('arkor-const-export-setters');
  });
});

describe('a Function bundle of a chunk with such setters', () => {
  it('is refused by Rolldown as Turbopack wrote it', async () => {
    const input = await chunkFile();
    await using bundle = await rolldown({ input });

    await expect(bundle.generate({ format: 'esm' })).rejects.toThrow(/reassign/iu);
  });

  it('is built, and runs as Node.js runs the chunk: the setter throws as the assignment would', async () => {
    const input = await chunkFile();
    await using bundle = await rolldown({ input, plugins: [constExportSettersPlugin()] });
    const { output } = await bundle.generate({ format: 'esm' });
    const out = path.join(path.dirname(input), 'out.mjs');
    await writeFile(out, output[0].code);
    const { registry } = (await import(out)) as {
      registry: Record<string, { get: () => unknown; set: (value: unknown) => void }>;
    };

    registry['c']?.set(2);

    expect(registry['b']?.get()).toStrictEqual({ level: 'log' });
    expect(() => registry['b']?.set(2)).toThrow(new TypeError('Assignment to constant variable.'));
    expect(registry['c']?.get()).toBe(2);
    expect(registry['getKey']?.get()).toBeTypeOf('function');
  });
});

describe('constant export setter lexical scopes', () => {
  it.each([
    { source: 'const value=1; registry([p=>value=p]);', expected: ['value=p'] },
    { source: 'let value=1; registry([p=>value=p]);', expected: [] },
    { source: 'const {value}=input; registry([p=>value=p]);', expected: ['value=p'] },
    { source: 'const value=1; {let value=2; registry([p=>value=p]);}', expected: [] },
    { source: 'const value=1; function f(value){registry([p=>value=p]);}', expected: [] },
    {
      source: 'const value=1; function f(){registry([p=>value=p]); var value;}',
      expected: [],
    },
    {
      source: 'const value=1; function f(){const value=2; registry([p=>value=p]);}',
      expected: ['value=p'],
    },
    {
      source: 'const value=1; for(let value of input){registry([p=>value=p]);}',
      expected: [],
    },
    {
      source: 'const value=1; try{}catch(value){registry([p=>value=p]);}',
      expected: [],
    },
  ])('preserves the existing declaration lookup for $source', ({ source, expected }) => {
    const assignments = constSetterBodies(source).map(({ start, end }) => source.slice(start, end));

    expect(assignments).toStrictEqual(expected);
  });
});
