import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { parseAst } from 'rolldown/parseAst';
import { assert, describe, expect, it } from 'vitest';

import { isNode, listOf } from '../src/lexical-scope.ts';
import {
  certifyNodeManifestRouteKind,
  nodeManifestRouteKindMember,
  type NodeManifestRouteKindProof,
} from '../src/node-manifest-route-kind.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackModuleId,
} from '../src/node-manifest-turbopack.ts';

const PRIMARY_SHA = '4dc92760c2e4925613034896faa04c52daaf7a4420d7bcbd6de5214b55d84fea';
async function primaryInitializer(): Promise<string> {
  const primary = await readFile(
    new URL(import.meta.resolve('next/dist/server/route-kind.js')),
    'utf8',
  );
  if (createHash('sha256').update(primary).digest('hex') !== PRIMARY_SHA)
    throw new Error('Expected fixed published RouteKind source');
  const parsed: unknown = parseAst(primary);
  assert(isNode(parsed));
  const declaration = listOf(parsed, 'body').find(
    (node) => isNode(node) && node.type === 'VariableDeclaration',
  );
  assert(isNode(declaration));
  const variable = listOf(declaration, 'declarations')[0];
  assert(isNode(variable) && isNode(variable['init']));
  return primary.slice(variable['init'].start, variable['init'].end);
}
const INITIALIZER = await primaryInitializer();

function fixture(
  options: {
    readonly initializer?: string;
    readonly id?: NodeManifestTurbopackModuleId;
    readonly target?: NodeManifestTurbopackModuleId;
    readonly name?: string;
    readonly extra?: string;
    readonly before?: string;
    readonly direct?: boolean;
    readonly sequence?: boolean;
    readonly parameters?: string;
    readonly binding?: string;
  } = {},
) {
  const selected = options.id ?? 2;
  const target = options.target === undefined ? '' : `,${JSON.stringify(options.target)}`;
  const name = options.name ?? 'k';
  const binding = options.binding ?? (options.direct === true ? `0,Enum` : '()=>Enum');
  const call = `ctx.s([${JSON.stringify(name)},${binding}]${target})`;
  const registration = options.sequence === true ? `(0,${call},void 0);` : `${call};`;
  const body = `${options.before ?? ''}var Enum=${options.initializer ?? INITIALIZER};${registration}${options.extra ?? ''}`;
  const code = `module.exports=[${JSON.stringify(selected)},(${options.parameters ?? 'ctx,module,exports'})=>{"use strict";${body}}];`;
  const source = { code, sha256: createHash('sha256').update(code).digest('hex') };
  const projection = projectNodeManifestTurbopackFactory(source, selected, 'dependencies');
  return {
    owner: { identity: Symbol('source control owner') },
    exportName: name,
    factory: {
      id: 'owned-selected',
      physicalId: 'owned-chunk',
      projection,
      imports: [] as { specifier: string; target: string }[],
    },
  };
}

describe('selected pinned RouteKind template member', () => {
  it.each(['function(){}', '()=>42', '42', 'effect()'])(
    'does not classify an unrelated direct value as the enum: %s',
    (value) => {
      expect(certifyNodeManifestRouteKind(fixture({ binding: `0,${value}` }))).toBeUndefined();
    },
  );

  it.each([false, true])(
    'binds the entire published enum through a compact export (direct %s)',
    (direct) => {
      const input = fixture({ direct });
      const proof = certifyNodeManifestRouteKind(input);
      assert(proof !== undefined);

      expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
      expect(nodeManifestRouteKindMember({ ...proof }, input)).toBeUndefined();
    },
  );

  it('accepts the same whole enum with compiler-equivalent static dot members', () => {
    const initializer = INITIALIZER.replaceAll(
      /\["([A-Z_]+)"\]/gu,
      (_match, name: string) => `.${name}`,
    );
    const input = fixture({ initializer, id: '2', target: '2' });
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
  });

  it('keeps a selected registration in an unconditional top-level comma sequence', () => {
    const input = fixture({ sequence: true });
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
  });

  it.each([
    '(function(e){return e.PAGES="PAGES",e.PAGES_API="PAGES_API",e.APP_PAGE="APP_PAGE",e.APP_ROUTE="APP_ROUTE",e.IMAGE="IMAGE",e;})({})',
    '(()=>{const e={};return e.PAGES="PAGES",(e.PAGES_API="PAGES_API",e.APP_PAGE="APP_PAGE"),e.APP_ROUTE="APP_ROUTE",e.IMAGE="IMAGE",e;})()',
    '(e=>(e.PAGES="PAGES",e.PAGES_API="PAGES_API",e.APP_PAGE="APP_PAGE",e.APP_ROUTE="APP_ROUTE",e.IMAGE="IMAGE",e))({})',
  ])('accepts only the closed minified single-object producer: %s', (initializer) => {
    const input = fixture({ initializer });
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
  });

  const OUTER =
    '(t={},t.PAGES="PAGES",t.PAGES_API="PAGES_API",t.APP_PAGE="APP_PAGE",t.APP_ROUTE="APP_ROUTE",t.IMAGE="IMAGE",t)';
  const FUSED =
    '((t={}).PAGES="PAGES",t.PAGES_API="PAGES_API",t.APP_PAGE="APP_PAGE",t.APP_ROUTE="APP_ROUTE",t.IMAGE="IMAGE",t)';

  it.each(['var t;', 'let t;'])('proves an original factory-local temporary with %s', (before) => {
    const input = fixture({ before, initializer: OUTER });
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
  });

  it.each(['var t;', 'let t;'])(
    'proves fresh allocation in the first field write with %s',
    (before) => {
      const input = fixture({ before, initializer: FUSED });
      const proof = certifyNodeManifestRouteKind(input);
      assert(proof !== undefined);

      expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
    },
  );

  it('keeps a literal computed first field and nested comma grouping equivalent', () => {
    const initializer = FUSED.replace('.PAGES=', '["PAGES"]=').replace(
      't.PAGES_API="PAGES_API",t.APP_PAGE="APP_PAGE"',
      '(t.PAGES_API="PAGES_API",t.APP_PAGE="APP_PAGE")',
    );
    const input = fixture({ before: 'var t;', initializer });
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
  });

  it.each([
    FUSED.replace('t={}', 't={other:1}'),
    FUSED.replace('.PAGES="PAGES"', '.PAGES_API="PAGES_API"'),
    FUSED.replace('t.APP_PAGE="APP_PAGE"', '(t={}).APP_PAGE="APP_PAGE"'),
    FUSED.replace(
      't.PAGES_API="PAGES_API",t.APP_PAGE="APP_PAGE"',
      't.APP_PAGE="APP_PAGE",t.PAGES_API="PAGES_API"',
    ),
  ])('refuses a changed fused allocation, object, first property or order: %s', (initializer) => {
    const input = fixture({ before: 'var t;', initializer });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it.each(['const alias=t;', 'function change(){t.IMAGE="other";}', 'var t;'])(
    'retains the whole-original fused temporary ledger: %s',
    (extra) => {
      const input = fixture({ before: 'var t;', initializer: FUSED, extra });

      expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
    },
  );

  it.each([
    ['preinitialized temporary', 'var t={};', ''],
    ['additional read', 'var t;', 'consume(t);'],
    ['nested mutation', 'var t;', 'function change(){t.IMAGE="other";}'],
    ['alias escape', 'var t;', 'const other=t;'],
    ['later redeclaration', 'var t;', 'var t;'],
  ])('refuses outer temporary %s', (_name, before, extra) => {
    const input = fixture({ before, extra, initializer: OUTER });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it.each([
    OUTER.replace('t.IMAGE="IMAGE"', 't.IMAGE="PAGES"'),
    OUTER.replace(
      't.PAGES="PAGES",t.PAGES_API="PAGES_API"',
      't.PAGES_API="PAGES_API",t.PAGES="PAGES"',
    ),
    OUTER.replace('t.APP_PAGE="APP_PAGE"', 't={},t.APP_PAGE="APP_PAGE"'),
    OUTER.replace('t.IMAGE="IMAGE"', 't[key]="IMAGE"'),
    OUTER.replace(',t)', ',{})'),
  ])('refuses an altered flattened enum construction: %s', (initializer) => {
    const input = fixture({ before: 'var t;', initializer });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it('rejects cross-owner, cloned-factory and selector borrowing', () => {
    const input = fixture();
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(
      nodeManifestRouteKindMember(proof, {
        ...input,
        owner: { identity: Symbol('another owner') },
      }),
    ).toBeUndefined();
    expect(
      nodeManifestRouteKindMember(proof, { ...input, factory: { ...input.factory } }),
    ).toBeUndefined();
    expect(nodeManifestRouteKindMember(proof, { ...input, exportName: 'other' })).toBeUndefined();
  });

  it('rejects a same-content replacement projection and changed dependency identity', () => {
    const input = fixture();
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);
    const projection = input.factory.projection;
    input.factory.projection = { ...projection };

    expect(nodeManifestRouteKindMember(proof, input)).toBeUndefined();

    input.factory.projection = projection;
    input.factory.imports.push({ specifier: 'other', target: 'another' });

    expect(nodeManifestRouteKindMember(proof, input)).toBeUndefined();
  });

  it.each([
    ['changed member', INITIALIZER.replace('= "PAGES_API"', '= "PAGES"')],
    [
      'extra effect',
      INITIALIZER.replace('return RouteKind;', 'consume(RouteKind);return RouteKind;'),
    ],
    ['captured value', INITIALIZER.replace('"PAGES";', 'outside;')],
    ['missing member', INITIALIZER.replace(/RouteKind\["IMAGE"\] = "IMAGE";/u, '')],
  ])('refuses a %s initializer', (_name, initializer) => {
    const input = fixture({ initializer });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it.each([
    'Enum.PAGES="APP_ROUTE";',
    'function later(){Enum.PAGES="APP_ROUTE";}',
    'const alias=Enum;',
    'consume(Enum);',
    'exports.escaped=Enum;',
    'var Enum;',
  ])('refuses mutation, alias escape or extra binding use: %s', (extra) => {
    const input = fixture({ extra });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it('keeps genuine lexical shadows separate from the certified binding', () => {
    const input = fixture({
      extra: 'function unrelated(Enum){Enum.PAGES="other";}',
    });
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
  });

  it.each([
    'const page=Enum.PAGES;const route=Enum.APP_ROUTE;const pair=[page,route];',
    'const api=Enum["PAGES_API"];const image=Enum["IMAGE"];',
    'function getKind(){return Enum.APP_PAGE;}const isPage=Enum.PAGES==="PAGES";',
  ])('permits only known scalar member reads without exporting the enum object: %s', (extra) => {
    const input = fixture({ extra });
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
  });

  it.each([
    'Enum.PAGES="other";',
    'Enum.PAGES.x=1;',
    'Enum.PAGES+=1;',
    'Enum.PAGES++;',
    'delete Enum.PAGES;',
    'delete Enum.PAGES.x;',
    '({p:Enum.PAGES}=source);',
    '[Enum.PAGES]=source;',
    '[...Enum.PAGES]=source;',
    'for(Enum.PAGES in source){}',
    'for({p:Enum.PAGES} of source){}',
    'const alias=Enum;',
    'const holder={value:Enum};',
    'const unknown=Enum.UNKNOWN;',
    'const dynamic=Enum[key];',
    'const optional=Enum?.PAGES;',
  ])('refuses write targets, object escapes and unknown scalar reads: %s', (extra) => {
    const input = fixture({ extra });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it('refuses an eager scalar read before the enum initializer has completed', () => {
    const input = fixture({ before: 'const early=Enum.PAGES;' });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it.each([
    'ctx.n({k:{PAGES:"APP_ROUTE"}});',
    'ctx.v({k:{PAGES:"APP_ROUTE"}});',
    'ctx.n({k:{PAGES:"APP_ROUTE"}},2);',
    'ctx.v({k:{PAGES:"APP_ROUTE"}},2);',
    'ctx.s(["other",()=>42]);',
    'function replace(){ctx.n({k:{PAGES:"APP_ROUTE"}});}',
    'function replace(){ctx.v({k:{PAGES:"APP_ROUTE"}});}',
  ])('refuses every additional same-selected namespace/value registration: %s', (extra) => {
    const input = fixture({ extra });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it.each(['ctx.n({k:{PAGES:"APP_ROUTE"}});', 'ctx.v({k:{PAGES:"APP_ROUTE"}});'])(
    'refuses a prior same-selected registration: %s',
    (before) => {
      const input = fixture({ before });

      expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
    },
  );

  it.each(['ctx.n({other:42},99);', 'ctx.v({other:42},"2");', 'ctx.s(["other",()=>42],99);'])(
    'preserves independent typed other-ID registrations: %s',
    (extra) => {
      const input = fixture({ extra });
      const proof = certifyNodeManifestRouteKind(input);
      assert(proof !== undefined);

      expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
    },
  );

  it.each([
    'module.exports={k:{PAGES:"APP_ROUTE"}};',
    'exports.k={PAGES:"APP_ROUTE"};',
    'const own=module;own.exports={};',
    'const own=exports;own.k={};',
    'const {exports:own}=module;own.k={};',
    'consume(module);',
    'function replace(){module.exports={};}',
  ])('refuses actual CommonJS namespace uses and aliases: %s', (extra) => {
    const input = fixture({ extra });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it('binds CommonJS parameter roles even when their names were minified', () => {
    const input = fixture({ parameters: 'ctx,m,e', extra: 'const own=m;own.exports={};' });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
  });

  it('keeps genuine CommonJS and context parameter shadows separate', () => {
    const input = fixture({
      extra: 'function local(ctx,module,exports){ctx.n({});module.exports=exports;}',
    });
    const proof = certifyNodeManifestRouteKind(input);
    assert(proof !== undefined);

    expect(nodeManifestRouteKindMember(proof, input)).toBe('RouteKind');
  });

  it.each(['module.exports={};', 'const own=exports;consume(own);'])(
    'preserves original projection refusal of ambient outer CommonJS uses: %s',
    (extra) => {
      expect(() => fixture({ parameters: 'ctx', extra })).toThrow(
        'outer CommonJS export reference',
      );
    },
  );

  it('does not accept a foreign cache target or number/string target confusion', () => {
    const input = fixture({ id: 2, target: '2' });

    expect(certifyNodeManifestRouteKind(input)).toBeUndefined();
    expect(nodeManifestRouteKindMember({} as NodeManifestRouteKindProof, input)).toBeUndefined();
  });

  it('rejects altered source bytes even if its digest field was not changed', () => {
    const input = fixture();
    const original = input.factory.projection.original;
    input.factory.projection = {
      ...input.factory.projection,
      original: { ...original, code: `${original.code}\n;` },
    };

    expect(() => certifyNodeManifestRouteKind(input)).toThrow('source byte identity');
  });
});
