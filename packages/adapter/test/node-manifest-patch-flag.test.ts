import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { normalizedGlobalInspection } from '../src/node-closure-globals.ts';
import { projectNodeManifestTurbopackFactory } from '../src/node-manifest-turbopack.ts';

const CLEAR = 'globalThis.__next__clear_chunk_cache__=ctx.C;';
const BINDING = 'const FLAG=Symbol.for("next-patch");';
const READ = 'ctx.v(globalThis[FLAG]===true);';

function source(body: string) {
  const code = `module.exports=[1,ctx=>{${CLEAR}${body}}];`;
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}

function project(body: string) {
  return projectNodeManifestTurbopackFactory(source(body), 1, 'dependencies');
}

describe('c-certified fixed next-patch boolean flag', () => {
  it.each([
    'globalThis[Symbol.for("next-patch")]=true;ctx.v(globalThis[Symbol.for("next-patch")]===true);',
    'globalThis[Symbol.for("next-patch")]=!0;ctx.v(!0===globalThis[Symbol.for("next-patch")]);',
    `${BINDING}globalThis[FLAG]=true;${READ}`,
    `${BINDING}function isFetchPatched(){return globalThis[FLAG]===true;}function patch(){globalThis[FLAG]=true;}ctx.v({isFetchPatched,patch});`,
    'var FLAG=Symbol.for("next-patch");globalThis[FLAG]=!0;ctx.v(globalThis[FLAG]!==!0);',
    'let FLAG=Symbol.for("next-patch");globalThis[FLAG]=true;ctx.v(true!==globalThis[FLAG]);',
    `${BINDING}(sideEffect(),globalThis[FLAG]=!0,last());${READ}`,
  ])('preserves the original boolean flag and physical source bytes: %s', (body) => {
    const original = source(body);
    const projected = project(body);

    expect(projected.original).toStrictEqual(original);
    expect(projected.source.code.trim()).toBe(`void 0;${body}`);
    expect(projected.imports).toStrictEqual([]);
    expect(projected.boundRuntimeInputs).toStrictEqual([]);
  });

  it('keeps a genuinely shadowed local globalThis and Symbol separate from host authority', () => {
    const body =
      'function local(globalThis,Symbol){return globalThis[Symbol.for("unknown")];}ctx.v(local);';

    expect(project(body).original).toStrictEqual(source(body));
  });

  it.each([
    ['unknown registry key', `${BINDING.replace('next-patch', 'unknown')}${READ}`],
    ['unknown global key', 'ctx.v(globalThis[unknown]===true);'],
    ['string instead of symbol', 'ctx.v(globalThis["next-patch"]===true);'],
    ['computed Symbol method', 'ctx.v(globalThis[Symbol["for"]("next-patch")]===true);'],
    ['optional Symbol method', 'ctx.v(globalThis[Symbol?.for("next-patch")]===true);'],
    ['optional global', `${BINDING}ctx.v(globalThis?.[FLAG]===true);`],
    ['context global receiver', `${BINDING}ctx.v(ctx.g[FLAG]===true);`],
    [
      'shadowed Symbol',
      'function local(Symbol){return globalThis[Symbol.for("next-patch")]===true;}ctx.v(local);',
    ],
    ['write false', `${BINDING}globalThis[FLAG]=false;${READ}`],
    ['write function', `${BINDING}globalThis[FLAG]=()=>42;${READ}`],
    ['compound write', `${BINDING}globalThis[FLAG]||=true;${READ}`],
    ['update', `${BINDING}globalThis[FLAG]++;${READ}`],
    ['delete', `${BINDING}delete globalThis[FLAG];${READ}`],
    ['loose comparison', `${BINDING}ctx.v(globalThis[FLAG]==true);`],
    ['false comparison', `${BINDING}ctx.v(globalThis[FLAG]===false);`],
    ['raw value escape', `${BINDING}ctx.v(globalThis[FLAG]);`],
    ['flag call', `${BINDING}globalThis[FLAG]();${READ}`],
    ['flag constructor', `${BINDING}new globalThis[FLAG]();${READ}`],
    ['reflective read', `${BINDING}Reflect.get(globalThis,FLAG);${READ}`],
    ['symbol value escape', `${BINDING}${READ}ctx.v(FLAG);`],
    ['symbol alias', `${BINDING}const ALIAS=FLAG;ctx.v(globalThis[ALIAS]===true);`],
    ['symbol rebinding', `let FLAG=Symbol.for("next-patch");FLAG=unknown;${READ}`],
    ['symbol update', `let FLAG=Symbol.for("next-patch");FLAG++;${READ}`],
    ['duplicate var initialization', `var FLAG=unknown;var FLAG=Symbol.for("next-patch");${READ}`],
    ['conditional var initialization', `if(flag){var FLAG=Symbol.for("next-patch");}${READ}`],
    ['read before initialization', `${READ}${BINDING}`],
    ['Symbol constructor escape', `${BINDING}${READ}ctx.v(Symbol);`],
    ['Symbol.for mutation', `${BINDING}${READ}Symbol.for=unknown;`],
    ['assignment value escape', `${BINDING}ctx.v(globalThis[FLAG]=true);`],
    ['global compiler', `${BINDING}${READ}globalThis.Function("return process")();`],
    ['implicit global receiver', `${BINDING}${READ}ctx.v(this);`],
    ['C slot call', `${BINDING}${READ}globalThis.__next__clear_chunk_cache__();`],
  ])('refuses %s without generic Symbol or computed-global authority', (_name, body) => {
    expect(() => project(body)).toThrow('Unproved Next.js');
  });

  it('keeps the default normalized-global policy closed without the C-certified option', () => {
    expect(() => normalizedGlobalInspection(`${BINDING}${READ}`)).toThrow(
      'dynamic or optional global access',
    );
  });

  it('keeps protected strict projection unchanged', () => {
    expect(() => projectNodeManifestTurbopackFactory(source(`${BINDING}${READ}`), 1)).toThrow(
      'Unproved Next.js',
    );
  });
});
