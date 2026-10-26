import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assertNodeManifestTurbopackTemplateConsumer,
  type NodeManifestTurbopackTemplateInput,
} from '../src/node-manifest-turbopack-templates.ts';
import {
  changeOriginalTemplateFixture,
  manifestTemplateSource,
  projectedTemplateFixture,
  reprojectTemplateFixture,
} from './fixtures/node-manifest-turbopack-template.ts';

async function runtimeConstructor(
  own: NodeManifestTurbopackTemplateInput,
  runtime: string,
): Promise<NodeManifestTurbopackTemplateInput> {
  const original = own.imports.find(
    (entry) => 'file' in entry && entry.file.endsWith('/module.compiled.js'),
  );
  if (original === undefined) throw new Error('Expected published constructor dependency');
  const file = await realpath(
    fileURLToPath(import.meta.resolve(`next/dist/compiled/next-server/${runtime}`)),
  );
  const sha256 = manifestTemplateSource(await readFile(file, 'utf8')).sha256;
  const specifier = 'sealed:runtime-constructor';
  const imports = own.imports.map((entry) =>
    entry === original ? { specifier, file, sha256 } : entry,
  );
  const code = own.projection.original.code.replaceAll(original.specifier, () => specifier);
  return { ...reprojectTemplateFixture(own, code), imports };
}

describe('projected fixed Next Pages and AppRoute template bodies', () => {
  it('rechecks the selected runtime ID rather than the first ID of a merged registration', async () => {
    const own = await projectedTemplateFixture('pages-api');
    const changed = reprojectTemplateFixture(
      own,
      own.projection.original.code.replace('module.exports=[1,', 'module.exports=["opposite",1,'),
    );

    expect(changed.projection.moduleId).toBe(1);
    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).resolves.toMatchObject({
      kind: 'pages-api',
      requiresRuntimeNormalization: true,
    });
  });

  it.each(['pages', 'app-route'] as const)(
    'certifies the actual published %s body after real context import/export projection',
    async (kind) => {
      const own = await projectedTemplateFixture(kind);
      const proof = await assertNodeManifestTurbopackTemplateConsumer(own);

      expect([proof.kind, proof.page, proof.pathname]).toStrictEqual([
        kind,
        own.route.page,
        own.route.pathname,
      ]);
      expect(proof.exports).toContain('routeModule');
      expect(proof.exports).toContain('handler');
      expect(proof.requiresRuntimeNormalization).toBe(true);
    },
  );

  it('tracks renamed import namespaces and handler parameters through their actual lexical bindings', async () => {
    const own = await projectedTemplateFixture('pages');
    const code = own.projection.original.code
      .replaceAll('_modulecompiled', 'constructorAlias')
      .replaceAll('_VAR_USERLAND', 'customerNamespace')
      .replaceAll(/\bctx\b/gu, 'requestContext');
    const renamed = reprojectTemplateFixture(own, code);

    await expect(assertNodeManifestTurbopackTemplateConsumer(renamed)).resolves.toMatchObject({
      kind: 'pages',
      pathname: '/blog/[slug]',
      requiresRuntimeNormalization: true,
    });
  });

  it.each([
    ['page', "page: '/blog/[slug]'", "page: '/other'"],
    [
      'constructor reassignment',
      'const routeModule =',
      '_modulecompiled = userInput;\nconst routeModule =',
    ],
    [
      'manifest caller',
      'const handler =',
      "routeModule.loadManifests('/unowned', '/elsewhere');\nconst handler =",
    ],
    ['changed handler field', 'srcPage:', 'otherPage:'],
  ])(
    'refuses a %s change instead of alpha-normalizing business code',
    async (_name, before, after) => {
      const own = await projectedTemplateFixture('pages');
      const changed = changeOriginalTemplateFixture(own, before, after);

      await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
        'Unproved Next.js',
      );
    },
  );

  it('rejects extra protected selectors and a factory that leaks a bound runtime loader', async () => {
    const own = await projectedTemplateFixture('pages');
    const escaped = reprojectTemplateFixture(
      own,
      own.projection.original.code.replace(
        'runtimeContext.s([',
        'runtimeContext.s(["constructor",()=>_modulecompiled.PagesRouteModule,',
      ),
    );
    const bound = reprojectTemplateFixture(
      own,
      own.projection.original.code.replace(
        'const routeModule =',
        'const escaped = {require:runtimeContext.r.bind(runtimeContext)};\nconst routeModule =',
      ),
    );

    await expect(assertNodeManifestTurbopackTemplateConsumer(escaped)).rejects.toThrow(
      'changed protected export selector',
    );
    await expect(assertNodeManifestTurbopackTemplateConsumer(bound)).rejects.toThrow(
      'unmodeled bound runtime input',
    );
  });

  it('does not accept an inert projection edited after the original factory was verified', async () => {
    const own = await projectedTemplateFixture('pages');
    const changed = {
      ...own,
      projection: {
        ...own.projection,
        source: manifestTemplateSource(`${own.projection.source.code}\nexports.extra=routeModule;`),
      },
    };

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'projection provenance',
    );
  });

  it('requires strictness from the real factory ancestry rather than assuming the template label proves it', async () => {
    const own = await projectedTemplateFixture('pages');
    const changed = reprojectTemplateFixture(
      own,
      own.projection.original.code.replace('"use strict";', ''),
    );

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'unproved factory strictness',
    );
  });

  it('certifies a projected PagesAPI handler without inventing a public routeModule export', async () => {
    const own = await projectedTemplateFixture('pages-api');
    const proof = await assertNodeManifestTurbopackTemplateConsumer(own);

    expect(proof.exports).toStrictEqual(['config', 'default', 'handler']);
    expect(proof.requiresRuntimeNormalization).toBe(true);
    expect([proof.kind, proof.page, proof.pathname]).toStrictEqual([
      'pages-api',
      '/api/native',
      '/api/native',
    ]);
  });

  it.each([
    ['route kind', 'RouteKind.PAGES_API', 'RouteKind.PAGES'],
    ['metadata propagation', 'ctx.requestMeta', 'undefined'],
  ])('refuses changed PagesAPI %s in the original factory body', async (_name, before, after) => {
    const own = await projectedTemplateFixture('pages-api');
    const changed = changeOriginalTemplateFixture(own, before, after);

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'changed handler or constructor body',
    );
  });

  it('rejects the private PagesAPI instance as an extra export even though other selectors are fixed', async () => {
    const own = await projectedTemplateFixture('pages-api');
    const changed = changeOriginalTemplateFixture(
      own,
      'runtimeContext.s([',
      'runtimeContext.s(["routeModule",()=>routeModule,',
    );

    await expect(assertNodeManifestTurbopackTemplateConsumer(changed)).rejects.toThrow(
      'changed protected export selector',
    );
  });

  it.each([
    ['pages', 'pages.runtime.prod.js'],
    ['pages', 'pages-turbo.runtime.prod.js'],
    ['pages-api', 'pages-api.runtime.prod.js'],
    ['pages-api', 'pages-api-turbo.runtime.prod.js'],
    ['app-route', 'app-route.runtime.prod.js'],
    ['app-route', 'app-route-turbo.runtime.prod.js'],
    ['app-route', 'app-route-experimental.runtime.prod.js'],
    ['app-route', 'app-route-turbo-experimental.runtime.prod.js'],
  ] as const)('accepts the projected %s class namespace from %s', async (kind, runtime) => {
    const own = await runtimeConstructor(await projectedTemplateFixture(kind), runtime);

    await expect(assertNodeManifestTurbopackTemplateConsumer(own)).resolves.toMatchObject({
      kind,
      pathname: own.route.pathname,
      requiresRuntimeNormalization: true,
    });
  });

  it.each(['hash', 'profile', 'source-path', 'reflection'] as const)(
    'refuses a projected runtime constructor with an unproved %s',
    async (scenario) => {
      const runtime =
        scenario === 'profile' ? 'pages-api.runtime.prod.js' : 'pages.runtime.prod.js';
      const own = await runtimeConstructor(await projectedTemplateFixture('pages'), runtime);
      const imports = own.imports.map((entry) => {
        if (entry.specifier !== 'sealed:runtime-constructor') return entry;
        if (scenario === 'hash')
          return { ...entry, sha256: manifestTemplateSource('changed').sha256 };
        if (scenario === 'source-path') return { ...entry, file: '/unreviewed/runtime.js' };
        return entry;
      });
      const changed =
        scenario === 'reflection'
          ? reprojectTemplateFixture(
              own,
              own.projection.original.code.replace(
                '_modulecompiled.PagesRouteModule',
                "_modulecompiled['PagesRouteModule']",
              ),
            )
          : own;

      await expect(
        assertNodeManifestTurbopackTemplateConsumer({ ...changed, imports }),
      ).rejects.toThrow('Unproved Next.js Turbopack route template');
    },
  );

  it('keeps the projected PagesAPI request metadata pin after a direct constructor alias is proved', async () => {
    const own = await runtimeConstructor(
      await projectedTemplateFixture('pages-api'),
      'pages-api.runtime.prod.js',
    );
    const imports = own.imports.map((entry) => {
      return entry.specifier.endsWith('/request-meta')
        ? { ...entry, sha256: manifestTemplateSource('changed metadata').sha256 }
        : entry;
    });

    await expect(assertNodeManifestTurbopackTemplateConsumer({ ...own, imports })).rejects.toThrow(
      'changed protected import',
    );
  });
});
