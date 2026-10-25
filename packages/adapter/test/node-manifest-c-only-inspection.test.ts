import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';

const CLEAR = 'globalThis.__next__clear_chunk_cache__=ctx.C;';

function source(body: string, clear = true) {
  const code = `module.exports=[1,ctx=>{${clear ? CLEAR : ''}${body}}];`;
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

function project(body: string, clear = true) {
  return projectNodeManifestTurbopackFactory(source(body, clear), 1, 'dependencies');
}

describe('original Node global inspection beside a proved C scaffold', () => {
  it.each([
    'globalThis.fetch=patchedFetch;ctx.v(42);',
    'function patch(patchedFetch){globalThis.fetch=patchedFetch;}ctx.v(patch);',
    'function patch(patchedFetch){globalThis.fetch=patchedFetch;return result;}ctx.v(patch);',
    'const FLAG=Symbol.for("next-patch");globalThis.fetch=patchedFetch;globalThis[FLAG]=true;ctx.v(globalThis[FLAG]===true);',
  ])('retains untouched original fetch-patch code and source identity: %s', (body) => {
    const projected = project(body);

    expect(projected.original).toStrictEqual(source(body));
    expect(projected.source.code.trim()).toBe(`void 0;${body}`);
    expect(projected.imports).toStrictEqual([]);
    expect(projected.boundRuntimeInputs).toStrictEqual([]);
  });

  it.each([
    ['Function("return process")();ctx.v(42);', 'JavaScript code compiler'],
    ['eval("arbitrarySource");ctx.v(42);', 'JavaScript code compiler'],
    ['globalThis.Function("return process")();ctx.v(42);', 'JavaScript code compiler'],
    ['globalThis.fetch=globalThis.Function;ctx.v(42);', 'JavaScript code compiler'],
    ['process.getBuiltinModule("module");ctx.v(42);', 'Node module loader'],
    ['globalThis.fetch=process.getBuiltinModule;ctx.v(42);', 'Node module loader'],
    ['const Module=require("node:module");Module._load(dynamic);ctx.v(42);', 'Node module loader'],
    ['const vm=require("node:vm");vm.runInThisContext(code);ctx.v(42);', 'Node module loader'],
    [
      'const child=require("node:child_process");child.exec(command);ctx.v(42);',
      'Node module loader',
    ],
    ['ctx.v(require("node:module"));', 'Node Module namespace escape'],
  ])('still applies the full ordinary Node closure refusal to %s', (body, reason) => {
    expect(() => project(body)).toThrow(reason);
  });

  it.each([
    'const root=globalThis;ctx.v(root.fetch);',
    'globalThis[unknown]=patchedFetch;ctx.v(42);',
    'Reflect.get(globalThis,unknown);ctx.v(42);',
    'ctx.v(globalThis.__next__clear_chunk_cache__);',
    'globalThis.__next__clear_chunk_cache__=other;ctx.v(42);',
    'globalThis.__next__clear_chunk_cache__();ctx.v(42);',
    'ctx.v(this);',
    'ctx.v(arguments);',
    'ctx.v(import.meta.url);',
    'const FLAG=Symbol.for("next-patch");ctx.v(globalThis[FLAG]===true);globalThis.Symbol.for=unknown;',
    'const STORE=Symbol.for("@next/request-insights-store");const globalStore=globalThis;globalStore[STORE]??=new Store();ctx.v(42);',
  ])('retains C slot, namespace, implicit-receiver and unknown-key refusals: %s', (body) => {
    expect(() => project(body)).toThrow('Unproved Next.js');
  });

  it('keeps actual ctx.g rewrites on the stronger normalized-global inspection path', () => {
    const body = 'const pid=ctx.g.process.pid;ctx.v(pid);';
    const projected = project(body);

    expect(projected.original).toStrictEqual(source(body));
    expect(projected.source.code).toContain('globalThis.process.pid');
  });

  it.each([true, false])('keeps a mixed g/global-write profile strict with C=%s', (clear) => {
    const body = 'const pid=ctx.g.process.pid;globalThis.fetch=patchedFetch;ctx.v(pid);';

    expect(() => project(body, clear)).toThrow('global context write');
  });

  it('does not change protected strict projection', () => {
    expect(() =>
      projectNodeManifestTurbopackFactory(source('globalThis.fetch=patchedFetch;'), 1),
    ).toThrow('Unproved Next.js');
  });
});
