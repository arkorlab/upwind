import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import {
  certifyNodeManifestHoist,
  nodeManifestHoistMember,
  type NodeManifestHoistInput,
} from '../src/node-manifest-hoist.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackImport,
  type NodeManifestTurbopackModuleId,
} from '../src/node-manifest-turbopack.ts';

// Pinned Next29bbe helpers.ts Git blob747c05fbc25acdeb1a1a6ebe9480e0a049211ff3.
const HOIST = `function hoist(module,name){
  if(name in module){return module[name];}
  if('then' in module && typeof module.then === 'function'){
    return module.then((mod)=>hoist(mod,name));
  }
  if(typeof module === 'function' && name === 'default'){return module;}
  return undefined;
}`;
const CONDITIONAL_HOIST = `function hoist(module,name){return name in module?module[name]:
  'then' in module&&typeof module.then==='function'?module.then(mod=>hoist(mod,name)):
  typeof module==='function'&&name==='default'?module:undefined;}`;
interface FixtureOptions {
  readonly id?: NodeManifestTurbopackModuleId;
  readonly ids?: readonly NodeManifestTurbopackModuleId[];
  readonly name?: string;
  readonly helper?: string;
  readonly registration?: string;
  readonly before?: string;
  readonly after?: string;
  readonly prefix?: string;
  readonly params?: string;
}
function source(code: string) {
  return { code, sha256: createHash('sha256').update(code).digest('hex') };
}
function resolvedImport(entry: NodeManifestTurbopackImport) {
  return { specifier: entry.specifier, target: `actual:${entry.specifier}` };
}
function fixture(options: FixtureOptions = {}): NodeManifestHoistInput {
  const id = options.id ?? 1;
  const ids = options.ids ?? [id];
  const name = options.name ?? 'f';
  const registration = options.registration ?? `ctx.s([${jsLiteral(name)},()=>hoist]);`;
  const body = `${options.before ?? ''}${registration}${options.helper ?? HOIST}${options.after ?? ''}`;
  const code = `${options.prefix ?? '"use strict";'}module.exports=[${ids.map((value) => jsLiteral(value)).join(',')},(${options.params ?? 'ctx,m,e'})=>{${body}}];`;
  const projection = projectNodeManifestTurbopackFactory(source(code), id, 'dependencies');
  return {
    owner: { identity: Symbol('build-owner') },
    exportName: name,
    factory: {
      id: 'actual-logical-factory',
      runtimeId: 'actual-runtime',
      physicalId: 'actual-source',
      projection,
      imports: projection.imports.map((entry) => resolvedImport(entry)),
    },
  };
}
function certify(input: NodeManifestHoistInput): 'hoist' | undefined {
  const proof = certifyNodeManifestHoist(input);

  expect(Object.isFrozen(proof)).toBe(true);

  return nodeManifestHoistMember(proof, input);
}

describe('source-bound selected hoist helper', () => {
  it.each(['hoist', 'f', 'independently-mangled-key'])(
    'certifies the actual %s export through its whole lexical function',
    (name) => {
      expect(certify(fixture({ name }))).toBe('hoist');
    },
  );

  it('supports direct value exports and binding-preserving function alpha renaming', () => {
    const helper = HOIST.replaceAll('hoist', 'h')
      .replaceAll('module', 'a')
      .replaceAll('name', 'b')
      .replaceAll('mod', 'c');

    expect(certify(fixture({ helper, registration: 'ctx.s(["f",0,h]);' }))).toBe('hoist');
  });

  it.each([HOIST, CONDITIONAL_HOIST])(
    'certifies a whole inline named function value without borrowing an outer self name',
    (helper) => {
      const inline = helper.replaceAll('hoist', 'self');
      const input = fixture({
        helper: '',
        before: 'const self="unrelated outer binding";',
        registration: `ctx.s(["f",0,${inline}]);`,
      });

      expect(certify(input)).toBe('hoist');
    },
  );

  it('certifies only the primary ordered conditional-return branches', () => {
    expect(certify(fixture({ helper: CONDITIONAL_HOIST }))).toBe('hoist');
  });

  it.each(['==', '==='])(
    'allows only typeof-string equality folding (%s) and immutable void zero',
    (operator) => {
      const helper = CONDITIONAL_HOIST.replace(
        "typeof module.then==='function'",
        () => `'function'${operator}typeof module.then`,
      )
        .replace("typeof module==='function'", () => `'function'${operator}typeof module`)
        .replace('undefined', 'void 0');

      expect(certify(fixture({ helper }))).toBe('hoist');
    },
  );

  it('certifies the combined inline named minimized profile with genuine strictness', () => {
    const inline = CONDITIONAL_HOIST.replaceAll('hoist', 'h')
      .replaceAll('module', 'a')
      .replaceAll('name', 'b')
      .replaceAll('mod', 'c')
      .replace("typeof a.then==='function'", '"function"==typeof a.then')
      .replace("typeof a==='function'", '"function"==typeof a')
      .replace('undefined', 'void 0');
    const input = fixture({ helper: '', registration: `ctx.s(["f",0,${inline}]);` });

    expect(certify(input)).toBe('hoist');
  });

  it.each([HOIST, CONDITIONAL_HOIST])(
    'keeps strict default equality equivalent in either literal operand order',
    (profile) => {
      const inline = profile.replace(/name\s*===\s*'default'/u, '"default"===name');
      const input = fixture({ helper: '', registration: `ctx.s(["f",0,${inline}]);` });

      expect(certify(input)).toBe('hoist');
    },
  );

  it.each([1, '1'])(
    'binds the selected typed registered ID %s without granting a foreign cache ID',
    (id) => {
      const input = fixture({
        id,
        ids: [1, '1'],
        registration: `ctx.s(["f",()=>hoist],${jsLiteral(id)});`,
      });

      expect(certify(input)).toBe('hoist');
    },
  );

  it.each(['null', 'undefined', 'void 0'])(
    'preserves the exact runtime default export target %s',
    (target) => {
      expect(certify(fixture({ registration: `ctx.s(["f",()=>hoist],${target});` }))).toBe('hoist');
    },
  );

  it('retains the complete other grouped body and dependency ledger without certifying it', () => {
    const input = fixture({
      ids: [1, 2],
      registration: 'ctx.s(["f",()=>hoist],1);ctx.v(42,2);',
      before: 'const ordinary=ctx.r(2);',
    });
    const before = JSON.stringify(input.factory);

    expect(certify(input)).toBe('hoist');

    expect(JSON.stringify(input.factory)).toBe(before);
    expect(input.factory.projection.imports).toStrictEqual([
      { kind: 'require', targetId: 2, specifier: 'turbopack:2' },
    ]);
    expect(input.factory.projection.exports).toStrictEqual({ kind: 'opaque' });
  });

  it('allows only direct top-level comma operands while retaining every typed grouped registration', () => {
    const input = fixture({
      ids: [1, '1'],
      registration: '(ctx.s(["f",()=>hoist],1),ctx.s(["other",0,42],"1"));',
    });
    const before = JSON.stringify(input.factory);

    expect(certify(input)).toBe('hoist');
    expect(JSON.stringify(input.factory)).toBe(before);
    expect(input.factory.projection.factory.ids).toStrictEqual([1, '1']);
  });

  it('accepts genuine function-local strictness while preserving original bytes', () => {
    const input = fixture({ prefix: '', helper: HOIST.replace('{', '{"use strict";') });
    const before = input.factory.projection.original.code;

    expect(certify(input)).toBe('hoist');

    expect(input.factory.projection.original.code).toBe(before);
  });

  it.each([
    { helper: HOIST.replace('return module[name]', 'return module.default') },
    { helper: HOIST.replace('hoist(mod,name)', 'mod(mod,name)') },
    { helper: HOIST.replace('return undefined', 'return captured'), before: 'const captured=42;' },
    { helper: HOIST, before: 'const undefined=42;' },
    { helper: HOIST.replace('return undefined', 'effect();return undefined') },
    { helper: HOIST.replace('function hoist', 'async function hoist') },
    { helper: HOIST.replace('function hoist', 'function* hoist') },
    { helper: HOIST.replace('(module,name)', '(module,name="default")') },
    { helper: HOIST, after: 'hoist=globalThis.replacement;' },
    { helper: HOIST, after: 'function later(){hoist=globalThis.replacement;}' },
    { helper: HOIST, after: 'consume(hoist);' },
    { helper: HOIST, after: 'const alias=hoist;' },
    { helper: HOIST, after: 'var hoist;' },
    { helper: HOIST, after: 'function hoist(){return 42;}' },
    { helper: HOIST, after: 'Object.defineProperty(hoist,"name",{value:"changed"});' },
    { helper: HOIST, after: 'm.exports=globalThis.replacement;' },
    { helper: HOIST, after: 'e.f=globalThis.replacement;' },
    { helper: HOIST, after: 'module.exports=globalThis.replacement;', params: 'ctx' },
    { helper: HOIST, prefix: '' },
    { helper: HOIST, prefix: '("use strict");' },
    { helper: HOIST.replaceAll('module', 'undefined') },
    { helper: HOIST.replaceAll('hoist', 'undefined'), registration: 'ctx.s(["f",()=>undefined]);' },
    { helper: CONDITIONAL_HOIST.replace("name==='default'", "name=='default'") },
    { helper: CONDITIONAL_HOIST.replace("typeof module==='function'", "typeof module==='object'") },
    { helper: CONDITIONAL_HOIST.replace('undefined', 'void effect()') },
    { helper: CONDITIONAL_HOIST.replace('module[name]', '(effect(),module[name])') },
    { helper: CONDITIONAL_HOIST.replace("'then' in module&&", '') },
    {
      helper: CONDITIONAL_HOIST.replace(
        'module.then(mod=>hoist(mod,name))',
        'module.then(mod=>mod(mod,name))',
      ),
    },
  ])('refuses altered body/captures/bindings: %j', (options) => {
    expect(() => certifyNodeManifestHoist(fixture(options))).toThrow('Unproved Next.js');
  });

  it.each([
    HOIST.replace('function hoist', 'function'),
    HOIST.replace('hoist(mod,name)', 'outer(mod,name)'),
    HOIST.replace('return undefined', 'hoist=globalThis.other;return undefined'),
    HOIST.replace('return undefined', 'effect();return undefined'),
    HOIST.replaceAll('module', 'hoist'),
    HOIST.replaceAll('module', 'undefined'),
    CONDITIONAL_HOIST.replace('module[name]', '(hoist=globalThis.other,module[name])'),
    CONDITIONAL_HOIST.replace('hoist(mod,name)', '((hoist)=>hoist(mod,name))(globalThis.other)'),
  ])('refuses unproved inline self binding, captures and effects: %s', (inline) => {
    expect(() =>
      certifyNodeManifestHoist(fixture({ helper: '', registration: `ctx.s(["f",0,${inline}]);` })),
    ).toThrow('Unproved Next.js');
  });

  it.each([
    'ctx.s(["f",()=>hoist],"1");',
    'ctx.s(["f",()=>hoist],2);',
    'ctx.s(["other",()=>hoist]);',
    'ctx.s(["f",()=>hoist,"other",()=>hoist]);',
    'ctx.s(["f",()=>hoist]);ctx.s(["f",()=>hoist]);',
    'if(globalThis.flag){ctx.s(["f",()=>hoist]);}',
    'ctx.s(["f",()=>{effect();return hoist;}]);',
    'ctx.s(["f",function named(){return hoist;}]);',
    'ctx.s(["f",()=>hoist],undefined,true);',
    'function unrelated(ctx){ctx.s(["f",()=>hoist]);}',
    'ctx.v(hoist);',
    'return (ctx.s(["f",()=>hoist]),42);',
    'consume((ctx.s(["f",()=>hoist]),42));',
    '(ctx.s(["f",()=>hoist]),consume)();',
    'globalThis.flag&&(ctx.s(["f",()=>hoist]),42);',
    'globalThis.flag?(ctx.s(["f",()=>hoist]),42):0;',
    'function later(){(ctx.s(["f",()=>hoist]),42);}',
    '(ctx.s(["f",()=>hoist]),hoist=globalThis.other);',
  ])('refuses unproved selected export mapping: %s', (registration) => {
    expect(() => certifyNodeManifestHoist(fixture({ registration }))).toThrow('Unproved Next.js');
  });

  it('keeps a nested shadow independent while refusing any real outer helper use', () => {
    expect(
      certify(
        fixture({
          after: 'function local(hoist){return hoist;}class Shadow{method(hoist){return hoist;}}',
        }),
      ),
    ).toBe('hoist');

    expect(() =>
      certifyNodeManifestHoist(fixture({ after: 'function local(){return hoist;}' })),
    ).toThrow('helper alias');
  });

  it('does not transfer a token to copied proof/owner/factory/projection/original identities', () => {
    const input = fixture();
    const proof = certifyNodeManifestHoist(input);
    const projection = input.factory.projection;
    const copies = [
      { ...input, owner: { identity: input.owner.identity } },
      { ...input, factory: { ...input.factory } },
      { ...input, factory: { ...input.factory, projection: { ...projection } } },
      {
        ...input,
        factory: {
          ...input.factory,
          projection: { ...projection, original: { ...projection.original } },
        },
      },
    ];

    expect(nodeManifestHoistMember({ ...proof }, input)).toBeUndefined();

    for (const copied of copies) expect(nodeManifestHoistMember(proof, copied)).toBeUndefined();

    expect(nodeManifestHoistMember(proof, { ...input, exportName: 'hoist' })).toBeUndefined();
  });

  it.each([
    'identity',
    'imports',
    'mode',
    'module',
    'ids',
    'range',
    'exports',
    'cache',
    'async',
    'source',
  ] as const)(
    'does not borrow a private token after %s mutation of its original objects',
    (field) => {
      const input = fixture();
      const proof = certifyNodeManifestHoist(input);
      const projection = input.factory.projection;
      const mutations = {
        identity: () => Object.assign(input.factory, { runtimeId: 'different-runtime' }),
        imports: () =>
          Object.assign(input.factory, { imports: [{ specifier: 'other', target: 'other' }] }),
        mode: () => Object.assign(projection, { mode: 'strict' }),
        module: () => Object.assign(projection, { moduleId: '1' }),
        ids: () => Object.assign(projection.factory, { ids: [1, 2] }),
        range: () => Object.assign(projection.factory, { start: projection.factory.start + 1 }),
        exports: () => Object.assign(projection, { exports: { kind: 'commonjs' } }),
        cache: () =>
          Object.assign(projection, { cacheInitializers: [{ id: 2, start: 0, end: 1 }] }),
        async: () => Object.assign(projection, { asyncLoads: [2] }),
        source: () =>
          Object.assign(projection.original, source(`${projection.original.code}\nchanged();`)),
      };
      mutations[field]();

      expect(nodeManifestHoistMember(proof, input)).toBeUndefined();
    },
  );

  it('requires a full fresh projection for minting rather than trusting a source hash or member name', () => {
    const input = fixture();
    Object.assign(input.factory.projection, {
      boundRuntimeInputs: [{ kind: 'require', identifier: 'fake' }],
    });

    expect(() => certifyNodeManifestHoist(input)).toThrow('projection binding');
  });
});
