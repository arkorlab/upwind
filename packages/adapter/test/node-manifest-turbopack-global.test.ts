import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { dynamicNodeClosureRefusal } from '../src/node-closure-proof.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';

function source(body: string, parameter = 'ctx') {
  const code = `module.exports=[1,(${parameter})=>{${body}}];`;
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

describe('ordinary Turbopack global-origin inspection', () => {
  it.each([
    'const value=ctx.g.Math.max(1,2);ctx.v(value);',
    'const root=ctx.g;const value=root.Math.PI;ctx.v(value);',
    'const {Math:math}=ctx.g;const value=math.PI;ctx.v(value);',
    'const local=globalThis=>globalThis;ctx.v(local(ctx.g.Math.PI));',
    'const local={Function:value=>value};const {Function:ordinary}=local;ctx.v(ordinary(ctx.g.Math.PI));',
    'const value=ctx.g.process.env.NODE_ENV;ctx.v(value);',
    'return ctx.g.Math.PI;',
  ])('composes an ordinary read with the real host-closure validator: %s', (body) => {
    const original = source(body);
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');
    const inspection = `(()=>{${projection.source.code}});`;

    expect(dynamicNodeClosureRefusal('ordinary-inspection.js', inspection)).toBeUndefined();
    expect(projection.original).toStrictEqual(original);
    expect(projection.source.code).toContain('globalThis');
  });

  it.each([
    'typeof globalThis==="object"',
    'typeof globalThis=="object"',
    '"object"===typeof globalThis',
    '"object"==typeof globalThis',
  ])('keeps the primary OpenTelemetry fallback with the equivalent predicate %s', (predicate) => {
    const body = `const modules={460:(e,t)=>{Object.defineProperty(t,"__esModule",{value:true});t._globalThis=void 0;t._globalThis=${predicate}?globalThis:ctx.g}};ctx.v(modules);`;
    const original = source(body);
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(
      dynamicNodeClosureRefusal('ordinary-inspection.js', `(()=>{${projection.source.code}});`),
    ).toBeUndefined();
    expect(projection.original).toStrictEqual(original);
    expect(projection.exports).toStrictEqual({ kind: 'opaque' });
  });

  it('keeps the minified primary sequence and pure !0 marker without evaluating the module', () => {
    const body =
      'const modules={460:(e,t)=>{Object.defineProperty(t,"__esModule",{value:!0}),t._globalThis=void 0,t._globalThis="object"==typeof globalThis?globalThis:ctx.g}};ctx.v(modules);';
    const original = source(body);
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(
      dynamicNodeClosureRefusal('ordinary-inspection.js', `(()=>{${projection.source.code}});`),
    ).toBeUndefined();
    expect(projection.original).toStrictEqual(original);
  });

  it('does not confuse a nested parameter or named class with the stored-global receiver', () => {
    const body =
      'const target={};target._globalThis=typeof globalThis==="object"?globalThis:ctx.g;function ordinary(target){return target._globalThis;}const C=class target{method(){return target._globalThis;}};ctx.v([ordinary,C]);';
    const projection = projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies');

    expect(projection.exports).toStrictEqual({ kind: 'opaque' });
  });

  it.each([
    'target._globalThis.Function("source");',
    'target._globalThis.process.getBuiltinModule("module");',
    'const alias=target;alias._globalThis.Function("source");',
    'const value=target[unknown];ctx.v(value);',
    'const {_globalThis:root}=target;root.Function("source");',
    'const {Function:compile}=target._globalThis;compile("source");',
    'Reflect.get(target,"_globalThis").Function("source");',
    'consume(target);',
    'target=other;',
    '({target}=other);',
    'function later(){return target._globalThis;}',
    'target._globalThis+=1;',
    'delete target._globalThis;',
    'var target={};',
    'Object.defineProperty(target,"other",{get(){return this._globalThis;}});',
    'const Object={defineProperty(){}};Object.defineProperty(target,"__esModule",{value:true});',
    'Object.defineProperty(target,"__esModule",{value:1});',
    'Object.defineProperty(target,"__esModule",{value:!!1});',
    'this._globalThis.Function("source");',
    'arguments[0]._globalThis.Function("source");',
    'receiver.arguments[0]._globalThis.Function("source");',
  ])('does not lose host authority through a certified local slot: %s', (use) => {
    const body = `var target={};target._globalThis=void 0;target._globalThis=typeof globalThis==="object"?globalThis:ctx.g;${use}ctx.v(42);`;

    expect(() => projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js Turbopack manifest',
    );
  });

  it.each([
    'imported._globalThis=typeof globalThis==="object"?globalThis:ctx.g;',
    'const target=require("ordinary");target._globalThis=typeof globalThis==="object"?globalThis:ctx.g;',
    'const target=globalThis;target._globalThis=typeof globalThis==="object"?globalThis:ctx.g;',
  ])('does not certify an imported or global receiver: %s', (body) => {
    expect(() => projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js Turbopack manifest',
    );
  });

  it.each([
    'ctx.g.eval("source");',
    'ctx.g.Function("source");',
    'const root=ctx.g;const compile=root.Function;compile("source");',
    'Reflect.apply(ctx.g.Function,undefined,["source"]);',
    'const root=ctx.g;Reflect.apply(root.eval,undefined,["source"]);',
    'ctx.g.process.getBuiltinModule("module");',
    'ctx.g.process.mainModule.require("unknown");',
    'ctx.g.process.dlopen(module,"unknown");',
    'const host=ctx.g.process;host.getBuiltinModule("module");',
    'const {dlopen:load}=ctx.g.process;load(module,"unknown");',
    'const {eval:compile}=ctx.g;compile("source");',
    'const {Function:compile}=ctx.g;compile("source");',
    'const {process:host}=ctx.g;host.getBuiltinModule("module");',
    'const {globalThis:root}=ctx.g;root.Function("source");',
    'const {global:root}=ctx.g;root.eval("source");',
    'const {...root}=ctx.g;root.eval("source");',
    'const {[unknown]:value}=ctx.g;ctx.v(value);',
    'const root=ctx.g;const {Function:compile}=root;compile("source");',
    'let compile;({Function:compile}=ctx.g);compile("source");',
    'Reflect.get(ctx.g,"Function")("source");',
  ])('refuses compiler/loader authority after inspection normalization: %s', (body) => {
    expect(() => projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js Turbopack manifest',
    );
  });

  it.each([
    'const globalThis={Math};ctx.v(ctx.g.Math.PI);',
    'function read(globalThis){return ctx.g.Math.PI;}ctx.v(read);',
    'const C=class globalThis{method(){return ctx.g.Math.PI;}};ctx.v(C);',
    'ctx.g=other;',
    'ctx.g.value=1;',
    'ctx.g.value+=1;',
    'ctx.g.value++;',
    'delete ctx.g.value;',
    '({value:ctx.g.value}=other);',
    'const root=ctx.g;root.value=1;',
    'ctx.g[unknown];',
    'const root=ctx.g;root[unknown];',
    'ctx?.g;',
    'ctx.g?.Math;',
    'ctx.g.Math.max?.(1,2);',
    'const root=ctx.g;root.Math.max?.(1,2);',
    'consume(ctx.g);',
    'const root=ctx.g;consume(root);',
    'return ctx.g;',
    'const target={};target._globalThis=flag?globalThis:ctx.g;',
    'const target={};target.other=typeof globalThis==="object"?globalThis:ctx.g;',
    'const target=ctx.g;target._globalThis=typeof globalThis==="object"?globalThis:ctx.g;',
    'const target={};target._globalThis=typeof globalThis!=="object"?globalThis:ctx.g;',
    'const target={};target._globalThis="function"==typeof globalThis?globalThis:ctx.g;',
    'const target={};target._globalThis="object"==typeof other?globalThis:ctx.g;',
    'const target={};target._globalThis=typeof globalThis==other?globalThis:ctx.g;',
  ])('refuses capture, mutation, dynamic lookup or namespace escape: %s', (body) => {
    expect(() => projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js Turbopack manifest',
    );
  });

  it('does not capture a factory parameter named globalThis', () => {
    expect(() => {
      return projectNodeManifestTurbopackFactory(
        source('globalThis.v(globalThis.g.Math.PI);', 'globalThis'),
        1,
        'dependencies',
      );
    }).toThrow('shadowed inspection globalThis');
  });

  it('keeps data-field normalization out of strict protected consumers', () => {
    expect(() => projectNodeManifestTurbopackFactory(source('ctx.v(ctx.g.Math.PI);'), 1)).toThrow(
      'Unproved Next.js',
    );
  });

  it('keeps a g-free ordinary projection unchanged and preserves bare-context refusal', () => {
    const original = source('const value=globalThis.Math.PI;ctx.v(value);');
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(projection.source.code).toBe('const value=globalThis.Math.PI;ctx.v(value);\n');
    expect(() =>
      projectNodeManifestTurbopackFactory(source('const alias=ctx;'), 1, 'dependencies'),
    ).toThrow('context alias or escape');
  });
});
