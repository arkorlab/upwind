import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { jsLiteral } from '../src/codegen.ts';
import { AuditError } from '../src/dependencies.ts';
import {
  certifyNodeManifestPagesContext,
  isCertifiedNodeManifestPagesContext,
  type NodeManifestPagesContextProof,
} from '../src/node-manifest-pages-context.ts';
import {
  projectNodeManifestTurbopackFactory,
  type NodeManifestTurbopackProjection,
} from '../src/node-manifest-turbopack.ts';

const FILE = '/project/node_modules/next/dist/server/route-modules/pages/module.compiled.js';
const PAGE_SHA = 'b88d690f8f1f34d7458d6f7424dee20aab425252f62f2b60d15740ac0808037f';
const SPECIFIER = 'next/dist/server/route-modules/pages/module.compiled.js';
const CACHE_ENTRY = { id: 'hidden', start: 0, end: 1 } as const;
const METADATA_CHANGES: readonly {
  readonly name: string;
  readonly change: (projection: NodeManifestTurbopackProjection) => NodeManifestTurbopackProjection;
}[] = [
  {
    name: 'dependencies mode',
    change: (projection) => ({ ...projection, mode: 'dependencies' }),
  },
  {
    name: 'cache initializer',
    change: (projection) => ({ ...projection, cacheInitializers: [CACHE_ENTRY] }),
  },
  {
    name: 'async dependency',
    change: (projection) => ({ ...projection, asyncLoads: [2] }),
  },
  {
    name: 'async loader',
    change: (projection) => ({ ...projection, asyncLoader: { targetId: 2, chunks: [] } }),
  },
];

function project(body: string, params = 'ctx,module,exports') {
  const code = `module.exports=[1,(${params})=>{${body}}];`;
  return projectNodeManifestTurbopackFactory(
    { code, sha256: createHash('sha256').update(code).digest('hex') },
    1,
  );
}

function input(projection: NodeManifestTurbopackProjection) {
  const specifier = projection.imports[0]?.specifier;
  if (specifier === undefined) throw new Error('Expected one authored import');
  return { projection, producer: { specifier, file: FILE, sha256: PAGE_SHA } };
}

function proof(body: string, params?: string) {
  return certifyNodeManifestPagesContext(input(project(body, params)));
}

function requiredProof(own: Parameters<typeof certifyNodeManifestPagesContext>[0]) {
  const certificate = certifyNodeManifestPagesContext(own);
  if (certificate === undefined) throw new Error('Expected an actual namespace certificate');
  return certificate;
}

function refused(body: string, params?: string): boolean {
  try {
    return proof(body, params) === undefined;
  } catch (error) {
    if (error instanceof AuditError) return true;
    throw error;
  }
}

describe('pinned standalone Pages context namespace selectors', () => {
  it.each([
    'AppRouterContext',
    'HeadManagerContext',
    'HooksClientContext',
    'HtmlContext',
    'ImageConfigContext',
    'Loadable',
    'LoadableContext',
    'RouterContext',
    'ServerInsertedHtml',
  ])('certifies only the fixed %s namespace without route authority', (name) => {
    const body = `module.exports=ctx.r(2).vendored['contexts'].${name};`;
    const own = input(project(body));
    const certificate = certifyNodeManifestPagesContext(own);

    expect(certificate).toMatchObject({
      kind: 'pages-context-namespace',
      namespace: name,
      root: '/project/node_modules/next',
      file: FILE,
      sha256: PAGE_SHA,
    });
    expect(own.projection.original.code).toContain(body);
    expect(certificate !== undefined && isCertifiedNodeManifestPagesContext(certificate, own)).toBe(
      true,
    );
  });

  it.each(['ctx.i(2)', 'ctx.r("2")', 'ctx.r(0)'])(
    'retains the actual typed import for %s',
    (base) => {
      expect(proof(`module.exports=${base}.vendored.contexts.RouterContext;`)?.namespace).toBe(
        'RouterContext',
      );
    },
  );

  it.each(['', ',false'])(
    'accepts one exact static external thunk with interop spelling %s',
    (flag) => {
      const call = `ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)})${flag})`;

      expect(proof(`module.exports=${call}.vendored.contexts.RouterContext;`)?.specifier).toBe(
        SPECIFIER,
      );
    },
  );

  it('permits exact local parameter renaming and the genuine strict directive', () => {
    const body = '"use strict";mod.exports=runtime.r(2).vendored.contexts.RouterContext;';

    expect(proof(body, 'runtime,mod,exp')?.namespace).toBe('RouterContext');
  });

  it.each([
    ['pages.runtime.prod.js', '28f90af862ee5ae750fddea94d36a55cda89e4636993569d0e60c36f2813dc98'],
    [
      'pages-turbo.runtime.prod.js',
      '6a6fb036d30a72fcd4cb10b4ffc13318f5b0df6a205fd3fa1ce97cda1717d9c1',
    ],
  ])('binds the actual reviewed direct Pages runtime %s', (name, sha256) => {
    const own = input(project('module.exports=ctx.r(2).vendored.contexts.RouterContext;'));
    const file = `/project/node_modules/next/dist/compiled/next-server/${name}`;

    expect(
      certifyNodeManifestPagesContext({ ...own, producer: { ...own.producer, file, sha256 } }),
    ).toMatchObject({
      namespace: 'RouterContext',
      file,
      sha256,
      root: '/project/node_modules/next',
    });
  });

  it.each([
    'module.exports=ctx.r(2).PagesRouteModule;',
    'module.exports=ctx.r(2).vendored;',
    'module.exports=ctx.r(2).vendored.contexts;',
    'module.exports=ctx.r(2).vendored.contexts.handler;',
    'module.exports=ctx.r(2).vendored.contexts.RouterContext.Provider;',
    'module.exports=ctx.r(2).vendored[key].RouterContext;',
    'module.exports=ctx.r(2).vendored[`contexts`].RouterContext;',
    'module.exports=ctx.r(2)["vendored"].contexts.RouterContext;',
    'module.exports=ctx.r(2).vendored.contexts["RouterContext"];',
    'module.exports=ctx.r(2).vendored.contexts.RouterContext();',
    'module.exports=ctx.r(2).vendored?.contexts.RouterContext;',
    'module.exports=ctx.r(2).vendored.contexts?.RouterContext;',
    'sideEffect();module.exports=ctx.r(2).vendored.contexts.RouterContext;',
    'const ns=ctx.r(2);module.exports=ns.vendored.contexts.RouterContext;',
    'exports.value=ctx.r(2).vendored.contexts.RouterContext;',
    'module.exports={get value(){return ctx.r(2).vendored.contexts.RouterContext;}};',
    'module.exports=(ctx.r(3),ctx.r(2).vendored.contexts.RouterContext);',
  ])('refuses any broader expression or authority: %s', (body) => {
    expect(refused(body)).toBe(true);
  });

  it.each(['ctx,module', 'ctx,module,exports,extra', 'ctx,module,module'])(
    'requires three distinct actual CJS parameters: %s',
    (params) => {
      expect(refused('module.exports=ctx.r(2).vendored.contexts.RouterContext;', params)).toBe(
        true,
      );
    },
  );

  it('does not accept interop true or a mismatched external thunk', () => {
    const yes = `ctx.x(${jsLiteral(SPECIFIER)},()=>require(${jsLiteral(SPECIFIER)}),true)`;
    const mismatch = `ctx.x(${jsLiteral(SPECIFIER)},()=>require('other'))`;

    expect(refused(`module.exports=${yes}.vendored.contexts.RouterContext;`)).toBe(true);
    expect(refused(`module.exports=${mismatch}.vendored.contexts.RouterContext;`)).toBe(true);
  });

  it.each([
    {
      file: FILE.replace('pages/', 'pages-api/'),
      sha256: '0203c76f81559286e5c80c7ef070fe7ceb325a0a7f13528e44e6b6acec208d36',
    },
    { file: FILE.replace('pages/', 'pages-api/'), sha256: PAGE_SHA },
    { file: FILE, sha256: '0'.repeat(64) },
  ])('requires the actual reviewed Pages producer: %j', (producer) => {
    const own = input(project('module.exports=ctx.r(2).vendored.contexts.RouterContext;'));

    expect(
      certifyNodeManifestPagesContext({ ...own, producer: { ...own.producer, ...producer } }),
    ).toBeUndefined();
  });

  it('binds the real import specifier rather than a same-looking producer descriptor', () => {
    const own = input(project('module.exports=ctx.r(2).vendored.contexts.RouterContext;'));

    expect(
      certifyNodeManifestPagesContext({
        ...own,
        producer: { ...own.producer, specifier: 'turbopack:3' },
      }),
    ).toBeUndefined();
  });

  it('rejects a forged projection view or selected module metadata', () => {
    const own = input(project('module.exports=ctx.r(2).vendored.contexts.RouterContext;'));
    const code = `${own.projection.source.code}\nsideEffect();`;

    expect(
      certifyNodeManifestPagesContext({
        ...own,
        projection: {
          ...own.projection,
          source: { code, sha256: createHash('sha256').update(code).digest('hex') },
        },
      }),
    ).toBeUndefined();
    expect(
      certifyNodeManifestPagesContext({
        ...own,
        projection: { ...own.projection, exports: { kind: 'opaque' } },
      }),
    ).toBeUndefined();
  });

  it.each(METADATA_CHANGES)(
    'requires the complete fresh strict projection: $name',
    ({ change }) => {
      const projection = project('module.exports=ctx.r(2).vendored.contexts.RouterContext;');
      const changed = input(change(projection));

      expect(certifyNodeManifestPagesContext(changed)).toBeUndefined();
    },
  );

  it.each(METADATA_CHANGES)(
    'invalidates the token after same-object metadata changes: $name',
    ({ change }) => {
      const projection = { ...project('module.exports=ctx.r(2).vendored.contexts.RouterContext;') };
      const own = input(projection);
      const certificate = requiredProof(own);
      Object.assign(projection, change(projection));

      expect(isCertifiedNodeManifestPagesContext(certificate, own)).toBe(false);
    },
  );

  it('rejects copied certificates and a fresh same-source projection object', () => {
    const own = input(project('module.exports=ctx.r(2).vendored.contexts.RouterContext;'));
    const certificate = requiredProof(own);

    expect(isCertifiedNodeManifestPagesContext({ ...certificate }, own)).toBe(false);
    expect(
      isCertifiedNodeManifestPagesContext(certificate, {
        ...own,
        projection: project('module.exports=ctx.r(2).vendored.contexts.RouterContext;'),
      }),
    ).toBe(false);
    expect(isCertifiedNodeManifestPagesContext({} as NodeManifestPagesContextProof, own)).toBe(
      false,
    );
  });

  it('keeps fixed namespace authority when a structurally valid producer carries extra fields', () => {
    const own = input(project('module.exports=ctx.r(2).vendored.contexts.RouterContext;'));
    const producer = {
      ...own.producer,
      kind: 'route-class',
      namespace: 'PagesRouteModule',
      root: '/foreign',
    };
    const current = { ...own, producer };
    const certificate = requiredProof(current);

    expect(certificate).toStrictEqual({
      kind: 'pages-context-namespace',
      namespace: 'RouterContext',
      specifier: own.producer.specifier,
      file: FILE,
      sha256: PAGE_SHA,
      root: '/project/node_modules/next',
    });
    expect(isCertifiedNodeManifestPagesContext(certificate, current)).toBe(true);
  });

  it('rejects changed producer fields and changed metadata after certification', () => {
    const projection = project('module.exports=ctx.r(2).vendored.contexts.RouterContext;');
    const current = { ...projection, source: { ...projection.source } };
    const own = input(current);
    const certificate = requiredProof(own);
    const changed = {
      ...own,
      producer: { ...own.producer, file: FILE.replace('/project/', '/other/') },
    };

    expect(isCertifiedNodeManifestPagesContext(certificate, changed)).toBe(false);

    current.source.code += '\n';

    expect(isCertifiedNodeManifestPagesContext(certificate, own)).toBe(false);
  });
});
