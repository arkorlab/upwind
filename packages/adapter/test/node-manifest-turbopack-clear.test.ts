import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';

const CLEAR = 'globalThis.__next__clear_chunk_cache__=ctx.C;';

function source(body: string) {
  const code = `module.exports=[1,((ctx)=>{${body}})];`;
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

describe('fixed production chunk-cache hook inspection', () => {
  it.each([
    CLEAR,
    'ctx.g.__next__clear_chunk_cache__=ctx.C;',
    `(${CLEAR.slice(0, -1)},sideEffect());`,
    `(sideEffect(),${CLEAR.slice(0, -1)});`,
    `(first(),(${CLEAR.slice(0, -1)},last()));`,
    '(ctx.g.__next__clear_chunk_cache__=ctx.C,sideEffect());',
    `const ordinary=globalThis.console;${CLEAR}ctx.v(ordinary);`,
    `${CLEAR}function local(globalThis){return globalThis.__next__clear_chunk_cache__;}ctx.v(local);`,
    `${CLEAR}const C=class globalThis{method(){return globalThis.__next__clear_chunk_cache__;}};ctx.v(C);`,
    `${CLEAR}const __next__clear_chunk_cache__=()=>42;ctx.v(__next__clear_chunk_cache__());`,
    `${CLEAR}function local(ctx){return ctx.C;}ctx.v(local);`,
    `${CLEAR}function local(arguments){return arguments.value;}ctx.v(local);`,
  ])('normalizes only the certified producer assignment in dependencies mode: %s', (body) => {
    const original = source(body);
    const projected = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(projected.original).toStrictEqual(original);
    expect(projected.source.code).toContain('void 0');
    expect(projected.source.code).not.toContain('=ctx.C');
    expect(projected.boundRuntimeInputs).toStrictEqual([]);
    expect(projected.imports).toStrictEqual([]);
  });

  it('keeps an actual static dependency edge beside the inert hook inspection', () => {
    const original = source(`${CLEAR}var value=ctx.r(2);ctx.v(value);`);
    const projected = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(projected.imports).toStrictEqual([
      { kind: 'require', specifier: 'turbopack:2', targetId: 2 },
    ]);
    expect(projected.original.sha256).toBe(original.sha256);
    expect(projected.requiresReviewedRuntime).toBe(true);
  });

  it.each([
    ['context alias', 'const clear=ctx.C;globalThis.__next__clear_chunk_cache__=clear;'],
    ['wrong slot', 'globalThis.other=ctx.C;'],
    ['computed slot', 'globalThis["__next__clear_chunk_cache__"]=ctx.C;'],
    ['optional context', 'globalThis.__next__clear_chunk_cache__=ctx?.C;'],
    ['bound context hook', 'globalThis.__next__clear_chunk_cache__=ctx.C.bind(ctx);'],
    ['conditional assignment', `if(flag){${CLEAR}}`],
    ['deferred assignment', `function later(){${CLEAR}}ctx.v(later);`],
    ['conditional sequence', `flag&&(${CLEAR.slice(0, -1)},sideEffect());`],
    ['call argument sequence', `consume((${CLEAR.slice(0, -1)},value));`],
    ['returned sequence', `return (${CLEAR.slice(0, -1)},value);`],
    ['slot value read', `${CLEAR}ctx.v(globalThis.__next__clear_chunk_cache__);`],
    [
      'slot call without a stable identity proof',
      `${CLEAR}globalThis.__next__clear_chunk_cache__();`,
    ],
    [
      'slot constructor',
      `${CLEAR}globalThis.__next__clear_chunk_cache__.constructor("return process")();`,
    ],
    ['slot alias', `${CLEAR}const clear=globalThis.__next__clear_chunk_cache__;clear();`],
    ['global alias', `${CLEAR}const root=globalThis;root.__next__clear_chunk_cache__();`],
    ['context global alias', `${CLEAR}const root=ctx.g;root.__next__clear_chunk_cache__();`],
    [
      'global destructuring',
      `${CLEAR}const {__next__clear_chunk_cache__:clear}=globalThis;clear();`,
    ],
    ['reflective read', `${CLEAR}Reflect.get(globalThis,"__next__clear_chunk_cache__")();`],
    ['dynamic global key', `${CLEAR}ctx.v(globalThis[key]);`],
    ['optional global read', `${CLEAR}ctx.v(globalThis?.__next__clear_chunk_cache__);`],
    ['implicit global read', `${CLEAR}__next__clear_chunk_cache__();`],
    [
      'implicit global this',
      `${CLEAR}function leak(){return this.__next__clear_chunk_cache__.constructor("return process")();}ctx.v(leak);`,
    ],
    [
      'reflective implicit global this',
      `${CLEAR}function leak(){return Reflect.get(this,"__next__clear_chunk_cache__").constructor("return process")();}ctx.v(leak);`,
    ],
    ['implicit arguments', `${CLEAR}function leak(){return arguments.callee;}ctx.v(leak);`],
    [
      'super receiver',
      `${CLEAR}class Derived extends Base{method(){return super.value;}}ctx.v(Derived);`,
    ],
    ['import metadata', `${CLEAR}ctx.v(import.meta.url);`],
    ['constructor metadata', `${CLEAR}function leak(){return new.target;}ctx.v(leak);`],
    ['extra write', `${CLEAR}globalThis.__next__clear_chunk_cache__=other;`],
    ['duplicate initialization', `${CLEAR}${CLEAR}`],
    ['delete', `${CLEAR}delete globalThis.__next__clear_chunk_cache__;`],
    ['global rebinding', `${CLEAR}globalThis=other;`],
    [
      'shadowed global',
      'function f(globalThis){globalThis.__next__clear_chunk_cache__=ctx.C;}ctx.v(f);',
    ],
    ['unknown context method', `${CLEAR}ctx.unreviewed(value);`],
    ['dynamic import id', `${CLEAR}ctx.r(userInput);`],
    ['known compiler', `${CLEAR}globalThis.Function("return process")();`],
    ['known process loader', `${CLEAR}globalThis.process.getBuiltinModule("module");`],
  ])('refuses %s rather than introducing a callable or loader exemption', (_name, body) => {
    expect(() => projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js',
    );
  });

  it.each([CLEAR, 'ctx.g.__next__clear_chunk_cache__=ctx.C;'])(
    'leaves protected strict projection refusal unchanged: %s',
    (body) => {
      expect(() => projectNodeManifestTurbopackFactory(source(body), 1)).toThrow(
        'Unproved Next.js',
      );
    },
  );
});
