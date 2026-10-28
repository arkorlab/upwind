import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { directExternalNamespace } from '../src/node-manifest-external-forwarder.ts';
import { proveNodeManifestTurbopackConsumers } from '../src/node-manifest-turbopack-consumers.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';
import {
  COALESCED_CHUNK,
  COALESCED_ENTRY,
  coalescedPagesFixture,
} from './fixtures/node-manifest-coalesced-pages.ts';
import { manifestTemplateSource as source } from './fixtures/node-manifest-turbopack-template.ts';

const SPECIFIER = 'next/dist/compiled/next-server/pages-turbo.runtime.prod.js';
const CALL = `ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}))`;
const EXPORT = `module.exports=${CALL};`;

function projection(body: string, ordinary = false) {
  const callback = ordinary
    ? `function(ctx,module,exports){${body}}`
    : `(ctx,module,exports)=>{${body}}`;
  return projectNodeManifestTurbopackFactory(
    source(`module.exports=[1,${callback}];`),
    1,
    'dependencies',
  );
}
async function protectedGraph(body: string) {
  const fixture = await coalescedPagesFixture();
  const imported = `runtimeContext.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}))`;
  const sources = fixture.input.sources.map((entry) => {
    if (entry.file !== COALESCED_CHUNK) return entry;
    const code = entry.source.code
      .replace(imported, 'runtimeContext.i(777)')
      .replace('module.exports=[', () => `module.exports=[777,(ctx,module,exports)=>{${body}},`);
    if (!code.includes('runtimeContext.i(777)')) throw new TypeError('Expected the authored edge');
    return { ...entry, source: source(code) };
  });
  return { ...fixture.input, sources };
}

describe('bounded pure literal branches in a CommonJS namespace forwarder', () => {
  it.each(['true', '1', '0.5', '"nodejs"', '("any text",1)', '(null,false,0,"yes")'])(
    'selects a true primitive test without changing the original callback: %s',
    (test) => {
      const original = projection(`if(${test}){${EXPORT}}else{}`);
      const before = JSON.stringify(original);

      expect(directExternalNamespace(original)).toBe(SPECIFIER);
      expect(JSON.stringify(original)).toBe(before);
    },
  );

  it.each(['false', '0', '""', 'null', '("any text",0)', '(1,true,"",null)'])(
    'selects a false primitive test without marker authority: %s',
    (test) => {
      expect(directExternalNamespace(projection(`if(${test}){}else{${EXPORT}}`))).toBe(SPECIFIER);
    },
  );

  it.each([
    `if(true)${EXPORT}`,
    `if(true){${EXPORT}}else;`,
    `if(false);else ${EXPORT}`,
    `if(true){{${EXPORT}}}else{}`,
    `if(false){}else if(true){${EXPORT}}`,
    `"use strict";if(false){}else{if(("TURBOPACK compile-time truthy",1)){${EXPORT}}}`,
    `if(("TURBOPACK compile-time falsy",1)){${EXPORT}}`,
  ])('recognizes only the selected bounded single-statement structure: %s', (body) => {
    expect(directExternalNamespace(projection(body))).toBe(SPECIFIER);
  });

  it('retains direct-assignment semantics for ordinary function callbacks', () => {
    expect(directExternalNamespace(projection(`if(true){${EXPORT}}`, true))).toBe(SPECIFIER);
  });

  it.each([
    ['if(true){module.exports=ctx.r(7);}else{}', 'turbopack:7'],
    ['if(false){}else{module.exports=ctx.r("7");}', 'turbopack:string:"7"'],
  ])('preserves the type of the actual static require port: %s', (body, expected) => {
    expect(directExternalNamespace(projection(body))).toBe(expected);
  });

  it.each([
    'process.env.TURBOPACK',
    'knownFlag',
    'undefined',
    'NaN',
    'Infinity',
    '1e999',
    '/literal/',
    '0n',
    '!0',
    '-1',
    '[]',
    '{}',
    '"true"===mode',
    '(unknown(),1)',
    '(process.env.TURBOPACK,1)',
    '("TURBOPACK compile-time truthy",unknownFlag)',
  ])('refuses an unknown, effectful or unsupported test: %s', (test) => {
    expect(directExternalNamespace(projection(`if(${test}){${EXPORT}}else{}`))).toBeUndefined();
  });

  it.each([
    'effect();',
    'unknown;',
    'throw new Error("dead");',
    'var other=1;',
    'function hidden(){}',
    'if(false){}',
    '"use strict";',
    ';',
    `module.exports=${CALL};`,
    'ctx.r(8);',
  ])('refuses nonempty unselected code rather than dropping it: %s', (dead) => {
    expect(directExternalNamespace(projection(`if(true){${EXPORT}}else{${dead}}`))).toBeUndefined();
  });

  it.each([
    `{${EXPORT}}`,
    `if(true){effect();${EXPORT}}`,
    `if(true){${EXPORT}effect();}`,
    `if(true){var namespace=${CALL};module.exports=namespace;}`,
    `if(true){for(;;){${EXPORT}}}`,
    `if(true){module.exports=${CALL}.PagesRouteModule;}`,
    `if(true){module.exports=ctx.i(7);}`,
    `if(true){module.exports=(0,${CALL});}`,
    `if(true){module.exports={namespace:${CALL}};}`,
  ])('does not compose aliases, loops, effects or changed leaf values: %s', (body) => {
    expect(directExternalNamespace(projection(body))).toBeUndefined();
  });

  it('bounds both the structural selector and literal sequence length', () => {
    const deep = 'if(true){'.repeat(40) + EXPORT + '}'.repeat(40);
    const many = Array.from({ length: 65 }, () => '1').join(',');
    const within = Array.from({ length: 64 }, () => '1').join(',');

    expect(directExternalNamespace(projection(deep))).toBeUndefined();
    expect(directExternalNamespace(projection(`if((${many})){${EXPORT}}`))).toBeUndefined();
    expect(directExternalNamespace(projection(`if((${within})){${EXPORT}}`))).toBe(SPECIFIER);
  });

  it('keeps a dead extra import in the full original projection and refuses classification', () => {
    const original = projection(`if(true){${EXPORT}}else{ctx.r(8);}`);

    expect(original.imports).toContainEqual({
      kind: 'require',
      targetId: 8,
      specifier: 'turbopack:8',
    });
    expect(directExternalNamespace(original)).toBeUndefined();
  });

  it('reprojects the whole original source and rejects stale registration/SHA', () => {
    const original = projection(`if(true){${EXPORT}}`);

    expect(() => directExternalNamespace({ ...original, moduleId: 999 })).toThrow(
      'unknown module id',
    );
    expect(() => {
      directExternalNamespace({
        ...original,
        original: { ...original.original, sha256: '0'.repeat(64) },
      });
    }).toThrow('source');
  });

  it('closes the actual constructor edge without removing the outer normalization obligation', async () => {
    const body = `if(("any label",0)){}else{if((null,true)){${EXPORT}}}`;
    const input = await protectedGraph(body);
    const proof = await proveNodeManifestTurbopackConsumers(input);

    expect(proof.terminals.map((terminal) => terminal.file)).toStrictEqual([COALESCED_ENTRY]);
    expect(proof.requiresSdkNormalization).toBe(true);
  });

  it('does not authorize a nonempty dead branch in the protected consumer graph', async () => {
    const input = await protectedGraph(`if(true){${EXPORT}}else{unknown;}`);

    await expect(proveNodeManifestTurbopackConsumers(input)).rejects.toThrow(
      'consumer without a sealed route',
    );
  });
});
