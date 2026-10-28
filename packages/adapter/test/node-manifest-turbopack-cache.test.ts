import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { nodeManifestTurbopackEntryGraph } from '../src/node-manifest-turbopack-graph.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackSource,
} from '../src/node-manifest-turbopack.ts';

const DIST = '/project/.next';
const ENTRY = `${DIST}/server/app/native/page.js`;
const RUNTIME = `${DIST}/server/chunks/runtime.js`;
const CHUNK = `${DIST}/server/chunks/app.js`;
const INITIALIZER = 'ctx.s(["answer",()=>answer],"internal");';

function source(code: string): NodeManifestTurbopackSource {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

function chunk(body: string): NodeManifestTurbopackSource {
  return source(`module.exports=[1,((ctx)=>{${body}})];`);
}

function graph(code: string, exportedId = '1'): ReturnType<typeof nodeManifestTurbopackEntryGraph> {
  const boot = [
    'var R=require("../../chunks/runtime.js")("server/app/native/page.js");',
    'R.c("server/chunks/app.js");',
    `module.exports=R.m(${exportedId}).exports;`,
  ].join('\n');
  return nodeManifestTurbopackEntryGraph({
    distDir: DIST,
    entry: { file: ENTRY, page: '/native/page', pathname: '/native' },
    sources: [
      {
        id: ENTRY,
        file: ENTRY,
        source: source(boot),
        imports: [{ specifier: '../../chunks/runtime.js', target: RUNTIME }],
      },
      {
        id: RUNTIME,
        file: RUNTIME,
        source: source('module.exports=unprovedRuntime;'),
        imports: [{ specifier: CHUNK, target: CHUNK }],
      },
      { id: CHUNK, file: CHUNK, source: source(code), imports: [] },
    ],
  });
}

describe('ordinary Turbopack internal cache ownership', () => {
  it('keeps an internal namespace initialization and later immediate read in the same factory', () => {
    const original = chunk(`${INITIALIZER}const answer=42;const ns=ctx.i("internal");ctx.v(ns);`);
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');
    const initializer = projection.cacheInitializers[0];

    expect({
      registered: nodeManifestTurbopackFactories(original).map((factory) => factory.ids),
      imports: projection.imports,
      exports: projection.exports,
    }).toStrictEqual({ registered: [[1]], imports: [], exports: { kind: 'opaque' } });
    expect(projection.source.code).toContain(INITIALIZER);
    expect(projection.source.code).toContain('const ns=ctx.i("internal")');
    expect(projection.cacheInitializers).toHaveLength(1);
    expect(initializer?.id).toBe('internal');
    expect(
      projection.cacheInitializers.map(({ start, end }) => original.code.slice(start, end)),
    ).toStrictEqual([INITIALIZER.slice(0, -1)]);
    expect(Object.isFrozen(projection.cacheInitializers)).toBe(true);
    expect(Object.isFrozen(initializer)).toBe(true);
  });

  it.each([
    'ctx.s(["answer",()=>answer],"internal");const answer=42;ctx.i("internal");',
    'ctx.n({answer:42},"internal");var ns=ctx.r("internal");',
    'ctx.v(42,"internal");let ns=ctx.i("internal");',
  ])('allows only an existing export cache-write method: %s', (body) => {
    const projection = projectNodeManifestTurbopackFactory(chunk(body), 1, 'dependencies');

    expect(projection.imports).toStrictEqual([]);
    expect(projection.cacheInitializers.map((entry) => entry.id)).toStrictEqual(['internal']);
    expect(projection.source.code).toContain('ctx.');
  });

  it('retains exact numeric and string cache keys without adding callable factories', () => {
    const original = chunk('ctx.v(42,2);ctx.v(7,"2");const a=ctx.r(2);const b=ctx.i("2");');
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');
    const closed = graph(original.code);

    expect(projection.cacheInitializers.map((entry) => entry.id)).toStrictEqual([2, '2']);
    expect(projection.imports).toStrictEqual([]);
    expect(closed.factories.map((factory) => factory.projection.moduleId)).toStrictEqual([1]);
    expect(() => graph(original.code, '2')).toThrow('entry module is not initially registered');
  });

  it.each([
    '0,ctx.v(42,"internal");const ns=ctx.i("internal");',
    'ctx.v(42,"internal"),0;const ns=ctx.i("internal");',
    '(0,(ctx.v(42,"internal"),0)),0;const ns=ctx.i("internal");',
  ])('retains an ordinary write in a top-level comma expression: %s', (body) => {
    const original = chunk(body);
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(projection.cacheInitializers.map((entry) => entry.id)).toStrictEqual(['internal']);
    expect(projection.imports).toStrictEqual([]);
    expect(projection.exports).toStrictEqual({ kind: 'commonjs' });
    expect(projection.source.code).toContain(body);
    expect(original).toStrictEqual(chunk(body));
    expect(() => projectNodeManifestTurbopackFactory(original, 1)).toThrow(
      'dynamic or foreign export target',
    );
  });

  it('preserves ordered writes and distinct numeric and string keys inside commas', () => {
    const original = chunk('(ctx.v(42,2),(ctx.v(7,"2"),0));const a=ctx.i(2);const b=ctx.r("2");');
    const projection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(projection.cacheInitializers.map((entry) => entry.id)).toStrictEqual([2, '2']);
    expect(
      projection.cacheInitializers.map(({ start, end }) => original.code.slice(start, end)),
    ).toStrictEqual(['ctx.v(42,2)', 'ctx.v(7,"2")']);
    expect(graph(original.code).factories).toHaveLength(1);
  });

  it('deduplicates the identical original initializer when a factory has multiple registered aliases', () => {
    const original =
      'module.exports=[1,"alias",((ctx)=>{ctx.v(42,"internal");ctx.i("internal");})];';
    const closed = graph(original);

    expect(closed.factories.map((factory) => factory.projection.moduleId)).toStrictEqual([
      1,
      'alias',
    ]);
    expect(closed.factories.map((factory) => factory.imports)).toStrictEqual([[], []]);
  });

  it.each([
    ['read before write', 'const ns=ctx.i("internal");ctx.v(42,"internal");'],
    ['deferred read', 'ctx.v(42,"internal");function later(){return ctx.i("internal");}'],
    ['conditional read', 'ctx.v(42,"internal");if(flag)ctx.i("internal");'],
    ['nested read', 'ctx.v(42,"internal");consume(ctx.i("internal"));'],
    ['block read', 'ctx.v(42,"internal");{ctx.i("internal");}'],
    ['deferred write', 'function later(){ctx.v(42,"internal");}'],
    ['conditional write', 'if(flag)ctx.v(42,"internal");'],
    ['expression write', 'consume(ctx.v(42,"internal"));'],
    ['duplicate write', 'ctx.v(42,"internal");ctx.n({answer:42},"internal");'],
    ['write self read', 'ctx.v(ctx.i("internal"),"internal");'],
    ['conditional comma write', 'flag&&(0,ctx.v(42,"internal"));'],
    ['conditional comma operand', '0,(flag?ctx.v(42,"internal"):0);'],
    ['returned comma write', 'return 0,ctx.v(42,"internal");'],
    ['call-argument comma write', 'consume((0,ctx.v(42,"internal")));'],
    ['deferred comma write', 'function later(){0,ctx.v(42,"internal");}'],
    ['block comma write', '{0,ctx.v(42,"internal");}'],
    ['duplicate comma write', 'ctx.v(42,"internal"),ctx.v(7,"internal");'],
    ['read before comma write', 'const ns=ctx.i("internal");0,ctx.v(42,"internal");'],
  ])('refuses %s rather than inferring activation or cyclic initialization', (_name, body) => {
    expect(() => projectNodeManifestTurbopackFactory(chunk(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js Turbopack cache initializer',
    );
  });

  it.each([
    'ctx.v(42,dynamic);',
    'ctx.v(42,{id:"internal"});',
    'ctx.v(42,/internal/);',
    'ctx.v(42,0n);',
    'ctx.v(...values);',
    'ctx.s(["answer",()=>answer],"internal",dynamic);',
    'ctx.v(42,"internal");ctx.r(dynamic);',
    'ctx.v(42,"internal");const alias=ctx.i;',
    'ctx.v(42,"internal");ctx.unknown("internal");',
    'ctx.v(42,"internal");consume(ctx);',
    'ctx.v(42,"internal");require(dynamic);',
    'ctx.v(42,"internal");import(dynamic);',
  ])('does not exempt unknown arguments, imports or context authority: %s', (body) => {
    expect(() => projectNodeManifestTurbopackFactory(chunk(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js',
    );
  });

  it('does not promote internal-cache metadata into a strict protected-consumer proof', () => {
    const original = chunk('ctx.v(42,"internal");ctx.i("internal");');

    expect(() => projectNodeManifestTurbopackFactory(original, 1)).toThrow(
      'dynamic or foreign export target',
    );
  });

  it.each([
    [
      'registered ID collision',
      'module.exports=[1,((ctx)=>{ctx.v(42,2);}),2,((ctx)=>{})];',
      'collides with a registered module ID',
    ],
    [
      'two original owners',
      'module.exports=[1,((ctx)=>{ctx.v(42,"internal");}),2,((ctx)=>{ctx.v(7,"internal");})];',
      'has more than one original owner',
    ],
    [
      'cross-factory internal read',
      'module.exports=[1,((ctx)=>{ctx.v(42,"internal");}),2,((ctx)=>{ctx.i("internal");})];',
      'unregistered module dependency',
    ],
    [
      'cross-factory deferred internal read',
      'module.exports=[1,((ctx)=>{ctx.v(42,"internal");}),2,((ctx,m,e)=>{e.later=()=>ctx.i("internal");})];',
      'unregistered module dependency',
    ],
  ])('closes the whole runtime table and refuses %s', (_name, code, reason) => {
    expect(() => graph(code)).toThrow(reason);
  });
});
