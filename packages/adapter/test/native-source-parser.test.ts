import { describe, expect, it } from 'vitest';

import { nativeSourceAnalysis, parseNativeSource } from '../src/native-source-parser.ts';
import { originalNodeHostLoaderAnalysis } from '../src/node-original-host-proof.ts';
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
    ['entry.mts', 'if(process.env.DISABLED)return;'],
    ['entry.cjs', 'module.exports='],
    ['entry.cts', 'const value: = 1;'],
    ['entry.tsx', 'export const view=<div>;'],
  ])('refuses unparsed executable source in %s', (file, source) => {
    expect(() => parseNativeSource(source, file)).toThrow('cannot parse an executable module');
  });

  it.each(['entry.ts', 'entry.cts', 'entry.mts', 'entry.tsx'])(
    'analyzes emitted JavaScript rather than type declarations in %s',
    (file) => {
      const source =
        'declare const module: {require: (name:string)=>unknown}; export const load=(name:string)=>module.require(name);';
      const analysis = originalNodeHostLoaderAnalysis(file, source);
      const site = analysis.sites[0]!;

      expect(analysis.code).not.toContain('declare const');
      expect(analysis.sites).toHaveLength(1);
      expect(analysis.code.slice(site.start, site.end)).toContain('module.require');
    },
  );

  it.each([
    [
      'cast',
      'exports.load=(name:string)=>(module as unknown as {constructor:any}).constructor._load(name);',
    ],
    ['generic call', 'declare function consume<T>(value:unknown):void;consume<number>(module);'],
    ['enum initializer', 'export enum Value { Native=module.require("./unowned") }'],
    [
      'namespace initializer',
      'namespace Value { export const Native=module.require("./unowned") }exports.value=Value;',
    ],
    ['TSX child', 'export const view=<span>{module.constructor._load(input)}</span>;'],
  ])('retains the runtime host authority in a TypeScript %s', (_title, source) => {
    const analysis = originalNodeHostLoaderAnalysis('entry.tsx', source);

    expect(analysis.sites.length).toBeGreaterThan(0);
    expect(analysis.code).toContain('module');
  });

  it('does not treat genuine typed parameters as the CommonJS host', () => {
    const source =
      'exports.run=(module:{require:(name:string)=>unknown})=>module.require("./local");';
    const analysis = originalNodeHostLoaderAnalysis('entry.ts', source);

    expect(analysis.sites).toStrictEqual([]);
  });

  it('does not invent runtime operations from erased ambient and type-only declarations', () => {
    const source =
      'declare enum Value { First }type Host=typeof module;export const answer:number=42;';
    const analysis = originalNodeHostLoaderAnalysis('entry.ts', source);

    expect(analysis.sites).toStrictEqual([]);
    expect(analysis.code).not.toContain('enum');
  });

  it('keeps original JavaScript bytes and offsets when no syntax lowering is needed', () => {
    const source = 'exports.load=name=>module.require(name);';
    const analysis = nativeSourceAnalysis(source, 'entry.cjs');

    expect(analysis.code).toBe(source);
    expect(analysis.program.body).toHaveLength(1);
  });

  it('checks decoded reserved identifiers after TypeScript syntax lowering', () => {
    const source = String.raw`const __UPWIND_ORI\u0047INAL_HOST_LOADER__:unknown=undefined;exports.load=name=>module.require(name);`;

    expect(() => originalNodeHostLoaderAnalysis('entry.cts', source)).toThrow(
      'Reserved original host analysis marker',
    );
  });

  it.each(['entry.ts', 'entry.mts', 'entry.tsx'])(
    'preserves implicit value imports in raw Node analysis while removing explicit import type in %s',
    (file) => {
      const implicit = 'import {Loader} from "./side-effect.js";export type Shape=Loader;';
      const explicit = 'import type {Loader} from "./type-only.js";export type Shape=Loader;';
      const kept = nativeSourceAnalysis(implicit, file);
      const removed = nativeSourceAnalysis(explicit, file);

      expect(kept.program.body.some((node) => node.type === 'ImportDeclaration')).toBe(true);
      expect(kept.code).toContain('./side-effect.js');
      expect(removed.program.body.some((node) => node.type === 'ImportDeclaration')).toBe(false);
      expect(removed.code).not.toContain('./type-only.js');
    },
  );

  it('keeps Worker placement import elision separate from conservative raw Node analysis', () => {
    const source = 'import {Loader} from "./side-effect.js";export type Shape=Loader;';
    const node = nativeSourceAnalysis(source, 'entry.ts');
    const worker = nativeSourceAnalysis(source, 'entry.ts', { target: 'worker' });

    expect(node.code).toContain('./side-effect.js');
    expect(worker.code).not.toContain('./side-effect.js');
  });
});
