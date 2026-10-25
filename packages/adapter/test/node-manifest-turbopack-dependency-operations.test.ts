import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { nodeManifestTurbopackEntryGraph } from '../src/node-manifest-turbopack-graph.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackModuleId,
} from '../src/node-manifest-turbopack.ts';

const DIST = '/project/.next';
const ENTRY = `${DIST}/server/pages/native.js`;
const RUNTIME = `${DIST}/server/chunks/runtime.js`;
const TABLE = `${DIST}/server/chunks/table.js`;

function source(code: string) {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
function registration(body: string, ids = '1') {
  return source(`module.exports=[${ids},((ctx)=>{${body}})];`);
}
function project(body: string) {
  return projectNodeManifestTurbopackFactory(registration(body), 1, 'dependencies');
}
function graph(body: string) {
  const dependencies: readonly NodeManifestTurbopackModuleId[] = [2];
  const children = dependencies.map((id) => `${jsLiteral(id)},((ctx)=>{ctx.v(42);})`).join(',');
  return nodeManifestTurbopackEntryGraph({
    distDir: DIST,
    entry: { file: ENTRY, page: '/native', pathname: '/native', kind: 'pages' },
    sources: [
      {
        id: ENTRY,
        file: ENTRY,
        source: source(
          'var R=require("../chunks/runtime.js")("server/pages/native.js");R.c("server/chunks/table.js");module.exports=R.m(1).exports;',
        ),
        imports: [{ specifier: '../chunks/runtime.js', target: RUNTIME }],
      },
      {
        id: RUNTIME,
        file: RUNTIME,
        source: source('module.exports=unprovedRuntime;'),
        imports: [{ specifier: TABLE, target: TABLE }],
      },
      {
        id: TABLE,
        file: TABLE,
        source: source(`module.exports=[1,((ctx)=>{${body}}),${children}];`),
        imports: [],
      },
    ],
  });
}

describe('compact reexport dependency inspection', () => {
  it.each([
    'ctx.S([2,"default","f","named","A",0,"2","other","f"]);',
    'ctx.S([2,"default,f,named,A",0,"2","other,f"]);',
  ])('retains typed dependency order and original bytes for %s', (body) => {
    const projected = project(body);

    expect(projected.imports).toStrictEqual([
      { kind: 'import', specifier: 'turbopack:2', targetId: 2 },
      { kind: 'import', specifier: 'turbopack:string:"2"', targetId: '2' },
    ]);
    expect(projected.exports).toStrictEqual({ kind: 'opaque' });
    expect(projected.source.code.trim()).toBe(body);
    expect(projected.original).toStrictEqual(registration(body));
    expect(() => projectNodeManifestTurbopackFactory(registration(body), 1)).toThrow(
      'Unproved Next.js',
    );
  });

  it('keeps empty-group instantiation, a zero head and repeated source heads as dependencies', () => {
    const body = 'ctx.S([0,0,2,0,"2",0,2,"named,value"]);';
    const projected = project(body);

    expect(projected.imports.map((item) => item.targetId)).toStrictEqual([0, 2, '2', 2]);
    expect(projected.source.code.trim()).toBe(body);
    expect(projected.exports).toStrictEqual({ kind: 'opaque' });
  });

  it('accepts literal comma-containing names only through the uncompressed pair spelling', () => {
    const projected = project('ctx.S([2,"export,comma","source,comma"]);');

    expect(projected.imports).toStrictEqual([
      { kind: 'import', specifier: 'turbopack:2', targetId: 2 },
    ]);
    expect(projected.exports).toStrictEqual({ kind: 'opaque' });
  });

  it.each(['', ',null', ',undefined', ',void 0', ',1', ',"1"'])(
    'accepts only the existing default or owned literal export target %s',
    (target) => {
      const body = `ctx.S([2,"default,value"]${target});`;
      const projected = projectNodeManifestTurbopackFactory(
        registration(body, '1,"1"'),
        '1',
        'dependencies',
      );

      expect(projected.exports).toStrictEqual({ kind: 'opaque' });
      expect(projected.imports.map((item) => item.targetId)).toStrictEqual([2]);
      expect(projected.source.code.trim()).toBe(body);
    },
  );

  it('records the complete static source edge without certifying the destination namespace', () => {
    const inspected = graph('ctx.S([2,"named,value"]);');
    const own = inspected.factories.find((factory) => factory.id === inspected.exportedId);
    const child = inspected.factories.find((factory) => factory.projection.moduleId === 2);

    expect(own?.imports).toStrictEqual([{ specifier: 'turbopack:2', target: child?.id }]);
    expect(own?.projection.exports).toStrictEqual({ kind: 'opaque' });
    expect(inspected.requiresReviewedRuntime).toBe(true);
    expect(inspected.requiresSdkNormalization).toBe(true);
  });

  it.each(['ctx.S([3,"named,value"]);', 'ctx.S([3,0,2,"named,value"]);'])(
    'refuses an unregistered source, including a dependency-only empty group: %s',
    (body) => {
      expect(() => graph(body)).toThrow('unregistered module dependency');
    },
  );

  it.each([
    'ctx.S();',
    'ctx.S(table);',
    'ctx.S([namespace,"name,value"]);',
    'ctx.S([{get value(){return hidden;}},"name,value"]);',
    'ctx.S([()=>hidden,"name,value"]);',
    'ctx.S([2,...names]);',
    'ctx.S([2,,"value"]);',
    'ctx.S([2,"name",()=>hidden]);',
    'ctx.S([2,"name",dynamic]);',
    'ctx.S([2,"name",`value`]);',
    'ctx.S([2,"name,value,extra"]);',
    'ctx.S([2,"name,value",0,3,"name,other"]);',
    'ctx.S([2,"name","value","name","other"]);',
    'ctx.S([dynamic,"name,value"]);',
    'ctx.S([-1,"name,value"]);',
    'ctx.S([1.5,"name,value"]);',
    'ctx.S([`2`,"name,value"]);',
    'ctx.S(["","name,value"]);',
    'ctx.S([2,"name,value"],2);',
    'ctx.S([2,"name,value"],dynamic);',
    'ctx.S([2,"name,value"],1,true);',
    'ctx.S(...args);',
    'ctx.S?.([2,"name,value"]);',
    'ctx?.S([2,"name,value"]);',
    'ctx["S"]([2,"name,value"]);',
    'const compact=ctx.S;compact([2,"name,value"]);',
    'ctx.S.call(ctx,[2,"name,value"]);',
    'function later(undefined){ctx.S([2,"name,value"],undefined);}',
    'ctx=other;ctx.S([2,"name,value"]);',
  ])('refuses a dynamic, namespace, duplicate or escaping registration: %s', (body) => {
    expect(() => project(body)).toThrow('Unproved Next.js');
  });

  it('never turns compact reexports into strict namespace-forwarding authority', () => {
    const original = registration(
      'var namespace=ctx.i(2);ctx.S([2,"named,value"]);ctx.n(namespace);',
    );

    expect(projectNodeManifestTurbopackFactory(original, 1, 'dependencies').exports).toStrictEqual({
      kind: 'opaque',
    });
    expect(() => projectNodeManifestTurbopackFactory(original, 1)).toThrow('Unproved Next.js');
  });
});

describe('discarded runtime require data-member inspection', () => {
  it.each([
    'ctx.r,0;',
    'use((ctx.r,0));',
    'return (ctx.r,0);',
    'ctx.r,ctx.r,void 0;',
    'function later(){return (ctx.r,42);}ctx.v(later);',
  ])('preserves %s without inventing a dependency or export authority', (body) => {
    const projected = project(body);

    expect(projected.imports).toStrictEqual([]);
    expect(projected.source.code.trim()).toBe(body);
    expect(projected.original).toStrictEqual(registration(body));
    expect(() => projectNodeManifestTurbopackFactory(registration(body), 1)).toThrow(
      'Unproved Next.js',
    );
  });

  it('continues inspecting the live final operand and all other ordinary statements', () => {
    const body = 'ctx.r,ctx.i(2);ctx.v(42);';
    const projected = project(body);

    expect(projected.imports).toStrictEqual([
      { kind: 'import', specifier: 'turbopack:2', targetId: 2 },
    ]);
    expect(projected.source.code).toContain('ctx.r,require("turbopack:2")');
    expect(projected.original).toStrictEqual(registration(body));
    expect(() => graph('ctx.r,ctx.i(3);')).toThrow('unregistered module dependency');
  });

  it.each([
    'ctx.r;',
    '0,ctx.r;',
    'const load=(0,ctx.r);',
    'return (0,ctx.r);',
    '(ctx.r,ctx.r)(2);',
    '(ctx.r,ctx.i)(2);',
    'ctx["r"],0;',
    'ctx?.r,0;',
    'ctx.r.name,0;',
    'ctx.r=other,0;',
    'ctx.r++,0;',
    'ctx.r.call(ctx,2),0;',
    'ctx.r.bind(ctx),0;',
    '[ctx.r,0];',
    'ctx=other;ctx.r,0;',
  ])('retains refusal for an escaping or modified runtime capability: %s', (body) => {
    expect(() => project(body)).toThrow('Unproved Next.js');
  });

  it('keeps a separately bound ordinary receiver distinct from the actual runtime context', () => {
    const body = 'function ordinary(ctx){ctx.S([unknown]);return (ctx.r,0);}ctx.v(ordinary);';
    const projected = project(body);

    expect(projected.imports).toStrictEqual([]);
    expect(projected.source.code.trim()).toBe(body);
  });
});
