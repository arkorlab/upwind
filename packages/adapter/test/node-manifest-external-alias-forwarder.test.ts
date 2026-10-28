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

function projection(body: string, ordinary = false, params = 'ctx,module,exports') {
  const callback = ordinary ? `function(${params}){${body}}` : `(${params})=>{${body}}`;
  return projectNodeManifestTurbopackFactory(
    source(`module.exports=[1,${callback}];`),
    1,
    'dependencies',
  );
}
async function protectedGraph(ordinary = false) {
  const fixture = await coalescedPagesFixture();
  const imported = `runtimeContext.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}))`;
  const body = `var mod=${CALL};module.exports=mod;`;
  const callback = ordinary
    ? `function(ctx,module,exports){${body}}`
    : `(ctx,module,exports)=>{${body}}`;
  const sources = fixture.input.sources.map((entry) => {
    if (entry.file !== COALESCED_CHUNK) return entry;
    const code = entry.source.code
      .replace(imported, 'runtimeContext.i(777)')
      .replace('module.exports=[', () => `module.exports=[777,${callback},`);
    if (!code.includes('runtimeContext.i(777)')) throw new TypeError('Expected the authored edge');
    return { ...entry, source: source(code) };
  });
  return { ...fixture.input, sources };
}

describe('the fixed public CommonJS external alias boilerplate', () => {
  it.each([
    [`var mod=${CALL};module.exports=mod;`, SPECIFIER],
    [`"use strict";var mod=${CALL};module.exports=mod;`, SPECIFIER],
    [
      `var namespace=ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}),false);module.exports=namespace;`,
      SPECIFIER,
    ],
    ['var mod=ctx.r(7);module.exports=mod;', 'turbopack:7'],
    ['var mod=ctx.r("7");module.exports=mod;', 'turbopack:string:"7"'],
  ])('recognizes the complete original alias: %s', (body, expected) => {
    const original = projection(body);
    const before = JSON.stringify(original);

    expect(directExternalNamespace(original)).toBe(expected);
    expect(JSON.stringify(original)).toBe(before);
    expect(original.original.code).toContain(body);
  });

  it('uses the actual renamed lexical parameters and local binding', () => {
    const moduleName = 'mod';
    const body = `var value=c.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}));${moduleName}.exports=value;`;

    expect(directExternalNamespace(projection(body, false, `c,${moduleName},out`))).toBe(SPECIFIER);
  });

  it.each([
    `var mod=${CALL};module.exports=mod;`,
    `"use strict";var mod=${CALL};module.exports=mod;`,
    'var mod=ctx.r(7);module.exports=mod;',
  ])(
    'declines ordinary functions rather than assuming mapped arguments equivalence: %s',
    (body) => {
      expect(directExternalNamespace(projection(body, true))).toBeUndefined();
    },
  );

  it.each([
    `let mod=${CALL};module.exports=mod;`,
    `const mod=${CALL};module.exports=mod;`,
    `var mod;mod=${CALL};module.exports=mod;`,
    `var mod=${CALL},other=0;module.exports=mod;`,
    `var {mod}=${CALL};module.exports=mod;`,
    `var mod=${CALL};module.exports=mod.default;`,
    `var mod=${CALL};module.exports={namespace:mod};`,
    `var mod=${CALL};module.exports=other;`,
    `var mod=${CALL};exports.namespace=mod;`,
    `var mod=${CALL};module["exports"]=mod;`,
    `var mod=${CALL};module.exports=(0,mod);`,
    `var mod=${CALL};module.exports=()=>mod;`,
    `var mod=${CALL};mod={};module.exports=mod;`,
    `var mod=${CALL};var mod;module.exports=mod;`,
    `var mod=${CALL};capture(mod);module.exports=mod;`,
    `var mod=${CALL};module.exports=mod;effect();`,
    `effect();var mod=${CALL};module.exports=mod;`,
    `var mod=ctx.i(7);module.exports=mod;`,
    `var mod=ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}),true);module.exports=mod;`,
  ])('declines extra effects, alias uses, mutations and unreviewed shapes: %s', (body) => {
    expect(directExternalNamespace(projection(body))).toBeUndefined();
  });

  it.each(['ctx', 'module', 'exports'])(
    'does not redeclare the actual %s parameter as the local alias',
    (name) => {
      const body = `var ${name}=${CALL};module.exports=${name};`;

      expect(() => projection(body)).toThrow('parameter');
    },
  );

  it.each([
    `var mod=ctx.x(${jsLiteral(SPECIFIER)},()=>{capture(mod);return require(${jsLiteral(SPECIFIER)});});module.exports=mod;`,
    `var require=${CALL};module.exports=require;`,
    `var mod=ctx.x(${jsLiteral(SPECIFIER)},()=>require("different"));module.exports=mod;`,
    'var mod=ctx.r(value);module.exports=mod;',
    'var mod=ctx.r?.(7);module.exports=mod;',
    'var mod=ctx.r.call(ctx,7);module.exports=mod;',
  ])('keeps original projector thunk and bound-loader refusals: %s', (body) => {
    expect(() => projection(body)).toThrow('Unproved Next.js');
  });

  it('preserves the original reader refusal for an async arrow factory', () => {
    const original = source(
      `module.exports=[1,async(ctx,module,exports)=>{var mod=${CALL};module.exports=mod;}];`,
    );

    expect(() => projectNodeManifestTurbopackFactory(original, 1, 'dependencies')).toThrow(
      'factory shape',
    );
  });

  it('cannot borrow another registration or changed original bytes', () => {
    const original = projection(`var mod=${CALL};module.exports=mod;`);

    expect(() => directExternalNamespace({ ...original, moduleId: 2 })).toThrow(
      'unknown module id',
    );
    expect(() => {
      directExternalNamespace({
        ...original,
        original: { ...original.original, sha256: '0'.repeat(64) },
      });
    }).toThrow('source');
  });

  it('retains the actual producer and outer normalization obligation in the protected graph', async () => {
    const proof = await proveNodeManifestTurbopackConsumers(await protectedGraph());

    expect(proof.terminals.map((terminal) => terminal.file)).toStrictEqual([COALESCED_ENTRY]);
    expect(proof.requiresSdkNormalization).toBe(true);
  });

  it('does not authorize an ordinary-function alias as a protected caller', async () => {
    await expect(proveNodeManifestTurbopackConsumers(await protectedGraph(true))).rejects.toThrow(
      'consumer without a sealed route',
    );
  });
});
