import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { assertNodeManifestConsumer } from '../src/node-manifest-consumers.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackSource,
} from '../src/node-manifest-turbopack.ts';

const PRODUCER_SHA = '0a6a5c726f95e2df2600b2fd6d71e37fd72f936f8f4dc5b94fa38d40fcd62a6b';
const PRODUCER = 'next/dist/build/templates/app-page-runtime.js';
const ARGUMENT =
  '{tree,page:"/native/page",pathname:"/native",require:ctx.r.bind(ctx),loadChunk:ctx.l.bind(ctx),interopDefault}';
const CALLER = [
  'ctx.s(["__next_app__",()=>__next_app__,"handler",()=>handler,"routeModule",()=>routeModule]);',
  'var producer=ctx.i(2);',
  `const entrypoint=producer.createAppPageEntrypoint(${ARGUMENT});`,
  'const __next_app__=entrypoint.__next_app__;',
  'const routeModule=entrypoint.routeModule;',
  'const handler=entrypoint.handler;',
].join('\n');

function source(code: string): NodeManifestTurbopackSource {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
function chunk(body = CALLER): NodeManifestTurbopackSource {
  return source(
    `module.exports=[1,((ctx)=>{${body}}),2,((ctx)=>{var mod=ctx.x(${jsLiteral(PRODUCER)},()=>require(${jsLiteral(PRODUCER)}));ctx.n(mod);})];`,
  );
}

describe('next Turbopack manifest factory projections', () => {
  it('binds factory offsets and local dependencies without evaluating or rewriting the original chunk', () => {
    const original = chunk();
    const projected = projectNodeManifestTurbopackFactory(original, 1);
    const terminal = assertNodeManifestConsumer({
      source: projected.source,
      route: { page: '/native/page', pathname: '/native' },
      imports: [
        {
          specifier: 'turbopack:2',
          file: `/project/node_modules/${PRODUCER}`,
          sha256: PRODUCER_SHA,
          kind: 'app-page-factory',
          exportName: 'createAppPageEntrypoint',
        },
      ],
    });

    expect({
      original: projected.original,
      imports: projected.imports,
      exports: projected.exports,
      normalized: terminal.requiresRuntimeNormalization,
    }).toStrictEqual({
      original,
      imports: [{ kind: 'import', specifier: 'turbopack:2', targetId: 2 }],
      exports: { kind: 'getters', names: ['__next_app__', 'handler', 'routeModule'] },
      normalized: true,
    });
    expect(projected.source.sha256).not.toBe(original.sha256);
  });

  it('recognizes only the canonical external namespace forwarder, retaining its exact external identity', () => {
    const projected = projectNodeManifestTurbopackFactory(chunk(), 2);

    expect({ imports: projected.imports, exports: projected.exports }).toStrictEqual({
      imports: [{ kind: 'external', specifier: PRODUCER }],
      exports: { kind: 'namespace', specifier: PRODUCER },
    });
  });

  it.each(['ctx.v(42);', 'ctx.n({answer:42});', 'ctx.s(["answer",()=>calculate()]);'])(
    'records ordinary export dependencies without certifying its opaque value: %s',
    (body) => {
      const original = chunk(`var p=ctx.i(2);${body}`);
      const projected = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

      expect({ mode: projected.mode, exports: projected.exports, imports: projected.imports })
        .toStrictEqual({
          mode: 'dependencies',
          exports: { kind: 'opaque' },
          imports: [{ kind: 'import', specifier: 'turbopack:2', targetId: 2 }],
        });
      expect(() => projectNodeManifestTurbopackFactory(original, 1)).toThrow('Unproved Next.js');
    },
  );

  it('retains raw static require and import edges while excluding the checked external thunk duplicate', () => {
    const original = chunk('const a=require("node:fs");import("other");var p=ctx.x("next",()=>require("next"));');
    const projected = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');

    expect(projected.imports).toStrictEqual([
      { kind: 'external', specifier: 'next' },
      { kind: 'external', specifier: 'node:fs' },
      { kind: 'external', specifier: 'other' },
    ]);
  });

  it.each([
    'ctx.v(42);const alias=ctx.i;',
    'ctx.v(42);ctx.M(other);',
    'ctx.v(42);ctx.c=other;',
    'ctx.v(42);require(dynamic);',
    'ctx.v(42);import(dynamic);',
    'ctx.v(42,2);',
    'ctx.s(["answer",()=>42],2);',
  ])('preserves dependency-mode loader and context refusal: %s', (body) => {
    expect(() => projectNodeManifestTurbopackFactory(chunk(body), 1, 'dependencies')).toThrow(
      'Unproved Next.js',
    );
  });

  it.each([
    ['flat aliases', 'module.exports=[1,2,((ctx)=>{})];'],
    ['all strict', '(()=>{"use strict";module.exports=[1,((ctx)=>{}),2,((ctx)=>{})];})();'],
    [
      'mixed strict',
      'module.exports=[(()=>{"use strict";return[1,((ctx)=>{})];})(),2,((ctx)=>{})];',
    ],
    ['function factories', 'module.exports=[1,(function(ctx,module,exports){exports.foo=1})];'],
  ])('recognizes the fixed producer %s registration structure', (_name, code) => {
    const factories = nodeManifestTurbopackFactories(source(code));

    expect(factories.flatMap((factory) => factory.ids)).toStrictEqual(
      [1, 2].slice(0, _name === 'function factories' ? 1 : 2),
    );
  });

  it('canonicalizes actual CommonJS factory parameters while preserving lexical shadows', () => {
    const original = source(
      'module.exports=[1,((ctx,m,e)=>{e.handler=1;function unrelated(e){return e;}})];',
    );
    const projection = projectNodeManifestTurbopackFactory(original, 1);

    expect(projection.source.code).toContain('exports.handler=1');
    expect(projection.source.code).toContain('function unrelated(e){return e;}');
  });

  it.each([
    ['extra chunk code', 'globalThis.bad();module.exports=[1,((ctx)=>{})];'],
    ['unknown registry', 'other.exports=[1,((ctx)=>{})];'],
    ['computed registry', 'module["exports"]=[1,((ctx)=>{})];'],
    ['duplicate module', 'module.exports=[1,((ctx)=>{}),1,((ctx)=>{})];'],
    ['negative id', 'module.exports=[-1,((ctx)=>{})];'],
    ['unknown id', 'module.exports=[dynamic,((ctx)=>{})];'],
    ['missing factory', 'module.exports=[1];'],
    ['unbound factory', 'module.exports=[((ctx)=>{})];'],
    ['table hole', 'module.exports=[1,,((ctx)=>{})];'],
    ['strict side effect', '(()=>{"use strict";bad();module.exports=[1,((ctx)=>{})];})();'],
    [
      'recursive strict groups',
      'module.exports=[(()=>{"use strict";return[(()=>{"use strict";return[1,((ctx)=>{})];})()];})()];',
    ],
    ['async factory', 'module.exports=[1,(async(ctx)=>{})];'],
    ['destructured context', 'module.exports=[1,(({x})=>{})];'],
    ['extra parameter', 'module.exports=[1,((ctx,other)=>{})];'],
  ])('refuses %s before treating a physical chunk as a module graph', (_name, code) => {
    expect(() => nodeManifestTurbopackFactories(source(code))).toThrow(
      'Unproved Next.js Turbopack manifest',
    );
  });

  it.each([
    ['dynamic local import', 'const p=ctx.i(dynamic);'],
    ['computed context access', 'const p=ctx["i"](2);'],
    ['method alias', 'const fn=ctx.i;'],
    ['context alias', 'const escaped=ctx;'],
    ['outer CommonJS exports', 'exports.handler=entrypoint.handler;'],
    ['outer CommonJS module', 'module.exports=entrypoint;'],
    ['context mutation', 'ctx.i=other;'],
    ['optional call', 'ctx.i?.(2);'],
    ['wrong external thunk', 'const p=ctx.x("next",()=>require("other"));'],
    ['effectful external thunk', 'const p=ctx.x("next",()=>{bad();return require("next")});'],
    ['shadowed external require', 'const require=other;const p=ctx.x("next",()=>require("next"));'],
    ['raw synthetic require', 'var unused=ctx.i(2);var fake=require("turbopack:2");'],
    ['raw synthetic dynamic import', 'var unused=ctx.i(2);import("turbopack:2");'],
    ['external synthetic module', 'var fake=ctx.x("turbopack:2",()=>require("turbopack:2"));'],
    ['named external require', 'const p=ctx.x("next",function require(){return require("next")});'],
    ['dynamic external import', 'const p=ctx.y("next");'],
    ['conditional exports', 'if(flag)ctx.s(["handler",()=>handler]);'],
    ['duplicate exports', 'ctx.s(["handler",()=>handler,"handler",()=>handler]);'],
    ['effectful getter', 'ctx.s(["handler",()=>factory()]);'],
    ['named function getter', 'ctx.s(["handler",function handler(){return handler;}]);'],
    ['implicit arguments getter', 'ctx.s(["handler",()=>arguments]);'],
    ['implicit arguments property getter', 'ctx.s(["handler",()=>arguments.handler]);'],
    ['context getter escape', 'ctx.s(["handler",()=>ctx]);'],
    ['setter export', 'ctx.s(["handler",()=>handler,v=>handler=v]);'],
    ['foreign target exports', 'ctx.s(["handler",()=>handler],2);'],
    ['dynamic reexports', 'ctx.s(["handler",()=>handler],undefined,true);'],
    ['unknown namespace value', 'const p=other;ctx.n(p);'],
    ['mutated namespace', 'var p=ctx.i(2);p=other;ctx.n(p);'],
    ['modified namespace', 'var p=ctx.i(2);p.handler=other;ctx.n(p);'],
    ['wrong bound context', 'const require=ctx.r.bind(other);'],
    ['escaped bound context', 'const require=ctx.r.bind(ctx);'],
  ])('refuses a factory with %s without widening the manifest exemption', (_name, body) => {
    expect(() => projectNodeManifestTurbopackFactory(chunk(body), 1)).toThrow(
      'Unproved Next.js Turbopack manifest',
    );
  });

  it('requires original source identity and a registered static module ID', () => {
    const original = chunk();

    expect(() =>
      projectNodeManifestTurbopackFactory({ ...original, sha256: 'a'.repeat(64) }, 1),
    ).toThrow('source byte identity');
    expect(() => projectNodeManifestTurbopackFactory(original, 3)).toThrow('unknown module id');
  });

  it.each(['module', 'exports'])(
    'does not merge a free %s with a renamed CommonJS parameter',
    (name) => {
      const original = source(`module.exports=[1,((ctx,m,e)=>{e.handler=1;${name}.other=1;})];`);

      expect(() => projectNodeManifestTurbopackFactory(original, 1)).toThrow(
        'outer CommonJS export reference',
      );
    },
  );
});
