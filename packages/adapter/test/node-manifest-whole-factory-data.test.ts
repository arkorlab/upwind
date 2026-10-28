import { createHash } from 'node:crypto';

import { parseAst } from 'rolldown/parseAst';
import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { isNode } from '../src/lexical-scope.ts';
import { NodeManifestAlpha } from '../src/node-manifest-alpha.ts';
import { visitTree } from '../src/node-manifest-consumer-ast.ts';
import {
  nodeManifestTurbopackFactories,
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackModuleId,
  type NodeManifestTurbopackProjection,
  type NodeManifestTurbopackSource,
} from '../src/node-manifest-turbopack.ts';
import { nodeManifestWholeFactoryData } from '../src/node-manifest-whole-factory-data.ts';

function source(code: string): NodeManifestTurbopackSource {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
function chunk(body: string, ids: readonly NodeManifestTurbopackModuleId[] = [1]): string {
  return `module.exports=[${ids.map((id) => jsLiteral(id)).join(',')},(ctx,module,exports)=>{${body}}];`;
}
function projection(
  code: string,
  id: NodeManifestTurbopackModuleId = 1,
): NodeManifestTurbopackProjection {
  return projectNodeManifestTurbopackFactory(source(code), id, 'dependencies');
}
function data(body: string) {
  return nodeManifestWholeFactoryData(projection(chunk(body)));
}
function canonical(body: string): string {
  return data(body).canonical;
}
function firstFactory(original: NodeManifestTurbopackSource) {
  const factory = nodeManifestTurbopackFactories(original)[0];
  if (factory === undefined) throw new Error('Expected authored factory');
  return factory;
}
function capturedCallback(code: string) {
  const program: unknown = parseAst(code);
  if (!isNode(program)) throw new Error('Expected authored program');
  const factory = visitTree(program).find(
    ({ node }) => node.type === 'ArrowFunctionExpression',
  )?.node;
  if (factory === undefined) throw new Error('Expected authored callback');
  return { program, factory };
}

describe('whole original Turbopack factory DATA', () => {
  it('ignores unrelated physical factories when numbering selected callback bindings', () => {
    const factory = '(ctx,module,exports)=>{const local=ctx.i(7);ctx.v(local);}';
    const original = nodeManifestWholeFactoryData(projection(`module.exports=[1,${factory}];`));
    const surroundedCode = `module.exports=[2,(other)=>{const a=1,b=2;other.v([a,b]);},1,${factory},3,(last)=>{let c=3;last.v(c);}];`;
    const surrounded = nodeManifestWholeFactoryData(projection(surroundedCode));

    expect(surrounded.canonical).toBe(original.canonical);
    expect(surrounded.originalSha256).not.toBe(original.originalSha256);
    expect(surrounded.factory.start).not.toBe(original.factory.start);
    expect(surrounded.factory.ids).toStrictEqual(original.factory.ids);
    expect(surrounded.ports.map(({ id }) => id)).toStrictEqual([7]);
  });

  it('refuses an outer lexical capture in a selected-only alpha scope and the registration API', () => {
    const code = 'const captured=1;module.exports=[1,(ctx)=>{ctx.v(captured);}];';
    const { program, factory } = capturedCallback(code);
    const alpha = new NodeManifestAlpha({ original: program, body: [factory] });

    expect(() => alpha.shape(factory)).toThrow('selector leaves its lexical scope');
    expect(() => nodeManifestWholeFactoryData(projection(code))).toThrow('registration statements');
  });

  it('alpha-normalizes lexical bindings and precisely typed import ports without evaluating code', () => {
    const first = data(
      'var value=ctx.i(7),other=ctx.r(7),text=ctx.i("7");ctx.v([value,other,text]);',
    );
    const renamed = nodeManifestWholeFactoryData(
      projection(
        'module.exports=[1,(runtime,mod,out)=>{var one=runtime.i(99),two=runtime.r(99),three=runtime.i("99");runtime.v([one,two,three]);}];',
      ),
    );

    expect(renamed.canonical).toBe(first.canonical);
    expect(
      first.ports.map(({ ordinal, id, idType, occurrences }) => {
        return {
          ordinal,
          id,
          idType,
          kinds: occurrences.map(({ kind }) => kind),
        };
      }),
    ).toStrictEqual([
      { ordinal: 0, id: 7, idType: 'number', kinds: ['import', 'require'] },
      { ordinal: 1, id: '7', idType: 'string', kinds: ['import'] },
    ]);
    expect(renamed.ports.map(({ id }) => id)).toStrictEqual([99, '99']);
    expect(first.ports[0]?.occurrences[0]?.start).toBeLessThan(
      first.ports[0]?.occurrences[1]?.start ?? 0,
    );
  });

  it.each([
    ['one target versus two', 'ctx.i(7);ctx.r(7);', 'ctx.i(7);ctx.r(8);'],
    ['number versus string', 'ctx.i(7);', 'ctx.i("7");'],
    ['import versus require', 'ctx.i(7);', 'ctx.r(7);'],
    ['port order', 'ctx.i(7);ctx.r(8);', 'ctx.r(8);ctx.i(7);'],
    ['ordinary literals', 'ctx.i(7);ctx.v(7);', 'ctx.i(8);ctx.v(8);'],
    ['bigint literals', 'ctx.v(0n);', 'ctx.v(1n);'],
    ['property names', 'const a=ctx.i(7);ctx.v(a.name);', 'const a=ctx.i(8);ctx.v(a.other);'],
  ])('preserves %s rather than erasing non-port distinctions', (_name, first, second) => {
    expect(canonical(first)).not.toBe(canonical(second));
  });

  it('retains the complete typed registration vector, selected ordinal and coalesced sibling statements', () => {
    const body = 'const a=1,b=2;ctx.s(["a",0,a],1);ctx.s(["b",0,b],"second");';
    const original = source(chunk(body, [1, 'second']));
    const firstProjection = projectNodeManifestTurbopackFactory(original, 1, 'dependencies');
    const first = nodeManifestWholeFactoryData(firstProjection);
    const second = nodeManifestWholeFactoryData(
      projectNodeManifestTurbopackFactory(original, 'second', 'dependencies'),
    );
    const renamed = nodeManifestWholeFactoryData(
      projection(
        chunk('const a=1,b=2;ctx.s(["a",0,a],101);ctx.s(["b",0,b],"renamed");', [101, 'renamed']),
        101,
      ),
    );

    expect(first.factory.ids).toStrictEqual([1, 'second']);
    expect([first.selectedOrdinal, second.selectedOrdinal]).toStrictEqual([0, 1]);
    expect(first.canonical).not.toBe(second.canonical);
    expect(renamed.canonical).toBe(first.canonical);
    expect(first.canonical).toContain('registered-module');
    expect(firstProjection.original).toBe(original);
    expect(original.code).toBe(chunk(body, [1, 'second']));
  });

  it('preserves the relationship between import ports and the registered vector', () => {
    const own = nodeManifestWholeFactoryData(projection(chunk('ctx.i(1);', [1, 2])));
    const sibling = nodeManifestWholeFactoryData(projection(chunk('ctx.i(2);', [1, 2])));
    const outside = nodeManifestWholeFactoryData(projection(chunk('ctx.i(3);', [1, 2])));

    expect(own.canonical).not.toBe(sibling.canonical);
    expect(own.canonical).not.toBe(outside.canonical);
    expect(sibling.canonical).not.toBe(outside.canonical);
  });

  it('does not normalize a foreign cache ID or other context-method arguments', () => {
    const first = canonical('const a=1;ctx.s(["a",0,a],42);const ns=ctx.i(42);ctx.v(ns);');
    const second = canonical('const a=1;ctx.s(["a",0,a],43);const ns=ctx.i(43);ctx.v(ns);');

    expect(first).not.toBe(second);
    expect(canonical('ctx.v(7);')).not.toBe(canonical('ctx.v(8);'));
  });

  it.each([
    ['statement order', 'first();second();', 'second();first();'],
    ['initializer effects', 'var a=first();ctx.v(a);', 'var a=second();ctx.v(a);'],
    ['nested async flag', 'const fn=()=>1;ctx.v(fn);', 'const fn=async()=>1;ctx.v(fn);'],
    [
      'nested generator flag',
      'const fn=function(){return 1;};ctx.v(fn);',
      'const fn=function*(){return 1;};ctx.v(fn);',
    ],
    [
      'late sibling effect',
      'ctx.s(["x",0,1],1);sideEffect(1);',
      'ctx.s(["x",0,1],1);sideEffect(2);',
    ],
    [
      'nested class',
      'const C=class{method(){return 1;}};ctx.v(C);',
      'const C=class{method(){return 2;}};ctx.v(C);',
    ],
  ])('retains %s in the whole callback', (_name, first, second) => {
    expect(canonical(first)).not.toBe(canonical(second));
  });

  it('retains arrow versus ordinary factory function flags', () => {
    const arrow = nodeManifestWholeFactoryData(projection(chunk('ctx.v(1);')));
    const ordinary = nodeManifestWholeFactoryData(
      projection('module.exports=[1,function(ctx,module,exports){ctx.v(1);}];'),
    );

    expect(ordinary.canonical).not.toBe(arrow.canonical);
  });

  it('excludes physical offsets from canonical data while preserving audit ranges', () => {
    const first = nodeManifestWholeFactoryData(projection(chunk('ctx.i(7);')));
    const spaced = nodeManifestWholeFactoryData(
      projection(`\n/* physical offset */\n${chunk('  ctx.i(9);  ')}`),
    );

    expect(spaced.canonical).toBe(first.canonical);
    expect(spaced.factory.start).not.toBe(first.factory.start);
    expect(spaced.ports[0]?.occurrences[0]?.start).not.toBe(first.ports[0]?.occurrences[0]?.start);
  });

  it('records genuine directive raw syntax and never infers ESM strictness from parseAst defaults', () => {
    const plain = data('ctx.v(1);');
    const own = data('"custom";"use strict";ctx.v(1);');
    const escaped = data(String.raw`"use\x20strict";ctx.v(1);`);
    const parenthesized = data('("use strict");ctx.v(1);');

    expect(plain.strictContext.effective).toBe(false);
    expect(own.strictContext.effective).toBe(true);
    expect(escaped.strictContext.effective).toBe(false);
    expect(parenthesized.strictContext.effective).toBe(false);
    expect(own.strictContext.scopes.at(-1)?.directives).toStrictEqual([
      { raw: '"custom"', value: 'custom' },
      { raw: '"use strict"', value: 'use strict' },
    ]);
    expect(own.canonical).not.toBe(escaped.canonical);
    expect(own.canonical).not.toBe(plain.canonical);
    expect(canonical('const fn=function(){"use strict";return 1;};ctx.v(fn);')).not.toBe(
      canonical(String.raw`const fn=function(){"use\x20strict";return 1;};ctx.v(fn);`),
    );
  });

  it('includes inherited genuine strict directives in the canonical signature', () => {
    const body = chunk('ctx.v(1);');
    const plain = nodeManifestWholeFactoryData(projection(body));
    const program = nodeManifestWholeFactoryData(projection(`"use strict";${body}`));
    const wrapper = nodeManifestWholeFactoryData(projection(`(()=>{'use strict';${body}})();`));

    expect(program.strictContext.effective).toBe(true);
    expect(wrapper.strictContext.effective).toBe(true);
    expect(program.canonical).not.toBe(plain.canonical);
    expect(wrapper.canonical).not.toBe(program.canonical);
    expect(canonical('"use strict";ctx.v(1);')).not.toBe(canonical("'use strict';ctx.v(1);"));
  });

  it('keeps real lexical shadows separate from context ports including named classes', () => {
    const first = data(
      'function local(ctx){return ctx.r(99);}const C=class ctx{method(){return ctx.r(99);}};ctx.i(7);ctx.v([local,C]);',
    );
    const second = data(
      'function local(ctx){return ctx.r(100);}const C=class ctx{method(){return ctx.r(100);}};ctx.i(8);ctx.v([local,C]);',
    );

    expect(first.ports.map(({ id }) => id)).toStrictEqual([7]);
    expect(first.canonical).not.toBe(second.canonical);
    expect(canonical('const a=1;function fn(a){return a;}ctx.v(fn);')).not.toBe(
      canonical('const a=1;function fn(b){return a;}ctx.v(fn);'),
    );
  });

  it.each([
    ['bare escape', 'const escaped=ctx;'],
    ['reassignment', 'ctx=other;ctx.i(1);'],
    ['redeclaration', 'var ctx;ctx.i(1);'],
    ['unknown method', 'ctx.unknown(1);'],
    ['dynamic port', 'ctx.i(dynamic);'],
    ['expression port', 'ctx.r(1+2);'],
    ['optional port', 'ctx?.i(1);'],
    ['optional call', 'ctx.i?.(1);'],
    ['computed method', 'ctx["i"](1);'],
    ['spread port', 'ctx.i(...values);'],
    ['unbound require', '(0,ctx.r)(1);'],
    ['bound require', 'const load=ctx.r.bind(ctx);ctx.v(load);'],
    ['reflection', 'Reflect.get(ctx,"i")(1);'],
  ])('refuses %s before returning canonical DATA', (_name, body) => {
    expect(() => data(body)).toThrow('Unproved');
  });

  it.each([
    [
      'physical digest',
      (value: NodeManifestTurbopackProjection) => {
        return {
          ...value,
          original: { ...value.original, sha256: '0'.repeat(64) },
        };
      },
    ],
    [
      'changed original bytes',
      (value: NodeManifestTurbopackProjection) => {
        return {
          ...value,
          original: source(chunk('ctx.i(8);')),
        };
      },
    ],
    [
      'range',
      (value: NodeManifestTurbopackProjection) => {
        return {
          ...value,
          factory: { ...value.factory, start: value.factory.start + 1 },
        };
      },
    ],
    [
      'vector',
      (value: NodeManifestTurbopackProjection) => {
        return {
          ...value,
          factory: { ...value.factory, ids: [1, 2] },
        };
      },
    ],
    ['selected ID', (value: NodeManifestTurbopackProjection) => ({ ...value, moduleId: 2 })],
    [
      'inspection digest',
      (value: NodeManifestTurbopackProjection) => {
        return {
          ...value,
          source: { ...value.source, sha256: '0'.repeat(64) },
        };
      },
    ],
    [
      'inspection bytes',
      (value: NodeManifestTurbopackProjection) => ({ ...value, source: source('other();') }),
    ],
    ['import ledger', (value: NodeManifestTurbopackProjection) => ({ ...value, imports: [] })],
  ])('recomputes and rejects stale %s', (_name, change) => {
    const original = projection(chunk('ctx.i(7);'));
    const stale = change(original);

    expect(() => nodeManifestWholeFactoryData(stale)).toThrow('Unproved');
  });

  it('applies source, AST-depth and registration-vector bounds before fresh projection', () => {
    const original = projection(chunk('ctx.v(1);'));
    const huge = source(`/*${'x'.repeat(4_194_304)}*/${chunk('ctx.v(1);')}`);
    const deep = source(chunk(`const a=${'['.repeat(260)}0${']'.repeat(260)};ctx.v(a);`));
    const many = source(
      chunk(
        'ctx.v(1);',
        Array.from({ length: 4097 }, (_, index) => index),
      ),
    );
    const factory = firstFactory(many);

    expect(() => nodeManifestWholeFactoryData({ ...original, original: huge })).toThrow('bounds');
    expect(() => nodeManifestWholeFactoryData({ ...original, original: deep })).toThrow(
      'AST bounds',
    );
    expect(() =>
      nodeManifestWholeFactoryData({ ...original, original: many, factory, moduleId: 0 }),
    ).toThrow('bounds');
  });

  it('returns frozen DATA without any runtime or role certificate', () => {
    const value = data('ctx.i(7);');

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.factory.ids)).toBe(true);
    expect(Object.isFrozen(value.strictContext.scopes)).toBe(true);
    expect(Object.isFrozen(value.ports[0]?.occurrences)).toBe(true);
    expect(value).not.toHaveProperty('requiresReviewedRuntime');
    expect(value).not.toHaveProperty('proof');
  });
});
